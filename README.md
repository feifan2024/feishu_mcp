# feishu-mcp

飞书（Lark）MCP 服务：通过 MCP 接口对飞书 **文档 / 知识库文档 / 电子表格 / 多维表格** 进行读取、写入与搜索。

本质是一个**薄连接器**：MCP 客户端（ZCode / Claude Code / Cursor 等）通过 MCP 协议发来指令，本服务调用 [飞书官方 lark-cli](https://github.com/larksuite/cli) 执行，并把结果整理为 AI 友好的结构化 JSON 返回。**认证完全复用 lark-cli 的 OAuth 登录态**，本服务自身不接触任何飞书凭证。

支持两种传输模式：

- **stdio**（默认）：本地使用，AI 工具直接拉起进程；
- **HTTP(S)**：云服务器部署，Streamable HTTP + Bearer Token 鉴权，路径 `/mcp`。

## 工具清单（9 个）

| 工具 | 说明 |
|---|---|
| `read_feishu_doc` | 读文档（docx/wiki 链接或 token），全文 / 大纲 / 章节 / 关键词定位，Markdown 输出 |
| `write_feishu_doc` | 写文档：`create` 新建 / `append` 文末追加 / `replace` 整篇覆盖 / `replace_text` 精确替换 |
| `read_feishu_sheet` | 读电子表格：不传子表返回子表清单；按区域读 CSV，`detail=cells` 读公式/样式 |
| `write_feishu_sheet` | 写电子表格：`overwrite` 区域覆盖 / `append` 追加末行 / `set_cell` 写值或公式 |
| `read_feishu_base_records` | 读多维表格记录：结构化筛选、排序、字段投影、分页 |
| `write_feishu_base_records` | 写多维表格记录：批量新增 / 按 record_id 更新（单次 ≤200 条） |
| `describe_feishu_base` | 列出多维表格的数据表与字段 schema（读写记录前先调用） |
| `search_feishu_docs` | 搜索我有权限的云空间对象（关键词 ≤30 字符，支持 `intitle:`、`OR`、`-排除`） |
| `check_feishu_auth` | 检查 lark-cli 安装与登录状态，未登录时返回修复指引 |

**推荐工作流**：`search_feishu_docs` 找到文档 → 读写；多维表格先 `describe_feishu_base` 拿 `table_id` 和字段名 → 再读写记录。

## 前置条件

1. Node.js ≥ 20
2. 安装并登录 lark-cli（一次性，在运行本服务的机器上）：

```bash
npx @larksuite/cli@latest install   # 或 npm i -g @larksuite/cli
lark-cli config init                # 配置应用凭证（交互式）
lark-cli auth login --recommend     # 浏览器授权，按业务域授权也可：
                                    # lark-cli auth login --domain docs,drive,base,sheets
lark-cli auth status                # 确认登录态
```

## 本地使用（stdio）

```bash
git clone <repo> feishu_mcp && cd feishu_mcp
npm install && npm run build
```

MCP 客户端配置（以 ZCode / Claude Code 为例）：

```json
{
  "mcpServers": {
    "feishu": {
      "command": "node",
      "args": ["D:/projects/feishu_mcp/dist/index.js"]
    }
  }
}
```

> Windows 提示：若提示找不到 lark-cli，把 `LARK_CLI_PATH` 设为 lark-cli.exe 的完整路径（通常在 `npm config get prefix` 下的 `node_modules/@larksuite/cli/bin/lark-cli.exe`）。

## 云服务器部署（HTTP(S) 模式）

```bash
node dist/index.js   # 需要以下环境变量
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `http` 启动 HTTP(S) 服务 |
| `MCP_HTTP_TOKEN` | — | **HTTP 模式必填**，Bearer token，逗号分隔可配多个；未配置拒绝启动 |
| `MCP_HTTP_HOST` | `127.0.0.1` | 反代场景绑 `127.0.0.1`，直连绑 `0.0.0.0` |
| `MCP_HTTP_PORT` | `3000` | 监听端口，端点为 `/mcp` |
| `MCP_HTTP_TLS_CERT` / `MCP_HTTP_TLS_KEY` | — | 同时配置则以 HTTPS 直启；不配则纯 HTTP（由前置反代终止 TLS） |
| `LARK_CLI_PATH` | `lark-cli` | lark-cli 可执行文件路径 |
| `LARK_IDENTITY` | `user` | 调用身份 `user` / `bot` |
| `LARK_PROFILE` | — | 多应用 profile 时注入 `--profile` |
| `LARK_TIMEOUT_MS` | `120000` | 单次 lark-cli 调用超时 |
| `FEISHU_MCP_CONFIG` | `~/.feishu-mcp/config.json` | JSON 配置文件路径（环境变量优先于文件） |

### HTTPS 的两条路径

1. **nginx 反代终止 TLS（推荐）**：服务绑 `127.0.0.1:3000`，nginx 挂证书转发，见 `deploy/nginx-feishu-mcp.conf.sample`；
2. **服务内置 HTTPS**：配置 `MCP_HTTP_TLS_CERT` + `MCP_HTTP_TLS_KEY` 后服务直接以 `https://` 启动。

客户端配置示例：

```json
{
  "mcpServers": {
    "feishu": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_HTTP_TOKEN 的值>" }
    }
  }
}
```

### 方式 A：Docker

```bash
# 1. 修改 docker-compose.yml 中的 MCP_HTTP_TOKEN
docker compose up -d --build

# 2. 首次登录（一次性）：容器内无系统密钥链，lark-cli 回落为文件存储（挂载在 volume 中持久化）
docker exec -it feishu-mcp lark-cli config init
docker exec -it feishu-mcp lark-cli auth login --domain docs,drive,base,sheets
# 按提示在本地浏览器打开授权链接确认即可（无需在服务器开浏览器）

# 3. 重启后登录态仍在（凭证已持久化到 volume）
docker compose restart
```

### 方式 B：systemd（裸机）

```bash
# 构建产物上传到 /opt/feishu-mcp（或服务器上 git clone 后 npm install && npm run build）
sudo cp deploy/feishu-mcp.service /etc/systemd/system/
sudo cp deploy/feishu-mcp.env /opt/feishu-mcp/deploy/ && sudo chmod 600 /opt/feishu-mcp/deploy/feishu-mcp.env
# 编辑 env 中的 MCP_HTTP_TOKEN 等配置
sudo systemctl daemon-reload && sudo systemctl enable --now feishu-mcp
```

服务器上登录（一次性）：

```bash
sudo -u <运行用户> lark-cli config init
sudo -u <运行用户> lark-cli auth login --domain docs,drive,base,sheets
# 无桌面环境时如连接中断，可用官方断点续登：
#   lark-cli auth login --domain docs --no-wait   # 记下 device code 与 URL
#   lark-cli auth login --device-code <DEVICE_CODE>
```

## 验证

```bash
# stdio 冒烟测试（工具清单 + 登录态 + 真实搜索）
node scripts/smoke-stdio.mjs all

# 写读全链路校准（会在云空间创建"【MCP校准-可删除】"测试文件）
node scripts/calibrate.mjs docs    # 文档 create→read→append→replace_text→overwrite
node scripts/calibrate.mjs sheet   # 电子表格读取
node scripts/calibrate.mjs base    # 多维表格 describe + 读记录
BASE_TOKEN=<token> node scripts/calibrate.mjs basewrite      # 多维表格写记录
SHEET_TOKEN=<token> node scripts/calibrate.mjs sheetwrite    # 电子表格写
```

## 注意事项

- **风险提示**：授权后本服务以你的用户身份读写飞书，写入操作（尤其 `replace` 整篇覆盖）不可自动回滚，请在可信网络与可信客户端环境下使用。
- **授权自愈**：飞书用户授权失效（长期闲置 token 过期、主动撤销授权）时，工具报错信息会自动附带一个设备码授权链接（10 分钟内有效），在浏览器打开确认后服务后台自动完成登录，**无需登录服务器**；`check_feishu_auth` 在授权失效时也会直接返回 `login_url` 字段。同一时间只保留一个授权流程，链接 9 分钟内复用。
- **写入可见性**：飞书写入后立即读取可能有毫秒级延迟（最终一致）。
- **电子表格 append**：目标子表为空时自动从 A1 写入；非空时追加到数据末行。
- **多维表格 token**：支持 `/base/` URL、知识库 `/wiki/` URL（自动解析节点）或裸 token。
- lark-cli 升级：`lark-cli update`（官方发布较频繁，schema 修正优先用新版）。
