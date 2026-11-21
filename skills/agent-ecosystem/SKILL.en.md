---
name: agent-ecosystem
description: Unified capability entry point for the local Agent ecosystem. Use when the user mentions other agents' conversations/history, MCP services, skill management, task orchestration/sub-agents/long-running task decomposition. Provides usage for cross-system and same-system session reading, MCP gateway, skill sync, and the task orchestrator.
---

[English](SKILL.en.md) · [中文](SKILL.md)

# Agent Ecosystem Capabilities

A local Agent management layer (Agent Manager, http://localhost:3100) is running on this machine, connecting and sharing capabilities across multiple AI agents. **Do not assume you can only see the current conversation** — the capabilities below are available by default.

## 1. Cross-MCP access (MCPHub gateway)

All MCP servers are unified under `http://localhost:3000/mcp` (streamable HTTP). Your agent is already configured to connect to the gateway; every tool registered in it is directly visible to you — no extra setup needed.

- Tool sources include: WorkBuddy connectors (Tencent Docs with 240 tools, ima-mcp with 9 tools, lighthouse-ops with 60 tools, etc.), Codex, and any MCP newly installed in any agent — **newly installed servers sync into the gateway automatically** (file changes take effect within ~3 seconds)
- **Do not reinstall capabilities already in the gateway**: for example, ima, Tencent Docs, and lighthouse are already connected in the gateway — you can use the `mcp__mcphub__workbuddy_*` tool family directly. When the user asks to "use ima/Tencent Docs", check gateway tools first; don't run `hermes mcp add` or install a third-party MCP with the same name
- Note on stdio MCP cold starts: uvx/uv-based servers need to download dependencies on first run and may time out; prefer reusing already-connected gateway services
- Check MCP status/tool lists: gateway service catalog at `~/.agent-manager/gateway-catalog.md` (names/status/tool counts, auto-updated on gateway changes); or open http://localhost:3100 → "MCP Services" page
- When unsure whether a capability is already connected, **read gateway-catalog.md first before deciding to install** — it most likely already exists in the gateway (e.g. ima, Tencent Docs, lighthouse)
- When an MCP tool is "not found": first confirm whether it is connected in the gateway, then consider asking the user to restart the agent session to refresh the tool list

## 2. Unified skill sync

All installed skills on this machine are automatically symlinked into **every agent's native skills directory**. The skill list you see is the complete set; if a skill "should exist but isn't visible", suggest the user go to http://localhost:3100 → "Installed Skills" and click "Sync all skills to all agents".

## 3. Session reading / conversation inheritance / shared memory (agent-bridge MCP)

Access session records and shared memory of agents on this machine via MCP tools — **including your own agent's history conversations** (conversation inheritance) and other agents' conversations (cross-system).

Tools (prefix `agent-bridge-`):

| Tool | Purpose |
|---|---|
| `agent-bridge-agents_list` | List which agents have readable local session stores |
| `agent-bridge-reuse_lookup` | **Check before acting**: searches other agents' conversations + shared memory + installed skills + past orchestrator tasks in one call; returns hits and `follow_up` actions. Params `query`, optional `limit`/`sources`, `agent` (who I am), `scope` (`self`/`others`/`all` to reuse your own past sessions vs other agents); REST: `curl "http://127.0.0.1:3199/reuse?q=...&agent=hermes&scope=all"` |
  - Conversation search supports fuzzy recall: partial Chinese works (e.g. "架构" matches "架构图"), English is case/order-insensitive — short fragments are enough.
| `agent-bridge-conversations_list` | List an agent's recent conversations (params `agent`, `limit`) |
| `agent-bridge-conversation_read` | Read a conversation's content (params `agent`, `id`, `max_chars`) |
| `agent-bridge-conversations_search` | **Keyword search across conversation content** (params `query`, optional `agent`=all, `limit`) — search first when unsure which conversation it is in |
| `agent-bridge-memory_save` | Write conclusions/notes into shared memory (params `agent`, `title`, `content`, `tags`) |
| `agent-bridge-memory_search` | Search shared memory (params `query`, optional `agent`, `limit`) |

`agent` parameter values: `hermes` / `devin` / `codex` / `workbuddy`, etc. To read **your own** history, use your own agent name (e.g. if you are Devin, pass `devin`); to read another agent's conversations, swap the name accordingly. Conversation ids support prefix matching. Content is truncated at 30000 characters by default.

Typical usage:
- **[Check before acting · most important]** When the user mentions other agents, other projects, the origin of a directory/repo, prior plans or conclusions, or you hit a problem/strange project and are unsure how to proceed — **call `reuse_lookup` first (one call covers conversations + memory + skills + past tasks)**, follow its `follow_up` hints; use `conversations_search` only for targeted follow-up; don't dig/guess in the filesystem or redo work from scratch; if nothing is found, `memory_search` the shared memory store. This is the primary reason this skill exists
- User says "continue that previous conversation / see what hermes talked about yesterday / what codex did last time" → `conversations_list` to find the id → `conversation_read` the content → continue working from that context
- User says "did we research XX before / find the discussion about YY" → `conversations_search` across all agents' conversations in one shot, get agent+id, then `conversation_read` for details
- After completing a task with reusable value → `memory_save` a note (title + conclusion + tags); any agent can later find it via `memory_search`, enabling cross-agent/cross-session memory inheritance

Shared memory store: `~/.agent-manager/memory.jsonl` (append-only, filterable by agent/tag). Control write frequency — only store conclusions worth long-term reuse; don't write process logs as memory.

### Direct REST calls (when no MCP client is available)

The bridge also exposes auth-free REST at `http://127.0.0.1:3199` (localhost only) — a single curl works, **no MCP handshake or token needed**:

```bash
curl -s "http://127.0.0.1:3199/search?q=keyword&limit=10"          # Cross-agent conversation search (result is a JSON string)
curl -s "http://127.0.0.1:3199/conversations?agent=hermes&limit=20"
curl -s "http://127.0.0.1:3199/conversation?agent=devin&id=history_xxx"
curl -s "http://127.0.0.1:3199/memory/search?q=keyword"
curl -s -X POST "http://127.0.0.1:3199/memory/save" -H 'Content-Type: application/json' \
  -d '{"agent":"devin","title":"...","content":"...","tags":["..."]}'
```

Responses are uniformly `{"ok":true,"result":"<JSON or text>"}`; the `result` field needs one more `JSON.parse`. The launchd service `com.agent-bridge` self-heals via KeepAlive.

Data coverage: hermes/devin/codex have full conversation content (codex reads rollout files under `~/.codex/sessions`); workbuddy only has task metadata; claude/cursor/windsurf/gemini have no local session store.

## 4. Task orchestrator (long-running tasks / sub-agents)

Agent Manager has a built-in orchestrator that automatically decomposes complex goals into subtasks, dispatches them to sub-agents, runs debates, verifies results, and auto-continues steps. Access methods:

- **UI**: http://localhost:3100 → "Task Orchestration" page to create/view tasks
- **REST API**: `http://localhost:3100/api/orchestrator/*`
  - `GET /api/orchestrator/config` — view switches (master switch / cross-client / auto-continue)
  - `GET /api/orchestrator/tasks` — task list
  - `POST /api/orchestrator/tasks` — `{goal, workdir?}` to create a task
  - `GET /api/orchestrator/tasks/:id` — task details + steps + logs
  - `POST /api/orchestrator/tasks/:id/{pause,resume,cancel}` — control
  - `PUT /api/orchestrator/config` — change switches
- Currently the only available worker is Hermes (`hermes -z`); Codex/Devin require CLI login first. Planning and verification are fixed to the local Hermes complex model — **no back-and-forth model switching**.
- Sub-agents can currently run cross-Client (Hermes/Codex/Devin CLI); whether this is enabled is determined by the user's "Cross-Client" switch; debate steps dispatch two agents for/against and then synthesize.

## 5. Agent Manager overview

- Health page: inventory of MCP and skills across 8 agents (WorkBuddy/Codex/Devin/Windsurf/Claude/Cursor/Gemini/Hermes)
- MCP/skill changes auto-sync (fs.watch event-driven, no polling)
- Keep-alive: launchd daemon keeps agent-manager(:3100), mcphub(:3000), and a 15-minute MCP health monitor + failure notifications running

## Usage principles

1. When the matter involves "other agents / other conversations / things done before / past conclusions" → verify with agent-bridge first (conversation search or shared memory); don't answer based on guesses
2. For long-running/multi-step/multi-role-collaboration tasks → suggest the user use the orchestrator, or create an orchestration task via the API when permitted
3. After completing a task with reuse value → `agent-bridge-memory_save` to persist the conclusion for other agents to inherit
4. When MCP/skills are missing, check gateway status first — don't reinvent the wheel
