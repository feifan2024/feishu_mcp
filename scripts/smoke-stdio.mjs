/**
 * stdio 冒烟测试：对 dist/index.js 发送 JSON-RPC 帧，验证 initialize/tools/list/tools/call。
 * 用法：node scripts/smoke-stdio.mjs [case]
 * case: all | list | auth | search | read | http
 */
import { spawn } from "node:child_process";

const serverPath = new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function rpc(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

function runSession(frames, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("smoke test 超时"));
    }, timeoutMs);
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => { clearTimeout(timer); resolve(out); });
    for (const f of frames) child.stdin.write(f);
    // 给足响应时间后优雅关闭
    setTimeout(() => child.stdin.end(), Math.min(timeoutMs - 5000, 30000));
  });
}

function parseResponses(out) {
  return out
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => JSON.parse(l));
}

const INIT = rpc(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.1" },
});
const INITED = rpc(2, "notifications/initialized", {});
const LIST = rpc(3, "tools/list", {});

const [,, testCase = "all"] = process.argv;

async function main() {
  if (testCase === "list" || testCase === "all") {
    const out = await runSession([INIT, INITED, LIST]);
    const responses = parseResponses(out);
    const list = responses.find((r) => r.id === 3);
    const tools = list?.result?.tools ?? [];
    console.log(`tools/list: ${tools.length} 个工具`);
    for (const t of tools) console.log(`  - ${t.name}`);
    if (tools.length !== 9) throw new Error(`期望 9 个工具，实际 ${tools.length}`);
  }

  if (testCase === "auth" || testCase === "all") {
    const call = rpc(4, "tools/call", { name: "check_feishu_auth", arguments: {} });
    const out = await runSession([INIT, INITED, call]);
    const responses = parseResponses(out);
    const r = responses.find((x) => x.id === 4);
    const text = r?.result?.content?.[0]?.text ?? "";
    console.log("check_feishu_auth:", r?.result?.isError ? "失败" : "成功");
    console.log(text.slice(0, 500));
    if (r?.result?.isError) throw new Error("check_feishu_auth 失败");
  }

  if (testCase === "search" || testCase === "all") {
    const call = rpc(5, "tools/call", { name: "search_feishu_docs", arguments: { query: "周报", page_size: 3 } });
    const out = await runSession([INIT, INITED, call]);
    const responses = parseResponses(out);
    const r = responses.find((x) => x.id === 5);
    const text = r?.result?.content?.[0]?.text ?? "";
    const data = JSON.parse(text);
    console.log(`search_feishu_docs: ${data.results?.length ?? 0} 条结果`);
    console.log(text.slice(0, 400));
  }

  console.log("smoke test 通过");
}

main().catch((e) => {
  console.error("smoke test 失败:", e.message);
  process.exit(1);
});
