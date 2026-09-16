/**
 * read_feishu_doc：读取飞书文档（docx / wiki 知识库文档，按 URL 或 token 自动路由）。
 * 支持全文、目录大纲、指定章节、block 区间、关键词定位。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

interface DocumentPayload {
  document: {
    document_id?: string;
    revision_id?: number;
    url?: string;
    content?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const readDocTool: ToolDef = {
  name: "read_feishu_doc",
  title: "读取飞书文档",
  description:
    "读取飞书云文档内容（支持文档链接 /docx/ 或知识库链接 /wiki/，自动路由），返回 Markdown。可读全文、目录大纲（scope=outline，先看结构）、指定章节（需 block id）、关键词定位。返回 JSON 含 document_id / revision_id / content。",
  inputSchema: {
    doc: z
      .string()
      .describe("文档 URL 或 token（支持 https://xxx.feishu.cn/docx/xxx、/wiki/xxx 或纯 token）"),
    format: z.enum(["markdown", "xml"]).default("markdown").describe("输出格式，默认 markdown"),
    detail: z
      .enum(["simple", "with-ids", "full"])
      .default("simple")
      .describe(
        "simple=纯内容；with-ids=含 block id（后续局部更新时需要）；full=含样式与编辑元数据",
      ),
    scope: z
      .enum(["full", "outline", "section", "range", "keyword"])
      .default("full")
      .describe(
        "full=全文；outline=仅目录大纲（推荐先看结构）；section=某标题整节（需 start_block_id）；range=block 区间；keyword=关键词定位",
      ),
    keyword: z.string().optional().describe("scope=keyword 时的关键词，支持 'a|b' 或分支"),
    start_block_id: z.string().optional().describe("section/range 的起始 block id"),
    end_block_id: z.string().optional().describe("range 的结束 block id，-1 表示读到文末"),
    max_depth: z.number().int().optional().describe("outline 的标题层级上限，其他 scope 为子树深度"),
  },
  handler: async (args) => {
    const cliArgs = ["docs", "+fetch", "--doc", String(args.doc), "--doc-format", String(args.format ?? "markdown"), "--detail", String(args.detail ?? "simple")];
    const scope = String(args.scope ?? "full");
    if (scope !== "full") cliArgs.push("--scope", scope);
    if (args.keyword) cliArgs.push("--keyword", String(args.keyword));
    if (args.start_block_id) cliArgs.push("--start-block-id", String(args.start_block_id));
    if (args.end_block_id) cliArgs.push("--end-block-id", String(args.end_block_id));
    if (args.max_depth !== undefined) cliArgs.push("--max-depth", String(args.max_depth));

    const data = envelopeData<DocumentPayload>(await runLarkCli(cliArgs));
    return jsonResult(data.document ?? data);
  },
};
