/**
 * 真实链路校准：文档写读全链路 + 表格/多维表格读取。
 * 用法：node scripts/calibrate.mjs [docs|sheet|base|all]
 */
import { spawn } from "node:child_process";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SHEET_TOKEN = "SHEET_TOKEN_PLACEHOLDER"; // 团队周报（只读校准）

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

/** 与服务保持长连接的会话，逐步发送请求 */
class Session {
  constructor() {
    this.child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.buf = "";
    this.pending = new Map();
    this.nextId = 100;
    this.child.stdout.on("data", (c) => this.#onData(c));
    this.child.stderr.on("data", () => {});
  }

  #onData(chunk) {
    this.buf += chunk.toString("utf8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line.startsWith("{")) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch { /* 忽略非 JSON 行 */ }
    }
  }

  async start() {
    await this.call("initialize", {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "calib", version: "0" },
    });
    this.child.stdin.write(rpc(0, "notifications/initialized", {}));
  }

  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve });
      this.child.stdin.write(rpc(id, method, params));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 120_000);
    });
  }

  async tool(name, args) {
    const r = await this.call("tools/call", { name, arguments: args });
    const text = r?.result?.content?.[0]?.text ?? "";
    if (r?.result?.isError) throw new Error(`${name} 失败: ${text}`);
    return text;
  }

  close() {
    this.child.kill("SIGKILL");
  }
}

async function calibrateDocs(s) {
  const stamp = new Date().toISOString().slice(0, 19);
  const title = `【MCP校准-${stamp}】可删除`;

  // 1. create
  const created = JSON.parse(await s.tool("write_feishu_doc", {
    mode: "create",
    title,
    content: "# 校准文档\n\n这是 feishu-mcp 写入链路校准的第一段。\n",
  }));
  console.log("create ✓", created.url ?? created.document_id);
  const doc = created.document_id ?? created.url;

  // 2. read
  const read1 = JSON.parse(await s.tool("read_feishu_doc", { doc }));
  console.log("read ✓ revision:", read1.revision_id, "content 前 60 字:", String(read1.content).slice(0, 60).replace(/\n/g, " "));

  // 3. append
  const appended = JSON.parse(await s.tool("write_feishu_doc", {
    mode: "append", doc,
    content: "\n## 追加段落\n\n第二段：append 模式校验。\n",
  }));
  console.log("append ✓ revision:", appended.revision_id);

  // 4. replace_text
  const replaced = JSON.parse(await s.tool("write_feishu_doc", {
    mode: "replace_text", doc,
    pattern: "第二段：append 模式校验。", content: "第二段：已通过 replace_text 改写。",
  }));
  console.log("replace_text ✓ revision:", replaced.revision_id);

  // 5. overwrite
  const overwritten = JSON.parse(await s.tool("write_feishu_doc", {
    mode: "replace", doc,
    content: "# 整篇覆盖后的内容\n\noverwrite 模式校验完成。\n",
  }));
  console.log("replace(overwrite) ✓ revision:", overwritten.revision_id);

  // 6. 终读确认
  const read2 = JSON.parse(await s.tool("read_feishu_doc", { doc }));
  console.log("final read ✓:", String(read2.content).replace(/\n/g, " | ").slice(0, 100));
  console.log("校准文档 token（可手动删除）:", doc);
}

async function calibrateSheet(s) {
  // 子表清单
  const info = JSON.parse(await s.tool("read_feishu_sheet", { spreadsheet_token: SHEET_TOKEN }));
  const first = info.sheets.find((x) => x.resource_type === "sheet");
  console.log("workbook-info ✓ 子表数:", info.sheets.length, "首个 sheet:", first.sheet_name);

  // 读区域
  const csv = JSON.parse(await s.tool("read_feishu_sheet", {
    spreadsheet_token: SHEET_TOKEN, sheet_id: first.sheet_id, range: "A1:C5",
  }));
  console.log("csv-get ✓ 实际区域:", csv.actual_range, "| 行数:", csv.rows_read);
}

