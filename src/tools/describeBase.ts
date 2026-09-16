/**
 * describe_feishu_base：列出多维表格的数据表与字段 schema。
 * 读写记录前先用它发现 table_id 与准确字段名。
 * 支持 /base/ URL、wiki 挂载的多维表格（自动解析）与裸 token。
 */
import { envelopeData, runLarkCli } from "../larkCli.js";
import { resolveBaseToken } from "./resolve.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

interface TableListItem {
  id?: string;
  name?: string;
  records_count?: number;
  [key: string]: unknown;
}

interface FieldItem {
  id?: string;
  name?: string;
  type?: string | number;
  is_primary?: boolean;
  multiple?: boolean;
  options?: Array<{ name?: string }>;
  [key: string]: unknown;
}

interface TablesPayload {
  tables?: TableListItem[];
  items?: TableListItem[];
  has_more?: boolean;
  [key: string]: unknown;
}

interface FieldsPayload {
  fields?: FieldItem[];
  items?: FieldItem[];
  has_more?: boolean;
  [key: string]: unknown;
}

export const describeBaseTool: ToolDef = {
  name: "describe_feishu_base",
  title: "查看多维表格结构",
  description:
    "列出飞书多维表格（bitable）的所有数据表及每张表的字段 schema（字段名/类型/可选值），用于读写记录前发现 table_id、准确字段名和字段类型约定（如单选字段的合法选项）。base_token 支持多维表格 URL、wiki 知识库 URL 或裸 token。",
  inputSchema: {
    base_token: z.string().describe("多维表格 token 或 URL（支持 /base/、/wiki/ 链接）"),
  },
  handler: async (args) => {
    const baseToken = await resolveBaseToken(String(args.base_token));
    const tablesPayload = envelopeData<TablesPayload>(
      await runLarkCli(["base", "+table-list", "--base-token", baseToken, "--limit", "100"]),
    );
    const tables = tablesPayload.tables ?? tablesPayload.items ?? [];

    // 每张表查一次字段列表（串行，避免限流）；CLI 不同版本返回 tables/items 两种形状
    const described = [];
    for (const t of tables) {
      const tableId = t.id ?? (t as { table_id?: string }).table_id ?? "";
      const tableName = t.name ?? "";
      try {
        const fieldsPayload = envelopeData<FieldsPayload>(
          await runLarkCli([
            "base", "+field-list", "--base-token", baseToken,
            "--table-id", String(tableId || tableName), "--limit", "200",
          ]),
        );
        const fields = fieldsPayload.fields ?? fieldsPayload.items ?? [];
        described.push({
          table_id: tableId,
          name: tableName,
          records_count: t.records_count,
          fields: fields.map((f) => ({
            name: f.name,
            field_id: f.id,
            type: f.type,
            is_primary: f.is_primary === true ? true : undefined,
            multiple: f.multiple === true ? true : undefined,
            options: f.options?.map((o) => o.name).filter(Boolean),
          })),
        });
      } catch (err) {
        described.push({ table_id: tableId, name: tableName, fields_error: (err as Error).message });
      }
    }

    return jsonResult({ tables: described, has_more: tablesPayload.has_more });
  },
};
