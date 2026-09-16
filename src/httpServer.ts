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

function authorize(req: http.IncomingMessage, validTokens: string[]): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return validTokens.includes(match[1].trim());
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
      if (url.pathname !== MCP_PATH) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found，MCP 端点为 /mcp" }));
        return;
      }

      if (!authorize(req, validTokens)) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="feishu-mcp"',
        });
        res.end(JSON.stringify({ error: "未授权：缺少或错误的 Bearer token" }));
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
