import type { z } from "zod";

/** MCP tool 返回值（SDK 要求带 index signature，CallToolResult 的结构化子集） */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** 工具定义：index.ts 据此注册到 McpServer */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/** 把结果对象序列化为文本返回给 MCP 客户端 */
export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
