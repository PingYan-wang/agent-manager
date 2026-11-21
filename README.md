# Agent Manager

本机多 Agent 统一管理层（macOS · 中文 Web UI）。把 MCPHub、asm、各 Agent 的能力打通：

- **MCP 统一网关**：各 Agent（WorkBuddy/Codex/Devin/Windsurf/Claude/Cursor/Gemini/Hermes）里配置的 MCP 自动扫描、导入 MCPHub，所有接入 Agent 共享
- **Skill 全量同步**：本机已装 skill 自动 symlink 铺到每个 Agent 的原生 skill 目录
- **跨 Agent 会话桥**：`agent-bridge` MCP 工具，可读取任意 Agent（含自己）的历史会话
- **任务编排器**：目标自动拆解 → 派发子 Agent → 辩论/验收 → 自动续步（可开关、可跨 Client）
- **事件驱动同步**：fs.watch 监听配置变更，~3 秒自动同步，无轮询
- **保活**：launchd 守护 + 看门狗 + MCP 健康监控/故障通知
- **默认装配**：启动时自动注册 agent-bridge、同步内置 `agent-ecosystem` skill、向各 Agent 指令文件（AGENTS.md/CLAUDE.md 等）注入生态系统指针——新 Agent 开箱即知道网关能力

## 快速开始

```bash
git clone <repo> agent-manager && cd agent-manager
./install.sh          # 检查依赖、生成 config.json、安装 launchd 服务
```

然后打开 **http://localhost:3100**。

### 依赖

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 运行 server/orchestrator（推荐 22 LTS；native 模块兼容性更好） |
| `@samanhappy/mcphub` | MCP 网关，`npm i -g @samanhappy/mcphub`，默认端口 3000 |
| `agent-skill-manager` (asm) | skill 管理，`npm i -g agent-skill-manager` |
| python3 | agent-bridge MCP server（macOS 自带） |

### 配置

`install.sh` 会从 `config.example.json` 生成 `config.json`（已 gitignore，不会泄露）：

```json
{
  "port": 3100,
  "hubUrl": "http://localhost:3000",
  "hubKey": "mcphub_xxxx  ← 在 MCPHub Dashboard → Keys 创建",
  "hubDataDir": "~/mcphub",
  "asmBin": "~/.npm-global/bin/asm"
}
```

也支持环境变量覆盖：`PORT` / `MCPHUB_URL` / `MCPHUB_KEY` / `MCPHUB_DATA_DIR` / `ASM_BIN` / `AGENT_MANAGER_URL`。

> **限流**：Agent Manager 高频代理 MCPHub API，默认会触发其 600次/15min 限流。`install.sh` 已在 MCPHub 数据目录写入 `.env` 的 `API_RATE_LIMIT_MAX=0`（dotenv 生效，launchd 和手动启动都覆盖），仅 localhost 部署安全；如需保留限流改回数字即可。

### 各 Agent 接入网关

在每个 Agent 的 MCP 配置中添加：

```json
{ "mcphub": { "url": "http://localhost:3000/mcp",
              "headers": { "Authorization": "Bearer <hubKey>" } } }
```

`install.sh` 装的 launchd 服务会自动完成剩余工作（skill 铺链、指令注入、MCP 导入）。

## 目录结构

```
server.js            # HTTP 服务 + API + fs.watch 自动同步 + 默认装配
orchestrator.js      # 任务编排引擎（规划/派发/辩论/验收/续步）
config.js            # 配置加载（env > config.json > 默认）
public/index.html    # 中文 Web UI（暖纸编辑风）
skills/agent-ecosystem/  # 内置 skill：生态系统能力说明书
tools/
  agent-bridge/bridge.py   # 跨 Agent 会话读取 MCP server
  decrypt-wb-creds.js      # WorkBuddy 连接器凭据解密（可选，仅 WorkBuddy 用户）
  wb-cred-sync.js          # WorkBuddy 凭据→MCPHub 注入 + token 续期
  inject-wb-auth.js        # 凭据注入工具
  mcp-monitor.js           # MCP 健康监控/修复/macOS 通知
  watchdog.sh              # launchd 保活看门狗
launchd/              # launchd plist 模板（install.sh 替换路径后安装）
config.example.json   # 配置模板
gateway-catalog.md    # 运行时生成（~/.agent-manager/），网关服务清单
```

## launchd 服务

`install.sh` 安装 5 个服务（`~/Library/LaunchAgents/`）：

| 服务 | 作用 |
|---|---|
| `com.agent-manager` | Web UI :3100，KeepAlive 自愈 |
| `com.mcphub` | MCP 网关 :3000，KeepAlive 自愈（默认 `API_RATE_LIMIT_MAX=0` 关闭限流，仅限 localhost） |
| `com.agent-watchdog` | 每 60s HTTP 探活，挂了 kickstart |
| `com.wb-mcphub-auth` | 每 15min WorkBuddy 凭据同步（无 WorkBuddy 可不装） |
| `com.mcp-monitor` | 每 15min MCP 健康检查 + 故障通知 |

## 编排器说明

- 开关在 UI「任务编排」页：总开关 / 跨 Client 子 Agent / 自动续步
- 规划与验收固定走 `planner.baseUrl`（默认 Hermes 本地路由 `127.0.0.1:8788`，model `complex`），不来回切模型
- Worker 适配器在 `orchestrator.js` 的 `AGENT_WORKERS`：hermes(`-z`)、codex(`exec`)、devin(`-p`)；各家需先 CLI 登录
- 状态持久化 `~/.agent-manager/orchestrator.json`，重启不丢

## 安全说明

- `config.json` 含 MCPHub API Key，**勿提交/分享**（已 gitignore）
- `tools/decrypt-wb-creds.js` 逆向 WorkBuddy 本地加密存储，仅用于把用户自己的已授权凭据迁移到本机网关；请勿用于他人数据
- agent-bridge 只读访问本机 Agent 会话存储

## License

MIT
