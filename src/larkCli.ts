/**
 * lark-cli 进程封装：
 * - spawn（argv 数组、不经 shell），长内容经 stdin 传递
 * - 超时 kill，stdout JSON envelope 解析，错误归一化（附修复指引）
 * - base 批量写入的 --json 不支持 stdin，提供 @file 临时文件辅助
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";

export interface LarkCliEnvelope {
  ok: boolean;
  identity?: string;
  data?: unknown;
  error?: { type?: string; subtype?: string; message?: string; hint?: string };
  [key: string]: unknown;
}

export interface RunOptions {
  /** 经 stdin 传给 lark-cli 的内容（配合 --flag -） */
  stdin?: string;
  /** 输出不是统一 envelope（如 auth status 为裸 JSON）时，直接返回原始 stdout */
  rawOutput?: boolean;
  /** 覆盖默认超时（毫秒） */
  timeoutMs?: number;
  /** 不注入 --as（--version、auth status 等无该 flag 的命令） */
  noIdentity?: boolean;
}

/** lark-cli 调用失败，message 已归一化并附带修复指引 */
export class LarkCliError extends Error {
  readonly envelope?: LarkCliEnvelope;
  constructor(message: string, envelope?: LarkCliEnvelope) {
    super(message);
    this.name = "LarkCliError";
    this.envelope = envelope;
  }
}

/**
 * 组装完整 argv：--profile 是全局 flag 置于最前；--as 是子命令级 flag 追加在末尾。
 * （实测 cobra 对两种位置的解析不同：--as 全局前置会报 unknown flag）
 */
function buildFullArgs(args: string[], noIdentity?: boolean): string[] {
  const config = loadConfig();
  const global = config.larkProfile ? ["--profile", config.larkProfile] : [];
  if (noIdentity || !config.larkIdentity) return [...global, ...args];
  return [...global, ...args, "--as", config.larkIdentity];
}

