/**
 * read_feishu_sheet：读取飞书电子表格。
 * 未指定子表时返回工作簿的子表清单（sheet_id/name/行列数），便于后续按名读取；
 * 指定子表后按区域读取 CSV（默认）或单元格详情（公式/样式）。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { resolveSpreadsheetToken } from "./resolve.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

interface WorkbookInfo {
  title?: string;
  token?: string;
  sheets?: Array<{
    sheet_id?: string;
    sheet_name?: string;
    row_count?: number;
    column_count?: number;
    resource_type?: string;
    is_hidden?: boolean;
  }>;
}

interface CsvPayload {
  annotated_csv?: string;
  actual_range?: string;
  has_more?: boolean;
  row_indices?: number[];
  col_indices?: string[];
  warning_message?: string;
  [key: string]: unknown;
}

/** 解析工作簿标识（url 或裸 token，均按 spreadsheet token 处理） */
async function workbookArgs(args: Record<string, unknown>): Promise<string[]> {
  const input = args.url ?? args.spreadsheet_token;
  if (!input) throw new Error("必须提供 url 或 spreadsheet_token 之一");
  const token = await resolveSpreadsheetToken(String(input));
  return ["--spreadsheet-token", token];
}

export const readSheetTool: ToolDef = {
  name: "read_feishu_sheet",
  title: "读取飞书电子表格",
  description:
    "读取飞书电子表格（电子表格 spreadsheet，不是多维表格）。不传 sheet_name/sheet_id 时返回工作簿的子表清单；传入子表后按区域读取，默认返回 CSV 文本（纯值），detail=cells 可读公式/样式/批注。",
  inputSchema: {
    url: z.string().optional().describe("电子表格 URL（与 spreadsheet_token 二选一）"),
    spreadsheet_token: z.string().optional().describe("电子表格 token（与 url 二选一）"),
    sheet_name: z.string().optional().describe("子表名称（与 sheet_id 二选一；都不传时返回子表清单）"),
    sheet_id: z.string().optional().describe("子表 ID（与 sheet_name 二选一）"),
    range: z.string().optional().describe("A1 区域，如 A1:F30；不传读全表（大表会被截断）"),
    detail: z.enum(["values", "cells"]).default("values").describe("values=CSV 纯值；cells=含公式/样式/批注"),
  },
  handler: async (args) => {
    const wbArgs = await workbookArgs(args);
    const sheetSelector = args.sheet_name
      ? ["--sheet-name", String(args.sheet_name)]
      : args.sheet_id
        ? ["--sheet-id", String(args.sheet_id)]
        : undefined;

    // 未指定子表：返回工作簿子表清单
    if (!sheetSelector) {
      const info = envelopeData<WorkbookInfo>(await runLarkCli(["sheets", "+workbook-info", ...wbArgs]));
      return jsonResult({
        workbook_title: info.title,
        spreadsheet_token: info.token,
        sheets: info.sheets?.map((s) => ({
          sheet_id: s.sheet_id,
          sheet_name: s.sheet_name,
          row_count: s.row_count,
          column_count: s.column_count,
          resource_type: s.resource_type,
          is_hidden: s.is_hidden,
        })),
        note: "请从上面的 sheets 中选择 sheet_name 或 sheet_id，再次调用本工具读取数据。",
      });
    }

    const cliArgs = [...wbArgs, ...sheetSelector];
    if (args.range) cliArgs.push("--range", String(args.range));

    if (args.detail === "cells") {
      const data = envelopeData<Record<string, unknown>>(
        await runLarkCli(["sheets", "+cells-get", ...cliArgs]),
      );
      return jsonResult(data);
    }

    const data = envelopeData<CsvPayload>(
      await runLarkCli(["sheets", "+csv-get", ...cliArgs, "--include-row-prefix=false"]),
    );
    return jsonResult({
      csv: data.annotated_csv ?? "",
      actual_range: data.actual_range,
      has_more: data.has_more,
      rows_read: data.row_indices?.length,
      cols_read: data.col_indices,
      warning: data.warning_message,
    });
  },
};
