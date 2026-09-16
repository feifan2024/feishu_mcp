/**
 * write_feishu_base_records：多维表格记录批量写入。
 * create=批量新增（官方 {create_records:[...]}）；update=按 record_id 更新（{update_records:{...}}）。
 * --json 不支持 stdin，大 payload 经 @临时文件 传递。
 */
import { runLarkCli, envelopeData, withTempJsonFile } from "../larkCli.js";
import { resolveBaseToken } from "./resolve.js";
import { jsonResult, type ToolDef } from "./types.js";
import { z } from "zod";

export const writeBaseRecordsTool: ToolDef = {
  name: "write_feishu_base_records",
  title: "写入多维表格记录",
  description:
    "向飞书多维表格（bitable）批量新增或更新记录，单次最多 200 条。mode=create 时 records 为字段对象数组；mode=update 时每项需含 record_id 和 fields。字段值约定：文本直接字符串，单选/多选用字符串数组，日期用 'YYYY-MM-DD HH:mm'，勾选用 true/false，数字用数值。先用 describe_feishu_base 确认可写字段。",
  inputSchema: {
    mode: z.enum(["create", "update"]).describe("create=批量新增；update=按 record_id 批量更新"),
    base_token: z.string().describe("多维表格 token"),
    table_id: z.string().describe("数据表 ID（tbl 开头）或表名"),
    records: z
      .array(
        z.object({
          record_id: z.string().optional().describe("记录 ID（update 必填）"),
          fields: z.record(z.string(), z.unknown()).describe("字段名到值的映射"),
        }),
      )
      .describe("记录数组，单次最多 200 条"),
  },
  handler: async (args) => {
    const records = args.records as Array<{ record_id?: string; fields: Record<string, unknown> }>;
    if (!Array.isArray(records) || records.length === 0) throw new Error("records 不能为空");
    if (records.length > 200) throw new Error(`单次最多 200 条，当前 ${records.length} 条，请分批调用`);

    const baseToken = await resolveBaseToken(String(args.base_token));
    const tableId = String(args.table_id);

    let result: unknown;
    if (args.mode === "create") {
      const payload = { create_records: records.map((r) => r.fields) };
      result = await withTempJsonFile(payload, (atFile) =>
        runLarkCli(["base", "+record-batch-create", "--base-token", baseToken, "--table-id", tableId, "--json", atFile]),
      );
    } else {
      const update_records: Record<string, Record<string, unknown>> = {};
      for (const r of records) {
        if (!r.record_id) throw new Error("mode=update 时每条记录必须提供 record_id");
        update_records[r.record_id] = r.fields;
      }
      const payload = { update_records };
      result = await withTempJsonFile(payload, (atFile) =>
        runLarkCli(["base", "+record-batch-update", "--base-token", baseToken, "--table-id", tableId, "--json", atFile]),
      );
    }

    const data = envelopeData<Record<string, unknown>>(result);
    return jsonResult(data);
  },
};