function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…(截断)` : text;
}

function friendlyError(env: LarkCliEnvelope): string {
  const err = env.error ?? {};
  const base = err.message ?? "lark-cli 调用失败";
  const type = `${err.type ?? ""}${err.subtype ? `/${err.subtype}` : ""}`;
  const suffix = type ? `[${type}] ` : "";
  // 未登录/凭证过期时提示需重新授权（具体修复指引由上层附加授权链接）
  const authHint =
    /unauthorized|token|authentication|not.?logged|login|credential|permission|forbidden|scope/i.test(
      `${type} ${base}`,
    )
      ? "\n（飞书用户授权可能已失效，需要重新授权。）"
      : "";
  return `${suffix}${base}${authHint}`;
}

/**
 * 解析 lark-cli 实际可执行文件路径。
 * Windows 下 npm 全局安装的 lark-cli 是 sh/cmd shim 脚本，spawn 不经 shell 无法执行，
 * 需在同目录寻找 .exe/.cmd；无扩展名命令名时按 PATH 逐目录解析。
 */
function resolveExecutable(configured: string): string {
  const hasExt = /\.[A-Za-z]+$/.test(configured);
  if (process.platform !== "win32" || hasExt || configured.includes("/") || configured.includes("\\")) {
    return configured;
  }
  const dirs = process.env.PATH?.split(";").filter(Boolean) ?? [];
  for (const dir of dirs) {
    for (const candidate of [`${configured}.exe`, `${configured}.cmd`, configured]) {
      try {
        const full = path.join(dir, candidate);
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // 该目录无此候选，继续
      }
    }
  }
  return configured;
}

let resolvedPath: string | undefined;

function getExecutablePath(): string {
  if (!resolvedPath) {
    resolvedPath = resolveExecutable(loadConfig().larkCliPath);
  }
  return resolvedPath;
}

/** .cmd/.bat 必须经 shell 执行；.exe 直接 spawn */
function needsShell(execPath: string): boolean {
  return process.platform === "win32" && /\.cmd$|\.bat$/i.test(execPath);
}

/** Windows shell 模式下手动加引号（Node 的 shell:true 不会转义参数） */
function quoteWindowsArg(arg: string): string {
  if (arg === "" || /[\s"]/.test(arg)) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return arg;
}

/**
 * 执行 lark-cli 子命令。
 * @param args 子命令及参数（不含全局 --profile/--as，会自动按配置注入并置于最前）
 */
export function runLarkCli(args: string[], options: RunOptions = {}): Promise<unknown> {
  const config = loadConfig();
  const execPath = getExecutablePath();
  const argv = buildFullArgs(args, options.noIdentity);
  const timeoutMs = options.timeoutMs ?? config.larkTimeoutMs;
  const shell = needsShell(execPath);

  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      shell ? [execPath, ...argv].map(quoteWindowsArg).join(" ") : execPath,
      shell ? [] : argv,
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell,
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(
        new LarkCliError(
          `lark-cli 调用超时（${timeoutMs}ms）：${argv.join(" ")}。可在配置中调大 LARK_TIMEOUT_MS。`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new LarkCliError(
            `找不到 lark-cli 可执行文件（LARK_CLI_PATH=${config.larkCliPath}）。` +
              "请先安装：`npx @larksuite/cli@latest install`，或把 LARK_CLI_PATH 指向 lark-cli 的完整路径。",
          ),
        );
      } else {
        reject(new LarkCliError(`lark-cli 进程启动失败: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (options.rawOutput) {
        resolve(stdout);
        return;
      }

      const parsed = tryParseEnvelope(stdout) ?? tryParseEnvelope(stderr);
      if (parsed) {
        if (parsed.ok) {
          resolve(parsed);
        } else {
          reject(new LarkCliError(friendlyError(parsed), parsed));
        }
        return;
      }

      // 输出不是合法 envelope：非零退出码或输出格式异常
      const detail = stderr.trim() || stdout.trim();
      if (code === 0) {
        // 少数命令 stdout 为纯文本，原样返回
        resolve(stdout);
      } else {
        reject(
          new LarkCliError(
            `lark-cli 退出码 ${code}：${truncate(detail || "(无输出)")}` +
              (/auth|login|token/i.test(detail)
                ? "\n提示：可能未登录，运行 `lark-cli auth status` 检查。"
                : ""),
          ),
        );
      }
    });

    if (options.stdin !== undefined) {
      child.stdin.on("error", () => {
        /* EPIPE 等写错误由 close 分支统一处理 */
      });
      child.stdin.end(options.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

/** 解析统一 envelope；stdout 可能混入少量非 JSON 日志，从第一个 { 起尝试 */
function tryParseEnvelope(stdout: string): LarkCliEnvelope | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  try {
    const obj = JSON.parse(text) as LarkCliEnvelope;
    return typeof obj.ok === "boolean" ? obj : null;
  } catch {
    const start = text.indexOf("{");
    if (start > 0) {
      try {
        const obj = JSON.parse(text.slice(start)) as LarkCliEnvelope;
        return typeof obj.ok === "boolean" ? obj : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * base +record-batch-create/update 的 --json 不支持 stdin，只支持内联或 @file，
 * 且 @file 必须是当前目录下的相对路径。故在 CWD 下建临时文件，用完即删。
 */
export async function withTempJsonFile<T>(payload: unknown, fn: (arg: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(process.cwd(), "feishu-mcp-tmp-"));
  const file = path.join(dir, "payload.json");
  try {
    await fs.promises.writeFile(file, JSON.stringify(payload), "utf8");
    const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
    return await fn(`@${relative}`);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 提取 envelope 的 data 字段；data 缺失时抛错 */
export function envelopeData<T>(result: unknown): T {
  const env = result as LarkCliEnvelope;
  if (env && env.ok && env.data !== undefined) return env.data as T;
  throw new LarkCliError("lark-cli 返回缺少 data 字段", env);
}

/** 剥离搜索结果高亮标签 */
export function stripHighlight(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/<\/?h[bp]?>/g, "").trim();
}
