/**
 * MCP 服务入口。
 * stdio 模式（默认，本地 AI 工具）或 http 模式（MCP_TRANSPORT=http，云服务器部署）。
 * 注意：stdio 模式下 stdout 只能承载 MCP 协议帧，一切日志走 stderr。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getLoginUrl, isAuthError } from "./authFlow.js";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./httpServer.js";
import { LarkCliError } from "./larkCli.js";
import { readDocTool } from "./tools/readDoc.js";
import { writeDocTool } from "./tools/writeDoc.js";
import { readSheetTool } from "./tools/readSheet.js";
import { writeSheetTool } from "./tools/writeSheet.js";
import { readBaseRecordsTool } from "./tools/readBaseRecords.js";
import { writeBaseRecordsTool } from "./tools/writeBaseRecords.js";
import { describeBaseTool } from "./tools/describeBase.js";
import { searchDocsTool } from "./tools/searchDocs.js";
import { checkAuthTool } from "./tools/checkAuth.js";
import type { ToolDef } from "./tools/types.js";

export const ALL_TOOLS: ToolDef[] = [
  readDocTool,
  writeDocTool,
  readSheetTool,
  writeSheetTool,
  readBaseRecordsTool,
  writeBaseRecordsTool,
  describeBaseTool,
  searchDocsTool,
  checkAuthTool,
];

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "feishu-mcp", version: "0.1.0" },
    { instructions: "飞书读写服务：文档/电子表格/多维表格的读写与搜索，底层为 lark-cli（用户身份）。" },
  );

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          return await tool.handler(args ?? {});
        } catch (err) {
          const message =
            err instanceof LarkCliError || err instanceof Error
              ? err.message
              : String(err);
          let text = `操作失败：${message}`;
          // 飞书授权失效时自动生成重新授权链接，用户浏览器确认即可恢复，无需登录服务器
          if (isAuthError(message)) {
            const url = await getLoginUrl().catch(() => undefined);
            text += url
              ? `\n\n🔁 检测到飞书授权失效。请用浏览器打开以下链接重新授权（10 分钟内有效）：\n${url}\n确认后等待几秒再重试本操作即可，无需登录服务器。`
              : `\n\n检测到飞书授权失效，自动生成授权链接失败。请在服务器上执行：lark-cli auth login --domain docs,drive,base,sheets`;
          }
          return {
            content: [{ type: "text" as const, text }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.transport === "http") {
    await startHttpServer(createServer(), config);
  } else {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    console.error("[feishu-mcp] stdio 服务已启动（9 个工具已注册）");
  }
}

main().catch((err) => {
  console.error("[feishu-mcp] 启动失败:", err);
  process.exit(1);
});
