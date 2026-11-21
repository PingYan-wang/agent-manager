[English](mcp-gateway.en.md) · [中文](mcp-gateway.md)

# MCPHub 网关与路径复用

[← 返回 README](../README.md)

<p align="center"><img src="screenshots/mcp.png" width="760" alt="MCP 服务面板"/></p>

## 一个地址，所有 Agent 共享全部工具

本机每个 Agent（Hermes / WorkBuddy / Codex / Devin / Windsurf / Claude …）各自配置的 MCP，会被 Agent Manager 自动扫描并导入 **MCPHub 网关**。之后所有 Agent 只需接入一个地址 `http://localhost:3000/mcp`，就能使用全部工具。

- **自动同步**：任何 Agent 新装一个 MCP，文件变更约 3 秒内被检测并导入网关（去重：跳过网关自身、已禁用、同配置）
- **网关服务目录**：自动生成 `~/.agent-manager/gateway-catalog.md`（服务名 / 状态 / 工具数），Agent 不确定有没有某能力时先查目录
- **健康监控**：`tools/mcp-monitor.js` 定时探测，故障自动重载并发 macOS 通知
- **一键导入 / 重载 / 启停**：在 Web UI「MCP 服务」页操作

## 路径复用：把一次对话的做法沉淀成全体 Agent 的能力

这是本项目最有价值的能力之一。

**场景**：你在 Agent A 的某个对话里配置并使用过"生图"（比如接入了一个生图 MCP，摸索出了正确参数）。几天后，你在 Agent B 的新对话里说"帮我生成一张图"。

**传统做法**：Agent B 一无所知，重新搜索、重新安装、重新踩一遍坑。

**在 Agent Manager 里**：

```text
① Agent A 配置生图 MCP ──(fs.watch 自动导入)──▶ MCPHub 网关
② Agent B 收到"生成一张图"
③ Agent B 查网关目录 / conversations_search("生图") ──▶ 发现 A 的对话用过、网关里已有该工具
④ Agent B 直接通过 MCPHub 调用同一个工具，复现 A 的调用路径（参数、步骤）
```

**本质**：一个对话里的"实现路径"（装了什么工具 + 怎么调用）被沉淀在两处——**工具本身沉淀进 MCPHub**，**用法沉淀进会话记录 / 共享记忆**。任何 Agent 后续遇到同类需求，都能直接复用，而不是从零开始。

用得越多，网关里沉淀的能力越多，所有 Agent 一起变强。

## 接入

```bash
# MCPHub（可选依赖）
npm i -g @samanhappy/mcphub
```

Agent Manager 启动时会自动：注册 agent-bridge、刷新网关目录、把内置 Skill 铺到所有 Agent。

## 相关

- [跨 Agent 对话与记忆继承](cross-agent-memory.md)
- [Skill 统一同步](skills.md)
