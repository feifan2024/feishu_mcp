/**
 * HTTP 传输（云服务器部署）：Streamable HTTP（stateless）+ Bearer 鉴权。
 * 配置了 MCP_HTTP_TLS_CERT/KEY 时直接以 HTTPS 启动，否则纯 HTTP（可由前置反代终止 TLS）。
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parseHttpTokens, type FeishuMcpConfig } from "./config.js";

const MCP_PATH = "/mcp";

function authorize(req: http.IncomingMessage, validTokens: string[], url: URL): boolean {
  // 首选：Authorization: Bearer 头
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match && validTokens.includes(match[1].trim())) return true;
  // 兼容：不支持自定义请求头的客户端（如 ChatGPT 连接器）用 URL 查询参数 ?token=
  const q = url.searchParams.get("token") ?? url.searchParams.get("access_token");
  if (q && validTokens.includes(q.trim())) return true;
  return false;
}

function readBody(req: http.IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startHttpServer(server: McpServer, config: FeishuMcpConfig): Promise<void> {
  const validTokens = parseHttpTokens(config.httpToken ?? "");
  if (validTokens.length === 0) {
    throw new Error("HTTP 模式必须配置 MCP_HTTP_TOKEN");
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const proto = String(req.headers["x-forwarded-proto"] ?? (config.tlsCert ? "https" : "http")).trim();

      // OAuth 保护资源元数据（RFC 9728 / MCP 规范）：声明本服务用静态 Bearer token，
      // 无授权服务器。客户端收到 401 时按此理解，避免误走 OAuth 自动发现报
      // "does not implement OAuth"
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        const host = req.headers.host ?? "localhost";
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(
          JSON.stringify({
            resource: `${proto}://${host}${MCP_PATH}`,
            authorization_servers: [],
            scopes_supported: ["feishu:read", "feishu:write"],
            bearer_methods_supported: ["header"],
            resource_documentation: "Auth via 'Authorization: Bearer <MCP_HTTP_TOKEN>' header, or URL query '?token=<MCP_HTTP_TOKEN>' for clients that cannot set headers (e.g. ChatGPT connectors).",
          }),
        );
        return;
      }

      if (url.pathname !== MCP_PATH) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found，MCP 端点为 /mcp" }));
        return;
      }

      if (!authorize(req, validTokens, url)) {
        const host = req.headers.host ?? "localhost";
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer realm="feishu-mcp", resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`,
        });
        res.end(JSON.stringify({ error: "未授权：请在 MCP 客户端配置 Authorization: Bearer <token> 请求头" }));
        return;
      }

      if (req.method !== "POST") {
        // stateless 模式下 GET（SSE 流）与 DELETE（会话终止）没有意义
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
        res.end(JSON.stringify({ error: "仅支持 POST" }));
        return;
      }

      const raw = await readBody(req);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "请求体不是合法 JSON" }));
        return;
      }
      // stateless：每个请求一个独立 transport 实例，不维护会话状态
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => transport.close().catch(() => {}));
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody as Parameters<typeof transport.handleRequest>[2]);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    }
  };

  const useTls = !!(config.tlsCert && config.tlsKey);
  const requestHandler = useTls
    ? https.createServer(
        { cert: fs.readFileSync(config.tlsCert!), key: fs.readFileSync(config.tlsKey!) },
        handler,
      )
    : http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    requestHandler.once("error", reject);
    requestHandler.listen(config.httpPort, config.httpHost, () => resolve());
  });

  const scheme = useTls ? "https" : "http";
  console.error(
    `[feishu-mcp] ${scheme.toUpperCase()} 服务已启动: ${scheme}://${config.httpHost}:${config.httpPort}${MCP_PATH}（Bearer 鉴权，9 个工具已注册）`,
  );
}
