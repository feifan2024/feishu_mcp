/**
 * token/URL 解析：
 * - docs 工具直接透传 URL（CLI 原生支持 docx/wiki 路由）
 * - base/sheet 资源常挂在知识库（wiki）下：URL 是 /wiki/<node_token>，
 *   需经 wiki +node-get 解析出真实 obj_token 后再调用 base/sheets 命令
 * 解析结果按输入缓存（单用户服务，量级有限），失败不缓存以便重试。
 */
import { envelopeData, runLarkCli } from "../larkCli.js";

export type UrlKind = "docx" | "wiki" | "base" | "sheets" | "unknown";

export function extractToken(input: string): { token: string; kind: UrlKind } {
  const value = input.trim();
  const urlMatch = /\/(docx|wiki|base|sheets)\/([A-Za-z0-9]+)/.exec(value);
  if (urlMatch) {
    return { kind: urlMatch[1] as UrlKind, token: urlMatch[2] };
  }
  return { kind: "unknown", token: value };
}

interface WikiNode {
  obj_token?: string;
  obj_type?: string;
  title?: string;
}

async function getWikiNode(token: string): Promise<WikiNode | undefined> {
  try {
    return envelopeData<WikiNode>(await runLarkCli(["wiki", "+node-get", "--node-token", token]));
  } catch {
    return undefined;
  }
}

const cache = new Map<string, Promise<string>>();

function cached(key: string, resolve: () => Promise<string>): Promise<string> {
  let p = cache.get(key);
  if (!p) {
    p = resolve().catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, p);
  }
  return p;
}

/** 解析 base_token（/base/ URL、/wiki/ URL、wiki 节点 token、裸 base token） */
export function resolveBaseToken(input: string): Promise<string> {
  return cached(`base:${input}`, async () => {
    const { kind, token } = extractToken(input);
    if (kind === "base") return token;
    if (kind === "wiki") {
      const node = await getWikiNode(token);
      if (!node?.obj_token) throw new Error(`无法从 wiki 节点 ${token} 解析出多维表格 token`);
      return node.obj_token;
    }
    // 裸 token：无法静态区分 base token 与 wiki 节点 token，用最小调用探测
    try {
      await envelopeData<unknown>(await runLarkCli(["base", "+table-list", "--base-token", token, "--limit", "1"]));
      return token;
    } catch {
      const node = await getWikiNode(token);
      if (node?.obj_token) return node.obj_token;
      throw new Error(`${token} 不是有效的多维表格 token，也无法按 wiki 节点解析`);
    }
  });
}

/** 解析 spreadsheet token（/sheets/ URL、/wiki/ URL、裸 token） */
export function resolveSpreadsheetToken(input: string): Promise<string> {
  return cached(`sheet:${input}`, async () => {
    const { kind, token } = extractToken(input);
    if (kind === "sheets") return token;
    if (kind === "wiki") {
      const node = await getWikiNode(token);
      if (!node?.obj_token) throw new Error(`无法从 wiki 节点 ${token} 解析出电子表格 token`);
      return node.obj_token;
    }
    try {
      await envelopeData<unknown>(await runLarkCli(["sheets", "+workbook-info", "--spreadsheet-token", token]));
      return token;
    } catch {
      const node = await getWikiNode(token);
      if (node?.obj_token) return node.obj_token;
      throw new Error(`${token} 不是有效的电子表格 token，也无法按 wiki 节点解析`);
    }
  });
}
