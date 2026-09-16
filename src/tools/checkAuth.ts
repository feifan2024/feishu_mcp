/**
 * check_feishu_auth：检查 lark-cli 安装与登录状态。
 * 让 AI 能自助排障：未安装给安装指引，未登录给登录指引。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getLoginUrl } from "../authFlow.js";
import { runLarkCli } from "../larkCli.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

interface AuthStatus {
  appId?: string;
  brand?: string;
  identity?: string;
  defaultAs?: string;
  identities?: Record<
    string,
    { status?: string; available?: boolean; message?: string; openId?: string; userName?: string; expiresAt?: string; scope?: string } | undefined
  >;
  note?: string;
  [key: string]: unknown;
}

export const checkAuthTool: ToolDef = {
  name: "check_feishu_auth",
  title: "检查飞书登录状态",
  description:
    "检查 lark-cli 是否已安装、当前登录状态与可用身份（user/bot）。读写报权限错误时先调用本工具排查。未登录时按返回的指引让用户在部署机上执行登录命令。",
  inputSchema: {},
  handler: async () => {
    // --version 是纯文本输出，走 rawOutput
    let version = "";
    try {
      version = String(await runLarkCli(["--version"], { rawOutput: true, timeoutMs: 15_000, noIdentity: true })).trim();
    } catch (err) {
      return jsonResult({
        installed: false,
        message: (err as Error).message,
        fix: "安装 lark-cli：`npx @larksuite/cli@latest install`，或设置 LARK_CLI_PATH 指向可执行文件。",
      });
    }

    let status: AuthStatus | undefined;
    let statusRaw = "";
    let statusError = "";
    try {
      // auth status 输出裸 JSON（无 ok envelope），解析失败则原样返回
      statusRaw = String(await runLarkCli(["auth", "status"], { rawOutput: true, timeoutMs: 30_000, noIdentity: true }));
      status = JSON.parse(statusRaw) as AuthStatus;
    } catch (err) {
      statusError = (err as Error).message;
    }

    if (!status) {
      const url = await getLoginUrl().catch(() => undefined);
      return jsonResult({
        installed: true,
        version,
        logged_in: false,
        status_error: statusError,
        raw: statusRaw || undefined,
        login_url: url,
        fix: url
          ? "用户授权缺失或失效。用浏览器打开 login_url 完成授权（10 分钟内有效），无需登录服务器。"
          : "用户授权缺失或失效，自动生成授权链接失败。请在服务器上执行：lark-cli config init && lark-cli auth login --domain docs,drive,base,sheets。",
      });
    }

    const user = status.identities?.user;
    const bot = status.identities?.bot;
    const userNeedsLogin = !user || (user.status !== "ready" && user.status !== "needs_refresh");
    const loginUrl = userNeedsLogin ? await getLoginUrl().catch(() => undefined) : undefined;
    return jsonResult({
      installed: true,
      version,
      app_id: status.appId,
      brand: status.brand,
      default_identity: status.defaultAs,
      user_identity: user
        ? {
            status: user.status,
            available: user.available,
            user_name: user.userName,
            open_id: user.openId,
            token_expires_at: user.expiresAt,
          }
        : undefined,
      bot_identity: bot ? { status: bot.status, available: bot.available } : undefined,
      note: status.note,
      login_url: loginUrl,
      fix_hint: userNeedsLogin
        ? loginUrl
          ? "用户授权缺失或已失效。用浏览器打开 login_url 完成授权（10 分钟内有效），无需登录服务器。"
          : "用户授权缺失或已失效，自动生成授权链接失败。请在服务器上执行：lark-cli auth login --domain docs,drive,base,sheets。"
        : undefined,
    });
  },
};
