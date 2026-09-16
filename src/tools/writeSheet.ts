/**
 * write_feishu_sheet：写入飞书电子表格。
 * overwrite=从锚点单元格粘贴 CSV（+csv-put，--csv 走 stdin）；
 * append=追加到子表末行（+table-put --mode append，CSV 自动转 typed payload）；
 * set_cell=按区域写值/公式（+cells-set，--cells 走 stdin）。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { resolveSpreadsheetToken } from "./resolve.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

/** 解析 RFC-4180 CSV 为二维数组（处理引号、转义引号、跨行字段） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // 去掉末尾空行
  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return rows;
}

/** 纯数字（无前导零、非超长）才转 number，其余保持文本，避免电话/编号被破坏 */
function coerceCell(v: string): string | number | null {
  const t = v.trim();
  if (t === "") return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t) && t.length <= 15 && !/^0\d/.test(t)) {
    return Number(t);
  }
  return t;
}

export const writeSheetTool: ToolDef = {
  name: "write_feishu_sheet",
  title: "写入飞书电子表格",
  description:
    "写入飞书电子表格。模式：overwrite=从锚点单元格（默认 A1）开始粘贴 CSV 文本；append=把 CSV（首行为表头）追加到子表末行；set_cell=向指定区域写值或公式（cells 为二维数组，如 [[{\"value\":\"名称\"},{\"formula\":\"=SUM(A1:A2)\"}]]）。",
  inputSchema: {
    mode: z.enum(["overwrite", "append", "set_cell"]).describe("写入模式"),
    url: z.string().optional().describe("电子表格 URL（与 spreadsheet_token 二选一）"),
    spreadsheet_token: z.string().optional().describe("电子表格 token（与 url 二选一）"),
    sheet_name: z.string().optional().describe("子表名称（与 sheet_id 二选一，必填）"),
    sheet_id: z.string().optional().describe("子表 ID（与 sheet_name 二选一，必填）"),
    csv: z.string().optional().describe("overwrite/append 必填：RFC-4180 CSV 文本（append 时首行视为表头）"),
    start_cell: z.string().optional().describe("overwrite 锚点单元格，默认 A1"),
    range: z.string().optional().describe("set_cell 必填：目标区域，如 A1:B2"),
    cells: z.string().optional().describe("set_cell 必填：单元格二维数组的 JSON 字符串"),
    allow_overwrite: z.boolean().default(true).describe("是否允许覆盖非空单元格，默认允许"),
  },
  handler: async (args) => {
    const wbInput = args.url ?? args.spreadsheet_token;
    if (!wbInput) throw new Error("必须提供 url 或 spreadsheet_token 之一");
    const resolvedToken = await resolveSpreadsheetToken(String(wbInput));
    const wbArgs = ["--spreadsheet-token", resolvedToken];
    const sheetSelector = args.sheet_name
      ? ["--sheet-name", String(args.sheet_name)]
      : args.sheet_id
        ? ["--sheet-id", String(args.sheet_id)]
        : (() => {
            throw new Error("必须提供 sheet_name 或 sheet_id 之一");
          })();

    let cliArgs: string[];
    let stdin: string | undefined;

    if (args.mode === "overwrite") {
      if (!args.csv) throw new Error("mode=overwrite 时必须提供 csv 文本");
      cliArgs = ["sheets", "+csv-put", ...wbArgs, ...sheetSelector, "--csv", "-"];
      if (args.start_cell) cliArgs.push("--start-cell", String(args.start_cell));
      if (args.allow_overwrite === false) cliArgs.push("--allow-overwrite=false");
      stdin = String(args.csv);
    } else if (args.mode === "append") {
      if (!args.csv) throw new Error("mode=append 时必须提供 csv 文本（首行为表头）");
      if (!args.sheet_name && !args.sheet_id) throw new Error("mode=append 时必须提供 sheet_name 或 sheet_id");
      const parsed = parseCsv(String(args.csv));
      if (parsed.length < 1) throw new Error("csv 内容为空");

      // +table-put 按"子表名"匹配（不存在时会新建同名子表）：
      // 传了 sheet_id 时先解析出真实子表名，避免误建新表
      let sheetNameForPayload = args.sheet_name ? String(args.sheet_name) : String(args.sheet_id);
      if (!args.sheet_name) {
        try {
          const info = envelopeData<{ sheets?: Array<{ sheet_id?: string; sheet_name?: string }> }>(
            await runLarkCli(["sheets", "+workbook-info", ...wbArgs]),
          );
          const match = info.sheets?.find((s) => s.sheet_id === sheetNameForPayload);
          if (match?.sheet_name) sheetNameForPayload = match.sheet_name;
        } catch {
          // 解析失败则保持原值
        }
      }

      // 空表（默认网格 200 行）直接 append 会落在第 201 行：先探测 A1:B2，空则改写 A1
      let anchorMode = false;
      try {
        const probe = envelopeData<{ annotated_csv?: string }>(
          await runLarkCli(["sheets", "+csv-get", ...wbArgs, ...sheetSelector, "--range", "A1:B2", "--include-row-prefix=false"]),
        );
        // 空单元格返回 ",\n," 形态，剥离逗号与空白后应为空
        if (!probe.annotated_csv?.replace(/[,\s]/g, "")) anchorMode = true;
      } catch {
        // 探测失败时按正常 append 处理
      }

      if (anchorMode) {
        cliArgs = ["sheets", "+csv-put", ...wbArgs, ...sheetSelector, "--csv", "-", "--start-cell", "A1"];
        if (args.allow_overwrite === false) cliArgs.push("--allow-overwrite=false");
        stdin = String(args.csv);
        const data = envelopeData<Record<string, unknown>>(await runLarkCli(cliArgs, { stdin }));
        return jsonResult({ ...data, note: "目标子表为空，已从 A1 写入（等价于追加）" });
      }

      const [header, ...dataRows] = parsed;
      // 列名取 CSV 表头（与已有子表的列按名匹配）；dtypes 键必须与 columns 一致
      const columns = header.map((h, idx) => (h.trim() === "" ? `col${idx}` : h.trim()));
      const numericRows = dataRows.map((r) => r.map(coerceCell));
      const dtypes: Record<string, string> = {};
      for (let c = 0; c < columns.length; c++) {
        const values = numericRows.map((r) => r[c]).filter((v) => v !== null);
        if (values.length === 0) continue;
        if (values.every((v) => typeof v === "number" && Number.isInteger(v))) {
          dtypes[columns[c]] = "int64";
        } else if (values.every((v) => typeof v === "number")) {
          dtypes[columns[c]] = "float64";
        }
      }
      const payload = {
        sheets: [
          {
            name: sheetNameForPayload,
            mode: "append",
            columns,
            dtypes,
            data: numericRows.map((r) => columns.map((_, idx) => r[idx] ?? null)),
          },
        ],
      };
      cliArgs = ["sheets", "+table-put", ...wbArgs, "--sheets", "-"];
      stdin = JSON.stringify(payload);
    } else {
      if (!args.range) throw new Error("mode=set_cell 时必须提供 range");
      if (!args.cells) throw new Error("mode=set_cell 时必须提供 cells（二维数组 JSON）");
      // 校验是合法 JSON 二维数组再传给 CLI
      const parsed = JSON.parse(String(args.cells)) as unknown;
      if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) {
        throw new Error('cells 必须是二维数组 JSON，如 [[{"value":"a"},{"value":"b"}]]');
      }
      cliArgs = ["sheets", "+cells-set", ...wbArgs, ...sheetSelector, "--range", String(args.range), "--cells", "-"];
      if (args.allow_overwrite === false) cliArgs.push("--allow-overwrite=false");
      stdin = String(args.cells);
    }

    const data = envelopeData<Record<string, unknown>>(await runLarkCli(cliArgs, { stdin }));
    return jsonResult(data);
  },
};
