/**
 * search_feishu_docs：搜索我有权限的云空间对象（文档/表格/多维表格/知识库等）。
 * 返回标题、类型、URL、时间，支持类型过滤与分页。
 */
import { runLarkCli, envelopeData, stripHighlight } from "../larkCli.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

interface SearchPayload {
  has_more?: boolean;
  page_token?: string;
  results?: Array<{
    result_meta?: {
      url?: string;
      doc_types?: string;
      owner_name?: string;
      update_time_iso?: string;
      create_time_iso?: string;
      token?: string;
      [key: string]: unknown;
    };
    title_highlighted?: string;
    summary_highlighted?: string;
  }>;
  [key: string]: unknown;
}

export const searchDocsTool: ToolDef = {
  name: "search_feishu_docs",
  title: "搜索飞书云文档",
  description:
    "按关键词搜索我有权限的飞书云空间对象（文档/电子表格/多维表格/知识库文档等），返回标题、类型、URL、更新时间。关键词最长 30 个字符。拿到 URL/token 后可用 read_feishu_doc 等工具进一步读写。",
  inputSchema: {
    query: z
      .string()
      .max(30)
      .describe("搜索关键词（≤30 字符），支持高级语法：intitle:标题 '精确短语' A OR B -排除词"),
    doc_types: z
      .array(z.enum(["doc", "sheet", "bitable", "mindnote", "file", "wiki", "docx", "folder", "slides", "shortcut"]))
      .optional()
      .describe("按类型过滤（可多选）"),
    mine: z.boolean().optional().describe("只搜我担任所有者的对象"),
    created_by_me: z.boolean().optional().describe("只搜我创建的对象"),
    only_title: z.boolean().optional().describe("只在标题中匹配"),
    page_size: z.number().int().min(1).max(20).default(15).describe("每页条数（1-20）"),
    page_token: z.string().optional().describe("上一页返回的翻页 token"),
    sort: z.enum(["default", "edit_time", "edit_time_asc", "open_time", "create_time"]).optional().describe("排序"),
  },
  handler: async (args) => {
    const cliArgs = ["drive", "+search", "--query", String(args.query), "--page-size", String(args.page_size ?? 15)];
    const docTypes = args.doc_types as string[] | undefined;
    if (docTypes && docTypes.length > 0) cliArgs.push("--doc-types", docTypes.join(","));
    if (args.mine === true) cliArgs.push("--mine");
    if (args.created_by_me === true) cliArgs.push("--created-by-me");
    if (args.only_title === true) cliArgs.push("--only-title");
    if (args.page_token) cliArgs.push("--page-token", String(args.page_token));
    if (args.sort) cliArgs.push("--sort", String(args.sort));

    const data = envelopeData<SearchPayload>(await runLarkCli(cliArgs));
    return jsonResult({
      has_more: data.has_more,
      page_token: data.page_token,
      results: (data.results ?? []).map((r) => ({
        title: stripHighlight(r.title_highlighted),
        type: r.result_meta?.doc_types,
        url: r.result_meta?.url,
        token: r.result_meta?.token,
        owner: r.result_meta?.owner_name,
        update_time: r.result_meta?.update_time_iso,
        summary: stripHighlight(r.summary_highlighted),
      })),
    });
  },
};
