/**
 * 飞书用户授权自愈：当 MCP 调用因授权失效报错时，自动发起设备码授权流程，
 * 把授权链接放进错误信息返回给用户；用户在浏览器确认后，服务后台自动完成轮询登录，
 * 全程无需登录服务器。
 *
 * 设计约束：
 * - 同一时间只允许一个授权流程（single-flight + 9 分钟内复用同一链接）
 * - 后台轮询不阻塞 MCP 调用；轮询成功/失败/超时后清空流程状态
 * - 发起流程本身不影响已有登录态（独立的授权 grant，链接不点就自然过期）
 */
import { loadConfig } from "./config.js";
import { runLarkCli } from "./larkCli.js";

interface DeviceFlow {
  url: string;
  startedAt: number;
  /** 后台轮询 promise（resolve true = 授权成功） */
  poll: Promise<boolean>;
}

let active: DeviceFlow | undefined;
let inflight: Promise<string | undefined> | undefined;

/** 判定错误是否为飞书授权类（token 过期/未登录/权限被撤销） */
export function isAuthError(message: string): boolean {
  return /unauthorized|access.?token|refresh.?token|invalid.?credential|not.?logged|need.{0,6}login|重新授权|登录|授权/i.test(
    message,
  );
}

interface NoWaitOutput {
  device_code?: string;
  verification_url?: string;
  expires_in?: number;
}

async function startFlow(): Promise<string | undefined> {
  // 1. 发起设备码流程（no-wait 立即返回链接）
  const raw = await runLarkCli(["auth", "login", "--domain", "docs,drive,base,sheets", "--no-wait"], {
    rawOutput: true,
    noIdentity: true,
    timeoutMs: 30_000,
  });
  const parsed = JSON.parse(String(raw)) as NoWaitOutput;
  if (!parsed.verification_url || !parsed.device_code) return undefined;

  const flow: DeviceFlow = {
    url: parsed.verification_url,
    startedAt: Date.now(),
    poll: Promise.resolve(false),
  };

  // 2. 后台轮询（用户点击确认后自动完成登录）；完成或过期后清空状态
  flow.poll = runLarkCli(["auth", "login", "--device-code", parsed.device_code], {
    rawOutput: true,
    noIdentity: true,
    timeoutMs: 660_000,
  })
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      if (active === flow) active = undefined;
    });
  active = flow;
  return flow.url;
}

/**
 * 获取（或复用）重新授权链接。任何失败都返回 undefined，调用方降级为文字指引。
 */
export async function getLoginUrl(): Promise<string | undefined> {
  // 已有活跃流程：复用同一链接（链接有效期 10 分钟，留 1 分钟余量）
  if (active && Date.now() - active.startedAt < 9 * 60_000) {
    void active.poll;
    return active.url;
  }
  if (inflight) return inflight;
  inflight = startFlow()
    .catch(() => undefined)
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

/** 供诊断：当前是否已有待确认的授权流程 */
export function hasPendingFlow(): boolean {
  return !!active && Date.now() - active.startedAt < 9 * 60_000;
}

/** 确保 loadConfig 已初始化（避免首次调用时的隐式初始化时序问题） */
export function warmup(): void {
  loadConfig();
}
