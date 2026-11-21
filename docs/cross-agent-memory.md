[English](cross-agent-memory.en.md) · [中文](cross-agent-memory.md)

# 跨 Agent 对话与记忆继承

[← 返回 README](../README.md)

> 换一个 Agent，不用重讲一遍。Hermes 里聊过的方案，Codex 可以直接接着做；昨天 Devin 踩过的坑，今天 WorkBuddy 能搜到。

## 能力概览

Agent Manager 内置一个 MCP server **agent-bridge**（`tools/agent-bridge/bridge.py`），启动时自动注册进 MCPHub 网关。所有接入网关的 Agent 都能直接调用它的 6 个工具：

| 工具 | 作用 |
|---|---|
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

内置 Skill `skills/agent-ecosystem` 会被同步到每个 Agent 的原生 Skill 目录，它告诉 Agent："不要假设你只能看到当前对话"——遇到"之前/上次/另一个对话"之类的指代时，先搜索再回答。

## 相关

- [MCPHub 网关与路径复用](mcp-gateway.md)
- [Skill 统一同步](skills.md)
