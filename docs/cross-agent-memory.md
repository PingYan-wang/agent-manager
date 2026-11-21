[English](cross-agent-memory.en.md) · [中文](cross-agent-memory.md)

# 跨 Agent 对话与记忆继承

[← 返回 README](../README.md)

> 换一个 Agent，不用重讲一遍。Hermes 里聊过的方案，Codex 可以直接接着做；昨天 Devin 踩过的坑，今天 WorkBuddy 能搜到。

## 能力概览

Agent Manager 内置一个 MCP server **agent-bridge**（`tools/agent-bridge/bridge.py`），启动时自动注册进 MCPHub 网关。所有接入网关的 Agent 都能直接调用它的 7 个工具：

| 工具 | 作用 |
|---|---|
| `reuse_lookup` | **动手前先查**：一次搜遍其他 Agent 会话 + 共享记忆 + 已装 skill + 过往编排任务，返回命中与 `follow_up` 建议，让 Agent 复用别人的方案而不是从零开始；参数 `query`，可选 `limit`/`sources`/**`agent`**(我是谁)/**`scope`**(`self`=只查自己上次 / `others`=只看别人 / `all`=都查)；REST `GET /reuse?q=关键词&agent=hermes&scope=all` |
  - 会话检索支持模糊召回：中文写片段即可（如「架构」命中「架构图」），英文大小写/词序不敏感，不必写全查询。
| `agents_list` | 列出本机有会话记录可读的 Agent（Hermes / Devin / Codex / WorkBuddy） |
| `conversations_list` | 列出某个 Agent 的最近会话（id / 标题 / 时间） |
| `conversation_read` | 读取某个会话的完整内容（id 支持前缀匹配） |
| `conversations_search` | 按关键词搜索全部 Agent 的会话（标题 + 消息） |
| `memory_save` | 把结论 / 笔记写入共享记忆库 `~/.agent-manager/memory.jsonl` |
| `memory_search` | 搜索共享记忆库，可按来源 Agent 过滤 |

## 两种继承方式

**1. 会话继承（读原始对话）**：直接读取其他 Agent 的会话文件，适合"接着上次那个对话继续做"。

```text
用户 → Codex：接着 Hermes 昨天讨论的数据库迁移方案继续
Codex → conversations_search(query="数据库迁移") → 定位到 Hermes 会话
Codex → conversation_read(agent="hermes", id="...") → 拿到完整上下文，继续执行
```

**2. 记忆继承（读沉淀的结论）**：Agent 完成有价值的任务后主动 `memory_save`，其他 Agent 用 `memory_search` 检索——比读原始对话更省 token、更精准。

## 同系统与跨系统

- **同系统**：同一个 Agent 的不同会话之间互读（`agent` 参数填自己）
- **跨系统**：不同 Agent 之间互读，数据格式差异由 bridge 内的适配器统一（Hermes SQLite、Devin/Codex JSONL、WorkBuddy 本地库）

## 如何让 Agent 知道这个能力

两条路一起走，缺一条都会漏：

**1. 原生指令 / 记忆注入**（每次会话自动生效）。服务启动和每次 Agent 体检扫描后，Agent Manager 会把这些能力写进每个**已安装** Agent 的原生持久入口，并在文件里维护一段受管块（`[agent-manager:begin]` … `[agent-manager:end]`）：

| Agent | 入口文件 | 生效范围 |
|---|---|---|
| Codex | `~/.codex/AGENTS.md` | 全局 |
| Devin | `~/.config/devin/AGENTS.md`、`~/.config/devin/rules/agent-ecosystem.md` | 全局 |
| Claude Code | `~/.claude/CLAUDE.md` | 全局 |
| Gemini CLI | `~/.gemini/GEMINI.md` | 全局 |
| Windsurf | `~/.codeium/windsurf/memories/global_rules.md` | 全局 |
| WorkBuddy | `~/.workbuddy/AGENTS.md` | 全局 |
| Cursor | `~/.cursor/rules/agent-ecosystem.mdc` | 仅在项目目录内生效（用户级规则在 Cursor 自己的设置库里） |
| Hermes | `~/.hermes/memories/MEMORY.md` 里一条 `[agent-manager]` 记忆 | 全局（每轮注入） |

规矩：

- 只写扫描判定为**已安装**的 Agent，且其配置目录必须已存在——没装的不会被凭空创建目录或文件。
- 幂等：重复启动只更新受管块，不动用户在同一个文件里写的内容；段落不会重复堆叠。
- 受管块用纯文本分隔符而非 HTML 注释——注释里出现 `system` 之类字样会被 Hermes 的注入扫描整段拦成 `[BLOCKED]`，等于白写。
- 块里只写可核实的事实（面板地址、网关地址、检索方式），**不声称「已接入 / 已同步」**；真实接入状态以各 Agent 自己的 MCP 工具列表为准。
- 状态可查：`GET /api/ecosystem/bootstrap` 返回每个入口的 `detected / installed / stale / effective`；`POST` 同路径触发一次重新对账。

**2. 内置 Skill**：`skills/agent-ecosystem` 会被同步到每个 Agent 的原生 Skill 目录，它告诉 Agent："不要假设你只能看到当前对话"——遇到"之前/上次/另一个对话"之类的指代时，先搜索再回答。

## 相关

- [MCPHub 网关与路径复用](mcp-gateway.md)
- [Skill 统一同步](skills.md)
