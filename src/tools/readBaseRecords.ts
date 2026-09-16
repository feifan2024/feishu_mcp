/**
 * read_feishu_base_records：读取多维表格（bitable）记录。
 * 结构化筛选条件在服务端拼接为官方 filter-json；
 * CLI 返回平行数组（fields / record_id_list / data 矩阵），此处转为对象数组。
 */
import { runLarkCli, envelopeData } from "../larkCli.js";
import { resolveBaseToken } from "./resolve.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

const filterOp = z.enum([
  "==", "!=", ">", ">=", "<", "<=",
  "intersects", "not_intersects", "contains", "not_contains",
  "is_empty", "non_empty",
]);

/** 官方 filter-json 形如 {"logic":"and","conditions":[[字段, 操作符, 值], ...]} */
function buildFilterJson(args: Record<string, unknown>): string | undefined {
  const filters = args.filters as Array<{ field: string; op: string; value?: unknown }> | undefined;
  if (!filters || filters.length === 0) return undefined;
  const conditions = filters.map((f) => {
    if (f.op === "is_empty" || f.op === "non_empty") return [f.field, f.op];
    if (f.value === undefined) throw new Error(`筛选条件 ${f.field} ${f.op} 缺少 value`);
    return [f.field, f.op, f.value];
  });
  return JSON.stringify({ logic: String(args.logic ?? "and"), conditions });
}

interface RecordListPayload {
  fields?: string[];
  record_id_list?: string[];
  data?: unknown[][];
  has_more?: boolean;
  field_type_list?: string[];
  [key: string]: unknown;
}

export const readBaseRecordsTool: ToolDef = {
  name: "read_feishu_base_records",
  title: "读取多维表格记录",
  description:
    "读取飞书多维表格（bitable）的数据表记录，返回对象数组（每条含 record_id 和字段值）。可按字段筛选（op 支持 ==/!=/>/>=/</<=/intersects/contains/is_empty/non_empty）、排序、字段投影、分页。先用 describe_feishu_base 获取 table_id 和字段名。base_token 支持多维表格 URL、wiki URL 或裸 token。",
  inputSchema: {
    base_token: z.string().describe("多维表格 token 或 URL（支持 /base/、/wiki/ 链接）"),
    table_id: z.string().describe("数据表 ID（tbl 开头）或表名"),
    filters: z
      .array(
        z.object({
          field: z.string().describe("字段名"),
          op: filterOp.describe("操作符"),
          value: z.unknown().optional().describe("比较值；is_empty/non_empty 不需要"),
        }),
      )
      .optional()
      .describe("筛选条件（AND/OR 组合）"),
    logic: z.enum(["and", "or"]).default("and").describe("多个筛选条件的组合逻辑"),
    sort: z
      .array(z.object({ field: z.string(), desc: z.boolean().default(false) }))
      .optional()
      .describe("排序，按数组顺序为优先级"),
    fields: z.array(z.string()).optional().describe("只返回这些字段（字段投影）"),
    view_id: z.string().optional().describe("视图 ID 或名称（可选）"),
    limit: z.number().int().min(1).max(200).default(100).describe("单次最多返回条数（1-200）"),
    offset: z.number().int().min(0).default(0).describe("分页偏移"),
  },
  handler: async (args) => {
    const baseToken = await resolveBaseToken(String(args.base_token));
    const cliArgs = [
      "base",
      "+record-list",
      "--base-token",
      baseToken,
      "--table-id",
      String(args.table_id),
      "--format",
      "json",
      "--limit",
      String(args.limit ?? 100),
      "--offset",
      String(args.offset ?? 0),
    ];
    const filterJson = buildFilterJson(args);
    if (filterJson) cliArgs.push("--filter-json", filterJson);
    if (args.view_id) cliArgs.push("--view-id", String(args.view_id));

    const sort = args.sort as Array<{ field: string; desc: boolean }> | undefined;
    if (sort && sort.length > 0) {
      cliArgs.push("--sort-json", JSON.stringify(sort.map((s) => ({ field: s.field, desc: !!s.desc }))));
    }
    const fields = args.fields as string[] | undefined;
    for (const f of fields ?? []) cliArgs.push("--field-id", f);

    const payload = envelopeData<RecordListPayload>(await runLarkCli(cliArgs));
    const names = payload.fields ?? [];
    const recordIds = payload.record_id_list ?? [];
    const rows = payload.data ?? [];
    const records = rows.map((row, i) => {
      const item: Record<string, unknown> = { record_id: recordIds[i] };
      names.forEach((name, c) => {
        item[name] = Array.isArray(row) ? row[c] : undefined;
      });
      return item;
    });
    return jsonResult({
      records,
      count: records.length,
      has_more: payload.has_more,
      next_offset: payload.has_more ? Number(args.offset ?? 0) + records.length : undefined,
    });
  },
};
