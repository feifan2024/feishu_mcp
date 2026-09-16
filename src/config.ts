/**
 * 配置加载：环境变量优先，其次 JSON 配置文件（FEISHU_MCP_CONFIG 指定路径，
 * 默认 ~/.feishu-mcp/config.json）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FeishuMcpConfig {
  /** lark-cli 可执行文件路径或命令名 */
  larkCliPath: string;
  /** 多 profile 时的 profile 名，注入 --profile */
  larkProfile?: string;
  /** 调用身份：user（用户身份）或 bot（应用身份） */
  larkIdentity: "user" | "bot";
  /** 单次 lark-cli 调用超时（毫秒） */
  larkTimeoutMs: number;
  /** 传输方式：stdio（本地）或 http（云服务器） */
  transport: "stdio" | "http";
  /** HTTP 监听地址 */
  httpHost: string;
  /** HTTP 监听端口 */
  httpPort: number;
  /** Bearer token（逗号分隔多个），HTTP 模式必填 */
  httpToken?: string;
  /** TLS 证书路径，与 tlsKey 同时配置时以 HTTPS 启动 */
  tlsCert?: string;
  /** TLS 私钥路径 */
  tlsKey?: string;
}

type FileConfig = Partial<{
  larkCliPath: string;
  larkProfile: string;
  larkIdentity: string;
  larkTimeoutMs: number | string;
  transport: string;
  httpHost: string;
  httpPort: number | string;
  httpToken: string;
  tlsCert: string;
  tlsKey: string;
}>;

function loadFileConfig(): FileConfig {
  const explicit = process.env.FEISHU_MCP_CONFIG;
  const candidates = explicit
    ? [explicit]
    : [path.join(os.homedir(), ".feishu-mcp", "config.json")];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf8")) as FileConfig;
      }
    } catch (err) {
      // 配置文件损坏不应让服务直接不可用，提示后继续
      console.error(`[feishu-mcp] 配置文件解析失败: ${file}: ${(err as Error).message}`);
    }
  }
  return {};
}

function pick(envKey: string, fileValue: unknown): string | undefined {
  const env = process.env[envKey];
  if (env !== undefined && env !== "") return env;
  if (fileValue !== undefined && fileValue !== "") return String(fileValue);
  return undefined;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

let cached: FeishuMcpConfig | undefined;

export function loadConfig(): FeishuMcpConfig {
  if (cached) return cached;
  const file = loadFileConfig();

  const larkIdentityRaw = pick("LARK_IDENTITY", file.larkIdentity) ?? "user";
  const transportRaw = pick("MCP_TRANSPORT", file.transport) ?? "stdio";

  const config: FeishuMcpConfig = {
    larkCliPath: pick("LARK_CLI_PATH", file.larkCliPath) ?? "lark-cli",
    larkProfile: pick("LARK_PROFILE", file.larkProfile),
    larkIdentity: larkIdentityRaw === "bot" ? "bot" : "user",
    larkTimeoutMs: toInt(pick("LARK_TIMEOUT_MS", file.larkTimeoutMs), 120_000),
    transport: transportRaw === "http" ? "http" : "stdio",
    httpHost: pick("MCP_HTTP_HOST", file.httpHost) ?? "127.0.0.1",
    httpPort: toInt(pick("MCP_HTTP_PORT", file.httpPort), 3000),
    httpToken: pick("MCP_HTTP_TOKEN", file.httpToken),
    tlsCert: pick("MCP_HTTP_TLS_CERT", file.tlsCert),
    tlsKey: pick("MCP_HTTP_TLS_KEY", file.tlsKey),
  };

  if (config.transport === "http" && !config.httpToken) {
    throw new Error(
      "HTTP 模式必须配置 MCP_HTTP_TOKEN（Bearer 鉴权 token，公网暴露的服务不能无鉴权运行）",
    );
  }
  if (!!config.tlsCert !== !!config.tlsKey) {
    throw new Error("MCP_HTTP_TLS_CERT 与 MCP_HTTP_TLS_KEY 必须同时配置");
  }

  cached = config;
  return config;
}

/** 解析逗号分隔的 token 列表 */
export function parseHttpTokens(token: string): string[] {
  return token
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