async function calibrateBase(s) {
  // 搜索一个 bitable 后 describe；无 base_token 参数时跳过
  const r = JSON.parse(await s.tool("search_feishu_docs", { query: "多维表格", doc_types: ["bitable"], page_size: 5 }));
  if (!r.results?.length) {
    console.log("base 校准跳过：搜索不到 bitable");
    return null;
  }
  const token = r.results[0].token;
  const desc = JSON.parse(await s.tool("describe_feishu_base", { base_token: token }));
  console.log(`describe_base ✓ ${desc.tables?.length ?? 0} 张表`);
  const first = desc.tables?.[0];
  console.log(`  表 ${first.name} (${first.table_id}) 字段:`, (first.fields ?? []).map((f) => `${f.name}(${f.type})`).slice(0, 8).join(", "));

  // 读记录（挑字段少的一张表验证平行数组转换）
  const simple = desc.tables.find((t) => t.fields?.length <= 6) ?? first;
  const recs = JSON.parse(await s.tool("read_feishu_base_records", {
    base_token: token, table_id: simple.table_id, limit: 3,
  }));
  console.log(`read_records ✓ ${recs.count} 条 (has_more=${recs.has_more})`);
  console.log("  首条:", JSON.stringify(recs.records[0], null, 0).slice(0, 200));
  return { token, firstTable: simple };
}

async function calibrateBaseWrite(s) {
  const baseToken = process.env.BASE_TOKEN;
  if (!baseToken) throw new Error("base 写入校准需设置 BASE_TOKEN 环境变量");

  // 1. 批量新增 2 条
  const created = JSON.parse(await s.tool("write_feishu_base_records", {
    mode: "create", base_token: baseToken, table_id: "任务",
    records: [
      { fields: { "标题": "任务A", "状态": ["Todo"], "分数": 10 } },
      { fields: { "标题": "任务B", "状态": ["Done"], "分数": 20 } },
    ],
  }));
  console.log("base create ✓:", JSON.stringify(created).slice(0, 200));

  // 2. 读回拿到 record_id
  const recs = JSON.parse(await s.tool("read_feishu_base_records", {
    base_token: baseToken, table_id: "任务", limit: 5,
  }));
  console.log("read back ✓ count:", recs.count, "records:", JSON.stringify(recs.records).slice(0, 300));
  const first = recs.records.find((r) => r["标题"] === "任务A");
  if (!first) throw new Error("读回记录中找不到 任务A");
  console.log("read back ✓ record_id:", first.record_id);

  // 3. 更新该条
  const updated = JSON.parse(await s.tool("write_feishu_base_records", {
    mode: "update", base_token: baseToken, table_id: "任务",
    records: [{ record_id: first.record_id, fields: { "状态": ["Done"], "分数": 99 } }],
  }));
  console.log("base update ✓:", JSON.stringify(updated).slice(0, 150));
}

async function calibrateSheetWrite(s) {
  const sheetToken = process.env.SHEET_TOKEN;
  if (!sheetToken) throw new Error("sheet 写入校准需设置 SHEET_TOKEN 环境变量");

  // 1. 新建工作簿已在 base-create 场景外，此处用 append 写入已有子表
  // 先建一个新工作簿专用子表，避免污染：直接调 CLI 一次性建簿
  const created = JSON.parse(await s.tool("read_feishu_sheet", { spreadsheet_token: sheetToken }));
  const target = created.sheets.find((x) => x.resource_type === "sheet");
  const csv = "名称,数量,备注\n苹果,3,校准\n香蕉,5,\"带,逗号\"\n";
  const appended = JSON.parse(await s.tool("write_feishu_sheet", {
    mode: "append", spreadsheet_token: sheetToken, sheet_name: target.sheet_name, csv,
  }));
  console.log("sheet append ✓:", JSON.stringify(appended).slice(0, 200));

  // 2. overwrite 写入指定锚点
  const put = JSON.parse(await s.tool("write_feishu_sheet", {
    mode: "overwrite", spreadsheet_token: sheetToken, sheet_name: target.sheet_name,
    start_cell: "E1", csv: "X,Y\n1,2\n",
  }));
  console.log("sheet overwrite ✓:", JSON.stringify(put).slice(0, 150));

  // 3. set_cell 公式
  const set = JSON.parse(await s.tool("write_feishu_sheet", {
    mode: "set_cell", spreadsheet_token: sheetToken, sheet_name: target.sheet_name,
    range: "G1", cells: JSON.stringify([[{ "value": "合计" }, { "formula": "=SUM(B:B)" }]]),
  }));
  console.log("sheet set_cell ✓:", JSON.stringify(set).slice(0, 150));
}

async function main() {
  const [, , scope = "all"] = process.argv;
  const s = new Session();
  try {
    await s.start();
    if (scope === "docs" || scope === "all") await calibrateDocs(s);
    if (scope === "sheet" || scope === "all") await calibrateSheet(s);
    if (scope === "base" || scope === "all") await calibrateBase(s);
    if (scope === "basewrite" || scope === "all") await calibrateBaseWrite(s);
    if (scope === "sheetwrite" || scope === "all") await calibrateSheetWrite(s);
    console.log("校准完成");
  } finally {
    s.close();
  }
}

main().catch((e) => {
  console.error("校准失败:", e.message);
  process.exit(1);
});
