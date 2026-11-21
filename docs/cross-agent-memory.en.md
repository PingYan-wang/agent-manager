[English](cross-agent-memory.en.md) · [中文](cross-agent-memory.md)

# Cross-Agent Conversations and Memory Inheritance

[← Back to README](../README.md)

> Switch agents without repeating yourself. A plan discussed with Hermes can be picked up directly by Codex; a pitfall Devin hit yesterday can be found by WorkBuddy today.

## Capability Overview

Agent Manager ships a built-in MCP server **agent-bridge** (`tools/agent-bridge/bridge.py`), which is automatically registered into the MCPHub gateway at startup. All agents connected to the gateway can call its 6 tools directly:

| Tool | Purpose |
|---|---|
| `reuse_lookup` | **Check before acting**: one-shot search across other agents' conversations + shared memory + installed skills + past orchestrator tasks; returns ranked hits and `follow_up` actions so agents reuse prior solutions instead of starting over. Params `query`, optional `limit`/`sources`/**`agent`**/**`scope`** (`self`/`others`/`all` — reuse your own agent's past sessions vs other agents'); REST `GET /reuse?q=...&agent=...&scope=...` |
  - Conversation search supports fuzzy recall: partial Chinese works (e.g. "架构" matches "架构图"), English is case/order-insensitive — short fragments are enough.
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

Two paths, and missing either one leaks:

**1. Native instruction / memory injection** (applies automatically every session). On startup and after every agent scan, Agent Manager writes these capabilities into each **installed** agent's native persistent entry point, maintaining a managed block (`[agent-manager:begin]` … `[agent-manager:end]`):

| Agent | Entry file | Scope |
|---|---|---|
| Codex | `~/.codex/AGENTS.md` | global |
| Devin | `~/.config/devin/AGENTS.md`, `~/.config/devin/rules/agent-ecosystem.md` | global |
| Claude Code | `~/.claude/CLAUDE.md` | global |
| Gemini CLI | `~/.gemini/GEMINI.md` | global |
| Windsurf | `~/.codeium/windsurf/memories/global_rules.md` | global |
| WorkBuddy | `~/.workbuddy/AGENTS.md` | global |
| Cursor | `~/.cursor/rules/agent-ecosystem.mdc` | project directories only (user-level rules live in Cursor's own settings store) |
| Hermes | one `[agent-manager]` entry in `~/.hermes/memories/MEMORY.md` | global (injected every turn) |

Rules:

- Only agents the scanner reports as **installed**, and only when their config directory already exists — nothing is created for agents you do not have.
- Idempotent: repeated startups only update the managed block, never touch content you wrote in the same file, and never stack duplicate sections.
- The managed block uses plain-text delimiters instead of HTML comments — a comment containing words like `system` gets the whole block replaced with `[BLOCKED]` by Hermes' injection scanner, which makes it worthless.
- The block only states verifiable facts (panel URL, gateway URL, how to search), and **never claims "already connected / already synced"**; actual connection status is whatever each agent's own MCP tool list shows.
- Inspect state: `GET /api/ecosystem/bootstrap` returns `detected / installed / stale / effective` per entry; `POST` on the same path forces a re-reconcile.

**2. Built-in Skill**: `skills/agent-ecosystem` is synced to every agent's native skill directory. It tells agents: "do not assume you can only see the current conversation" — when you encounter references like "before / last time / another conversation", search first and then answer.

## Related

- [MCPHub Gateway and Path Reuse](mcp-gateway.en.md)
- [Unified Skill Sync](skills.en.md)
