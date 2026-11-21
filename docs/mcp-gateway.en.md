[English](mcp-gateway.en.md) · [中文](mcp-gateway.md)

# MCPHub Gateway and Path Reuse

[← Back to README](../README.md)

<p align="center"><img src="screenshots/mcp.png" width="760" alt="MCP services panel"/></p>

## One Address, All Agents Share Every Tool

The MCP servers configured by each agent on this machine (Hermes / WorkBuddy / Codex / Devin / Windsurf / Claude …) are automatically scanned and imported into the **MCPHub gateway** by Agent Manager. Afterwards every agent only needs to connect to a single address `http://localhost:3000/mcp` to use all tools.

- **Automatic sync**: when any agent installs a new MCP, file changes are detected and imported into the gateway within ~3 seconds (deduplicated: skips the gateway itself, disabled entries, and identical configs)
- **Gateway service catalog**: automatically generates `~/.agent-manager/gateway-catalog.md` (service name / status / tool count); agents check the catalog first when unsure whether a capability exists
- **Health monitoring**: `tools/mcp-monitor.js` periodically probes, auto-reloads on failure and sends macOS notifications
- **One-click import / reload / start-stop**: operate from the "MCP Services" page in the Web UI

## Path Reuse: Turning What Worked in One Conversation into a Capability for All Agents

This is one of the most valuable features of this project.

**Scenario**: in some conversation with Agent A you configured and used image generation (e.g. hooked up an image-generation MCP and figured out the correct parameters). A few days later, in a fresh conversation with Agent B, you say "generate an image for me".

**The traditional way**: Agent B knows nothing, searches again, installs again, and falls into the same traps again.

**With Agent Manager**:

```text
① Agent A configures the image-gen MCP ──(fs.watch auto-import)──▶ MCPHub gateway
② Agent B receives "generate an image"
③ Agent B checks the gateway catalog / conversations_search("生图") ──▶ finds that A's conversation used it and the gateway already has the tool
④ Agent B calls the same tool via MCPHub, reproducing A's invocation path (parameters, steps)
```

**In essence**: the "implementation path" of a conversation (which tools were installed + how they were called) is distilled in two places — **the tools themselves settle into MCPHub**, and **the usage settles into conversation records / shared memory**. Any agent that later faces a similar need can reuse it directly instead of starting from scratch.

The more you use it, the more capabilities accumulate in the gateway, and all agents grow stronger together.

## Getting Started

```bash
# MCPHub (optional dependency)
npm i -g @samanhappy/mcphub
```

When Agent Manager starts it automatically: registers agent-bridge, refreshes the gateway catalog, and lays the built-in Skills out to every agent.

## Related

- [Cross-Agent Conversations and Memory Inheritance](cross-agent-memory.en.md)
- [Unified Skill Sync](skills.en.md)
