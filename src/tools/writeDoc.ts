/**
 * write_feishu_doc：写入飞书文档，四种模式。
 * create=新建文档；append=文末追加；replace=整篇覆盖（overwrite）；
 * replace_text=精确文本替换（str_replace）。
 * 长内容一律经 stdin（--content -）传递，规避命令行长度限制。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

const MAX_ARGV_CONTENT = 20_000;

interface DocumentPayload {
  document: {
    document_id?: string;
    revision_id?: number;
    url?: string;
    warnings?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const writeDocTool: ToolDef = {
  name: "write_feishu_doc",
  title: "写入飞书文档",
  description:
    "写入飞书云文档（docx / wiki），内容用 Markdown。模式：create=新建文档（需 title）；append=在文末追加；replace=整篇覆盖已有文档（慎用，会丢弃原有内容）；replace_text=把文档中的精确旧文本替换为新文本（适合小改动）。新建成功返回新文档的 url 和 document_id。",
  inputSchema: {
    mode: z.enum(["create", "append", "replace", "replace_text"]).describe("写入模式"),
    doc: z.string().optional().describe("目标文档 URL 或 token（append/replace/replace_text 必填）"),
    title: z.string().optional().describe("文档标题（create 必填）"),
    content: z.string().optional().describe("Markdown 内容（create 可选只建空文档；append/replace 必填）"),
    parent_token: z
      .string()
      .optional()
      .describe("create 可选：父文件夹 token 或知识库节点 token，不传则建在个人空间"),
    pattern: z.string().optional().describe("replace_text 必填：要被替换的旧文本（需与文档中的文本精确一致）"),
  },
  handler: async (args) => {
    const mode = String(args.mode);
    let cliArgs: string[];
    let stdin: string | undefined;

    if (mode === "create") {
      if (!args.title) throw new Error("mode=create 时必须提供 title");
      cliArgs = ["docs", "+create", "--doc-format", "markdown", "--title", String(args.title)];
      if (args.parent_token) cliArgs.push("--parent-token", String(args.parent_token));
      if (args.content) {
        cliArgs.push("--content", "-");
        stdin = String(args.content);
      }
    } else {
      if (!args.doc) throw new Error(`mode=${mode} 时必须提供 doc（文档 URL 或 token）`);
      cliArgs = ["docs", "+update", "--doc", String(args.doc)];
      if (mode === "append") {
        if (args.content === undefined) throw new Error("mode=append 时必须提供 content");
        cliArgs.push("--command", "append", "--doc-format", "markdown", "--content", "-");
        stdin = String(args.content);
      } else if (mode === "replace") {
        if (args.content === undefined) throw new Error("mode=replace 时必须提供 content");
        cliArgs.push("--command", "overwrite", "--doc-format", "markdown", "--content", "-");
        stdin = String(args.content);
      } else {
        // replace_text：str_replace，内容较短直接走 argv
        if (!args.pattern) throw new Error("mode=replace_text 时必须提供 pattern（旧文本）");
        if (args.content === undefined) throw new Error("mode=replace_text 时必须提供 content（新文本，空字符串表示删除旧文本）");
        const replacement = String(args.content);
        if (replacement.length > MAX_ARGV_CONTENT) {
          throw new Error(
            `替换文本过长（${replacement.length} 字符）。请改用 replace（整篇覆盖）或拆分多次 replace_text。`,
          );
        }
        cliArgs.push("--command", "str_replace", "--pattern", String(args.pattern), "--content", replacement);
      }
    }

    const data = envelopeData<DocumentPayload>(await runLarkCli(cliArgs, { stdin }));
    return jsonResult(data.document ?? data);
  },
};
