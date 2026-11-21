[English](cross-agent-memory.en.md) · [中文](cross-agent-memory.md)

# Cross-Agent Conversations and Memory Inheritance

[← Back to README](../README.md)

> Switch agents without repeating yourself. A plan discussed with Hermes can be picked up directly by Codex; a pitfall Devin hit yesterday can be found by WorkBuddy today.

## Capability Overview

Agent Manager ships a built-in MCP server **agent-bridge** (`tools/agent-bridge/bridge.py`), which is automatically registered into the MCPHub gateway at startup. All agents connected to the gateway can call its 6 tools directly:

| Tool | Purpose |
|---|---|
| `agents_list` | List agents on this machine with readable session records (Hermes / Devin / Codex / WorkBuddy) |
| `conversations_list` | List recent conversations of a given agent (id / title / time) |
| `conversation_read` | Read the full content of a conversation (id supports prefix matching) |
| `conversations_search` | Search conversations across all agents by keyword (title + messages) |
| `memory_save` | Write conclusions / notes into the shared memory store `~/.agent-manager/memory.jsonl` |
| `memory_search` | Search the shared memory store, optionally filtered by source agent |

## Two Kinds of Inheritance

**1. Conversation inheritance (reading raw conversations)**: directly read another agent's session files — good for "continue where the last conversation left off".

```text
User → Codex: pick up the database migration plan Hermes discussed yesterday
Codex → conversations_search(query="数据库迁移") → locate the Hermes session
Codex → conversation_read(agent="hermes", id="...") → get full context, keep going
```

**2. Memory inheritance (reading distilled conclusions)**: after completing a valuable task, an agent proactively calls `memory_save`; other agents retrieve with `memory_search` — more token-efficient and more precise than reading raw conversations.

## Within the Same System and Across Systems

- **Same system**: different sessions of the same agent can read each other (fill the `agent` parameter with itself)
- **Across systems**: different agents read each other; format differences are normalized by adapters inside bridge (Hermes SQLite, Devin/Codex JSONL, WorkBuddy local store)

## How Agents Learn About This Capability

The built-in Skill `skills/agent-ecosystem` is synced to every agent's native skill directory. It tells agents: "do not assume you can only see the current conversation" — when you encounter references like "before / last time / another conversation", search first and then answer.

## Related

- [MCPHub Gateway and Path Reuse](mcp-gateway.en.md)
- [Unified Skill Sync](skills.en.md)
