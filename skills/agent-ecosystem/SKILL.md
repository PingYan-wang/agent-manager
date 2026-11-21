---
name: agent-ecosystem
description: 本机 Agent 生态系统的统一能力入口。当用户提到其他 Agent 的对话/历史、MCP 服务、skill 管理、任务编排/子 Agent/长程任务自动拆分时使用。提供跨系统与同系统会话读取、MCP 网关、skill 同步、任务编排器的使用方式。
---

# Agent 生态系统能力

本机运行着一套本地 Agent 管理层（Agent Manager, http://localhost:3100），把多个 AI Agent 的能力打通共享。**不要假设你只能看到当前对话**——以下能力默认可用。

## 1. 跨 MCP 访问（MCPHub 网关）

所有 MCP server 统一挂在 `http://localhost:3000/mcp`（streamable HTTP）。你的 Agent 已被配置接入网关，网关里注册的所有工具对你直接可见，无需额外配置。

- 工具来源覆盖：WorkBuddy 连接器（腾讯文档 240 工具、ima-mcp 9 工具、lighthouse-ops 60 工具等）、Codex、以及任何 Agent 里新装的 MCP——**装好即自动同步进网关**（文件变更约 3 秒内生效）
- **网关已包含的能力不要重复安装**：例如 ima、腾讯文档、lighthouse 在网关里已 connected，可直接用 `mcp__mcphub__workbuddy_*` 系列工具。用户要求"使用 ima/腾讯文档"时先查网关工具，别去 `hermes mcp add` 或装第三方同名 MCP
- stdio 类 MCP 冷启动注意：uvx/uv 系 server 首次运行要下载依赖，易超时；优先复用已 connected 的网关服务
- 查 MCP 状态/工具列表：网关服务目录 `~/.agent-manager/gateway-catalog.md`（名称/状态/工具数，随网关变更自动更新）；或打开 http://localhost:3100 →「MCP 服务」页
- 不确定某能力是否已接入时，**先读 gateway-catalog.md 再决定是否安装**——网关里大概率已有（如 ima、腾讯文档、lighthouse）
- 某个 MCP 工具"找不到"时：先确认它是否在网关中 connected，再考虑让用户重启 Agent 会话刷新工具列表

## 2. Skill 统一同步

本机所有已安装 skill 会自动 symlink 铺到**每个 Agent 的原生 skill 目录**。你看到的 skill 列表就是全集；如果某 skill "应该存在但看不到"，提示用户到 http://localhost:3100 →「已安装 Skills」点「同步全部 skill 到所有 agent」。

## 3. 会话读取 / 对话继承 / 共享记忆（agent-bridge MCP）

通过 MCP 工具访问本机各 Agent 的会话记录与共享记忆——**包括你自己这个 Agent 的历史对话**（对话继承能力），也包括其他 Agent 的对话（跨系统）。

工具（前缀 `agent-bridge-`）：

| 工具 | 用途 |
|---|---|
| `agent-bridge-agents_list` | 列出哪些 Agent 有可读的本地会话存储 |
| `agent-bridge-conversations_list` | 列某 Agent 最近会话（参数 `agent`, `limit`） |
| `agent-bridge-conversation_read` | 读某条会话内容（参数 `agent`, `id`, `max_chars`） |
| `agent-bridge-conversations_search` | **关键词搜索会话内容**（参数 `query`, `agent` 可选=全部, `limit`）——不确定在哪个会话时先搜它 |
| `agent-bridge-memory_save` | 把结论/笔记写入共享记忆（参数 `agent`, `title`, `content`, `tags`） |
| `agent-bridge-memory_search` | 搜索共享记忆（参数 `query`, `agent` 可选, `limit`） |

`agent` 参数取值：`hermes` / `devin` / `codex` / `workbuddy` 等。读**自己**的历史对话就用自己的 agent 名（例如你是 Devin 就传 `devin`）；读其他 Agent 的对话同理换名字。会话 id 支持前缀匹配。内容默认截断 30000 字符。

典型用法：
- **【先查后做·最重要】** 用户提到其他 Agent、其他项目、某个目录/仓库的来历、之前的方案或结论，或任务需要复用别人做过的工作时——**先 `conversations_search` 搜遍会话再动手**，不要直接去文件系统里翻/猜或从零重做；搜不到再 `memory_search` 查共享记忆库。这是本 skill 存在的首要原因
- 用户说"继续之前那个对话/看看 hermes 昨天聊了什么/上次 codex 做了什么"→ `conversations_list` 找 id → `conversation_read` 读内容 → 接着上下文继续工作
- 用户说"之前是不是研究过 XX/找一下关于 YY 的讨论"→ `conversations_search` 一把搜全部 Agent 的会话，拿到 agent+id 再 `conversation_read` 细读
- 完成有沉淀价值的任务后 → `memory_save` 写一条笔记（标题+结论+标签）；之后任何 Agent 都能 `memory_search` 找到，实现跨 Agent/跨会话的记忆继承

共享记忆库：`~/.agent-manager/memory.jsonl`（追加写，按 agent/tag 可过滤）。注意控制写入频率，只存值得长期复用的结论，不要把过程日志当记忆写。

数据覆盖：hermes/devin/codex 有完整会话内容（codex 读 `~/.codex/sessions` 的 rollout 文件）；workbuddy 只有任务元数据；claude/cursor/windsurf/gemini 无本地会话存储。

## 4. 任务编排器（长程任务 / 子 Agent）

Agent Manager 内置编排器，把复杂目标自动拆成子任务、派发给子 Agent、辩论、验收、自动续步。访问方式：

- **UI**：http://localhost:3100 →「任务编排」页创建/查看任务
- **REST API**：`http://localhost:3100/api/orchestrator/*`
  - `GET /api/orchestrator/config` — 查看开关（总开关/跨client/自动续步）
  - `GET /api/orchestrator/tasks` — 任务列表
  - `POST /api/orchestrator/tasks` — `{goal, workdir?}` 创建任务
  - `GET /api/orchestrator/tasks/:id` — 任务详情+步骤+日志
  - `POST /api/orchestrator/tasks/:id/{pause,resume,cancel}` — 控制
  - `PUT /api/orchestrator/config` — 改开关
- 当前可用的 worker 只有 Hermes（`hermes -z`）；Codex/Devin 需要先 CLI 登录。规划与验收固定用本地 Hermes complex 模型，**不来回切换模型**。
- 子 Agent 当前可跨 Client（Hermes/Codex/Devin CLI），是否启用由用户的「跨 Client」开关决定；辩论步骤会派两个 Agent 正反方再综合。

## 5. Agent Manager 总览

- 体检页：8 个 Agent（WorkBuddy/Codex/Devin/Windsurf/Claude/Cursor/Gemini/Hermes）的 MCP 与 skill 盘点
- MCP/skill 变更自动同步（fs.watch 事件驱动，无轮询）
- 保活：launchd 守护 agent-manager(:3100)、mcphub(:3000)、15 分钟 MCP 健康监控+故障通知

## 使用原则

1. 涉及"别的 Agent/别的对话/之前做过的事/以前的结论"→ 优先用 agent-bridge 查证（会话搜索或共享记忆），不要凭猜测回答
2. 长程/多步骤/需要多角色协作的任务 → 建议用户用编排器，或在被允许时通过 API 创建编排任务
3. 完成有复用价值的任务 → `agent-bridge-memory_save` 沉淀结论，供其他 Agent 继承
4. MCP/skill 缺失时先查网关状态，别重复造轮子
