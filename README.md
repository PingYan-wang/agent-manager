# Agent Manager

**本机多 Agent 统一管理 + LLM 智能路由网关**（macOS · 中文 Web UI · 零依赖 Node.js）

> 一句话：让你电脑上所有 AI Agent（Hermes / WorkBuddy / Codex / Devin / Windsurf / Claude …）共用一套 MCP、Skill 和模型路由——**简单问题走便宜模型，复杂任务才上贵模型，每一分钱花在刀刃上**。

---

## 它解决什么问题

现代 AI 工作流常见的三个痛点：

1. **模型订阅碎片化**：DeepSeek、Kimi、Claude、GPT、Gemini 各自为政，手动切换、手动挑模型，又贵又费事
2. **成本失控**：所有请求默认走最强（也最贵）的模型，闲聊也按 Opus 价格计费
3. **Agent 配置孤岛**：MCP、Skill、会话记录散落在各家目录里，换工具就要重新配置

Agent Manager 用一个本地 Web 面板把这些全部收拢：

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Manager :3100                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ 自动路由  │ │  反向代理  │ │ 任务编排  │ │ MCP/Skill │  │
│  │ 分级分流  │ │ 统一入口  │ │ 拆解验收  │ │  统一同步  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬──────┘  │
└───────┼────────────┼────────────┼─────────────┼─────────┘
        │            │            │             │
   ┌────▼────┐  ┌────▼────┐  ┌────▼─────┐  ┌────▼─────┐
   │ 各 LLM  │  │ 本地Agent│  │ 子Agent  │  │ MCPHub   │
   │ 上游    │  │ 服务    │  │ hermes/  │  │ 网关:3000│
   │ 火山/   │  │ hermes/ │  │ codex/   │  │ 共享工具 │
   │ Reverix │  │ mcphub… │  │ devin    │  │          │
   └─────────┘  └─────────┘  └──────────┘  └──────────┘
```

---

## 核心功能

### 🧭 自动路由（本项目的招牌）

一个 OpenAI 兼容的本地代理（默认 `127.0.0.1:8788`），每个请求先由**分类器**判断任务等级，再路由到对应上游：

| 路由 | 适用场景 | 默认模型 | 成本 |
|---|---|---|---|
| `simple` | 闲聊、问答、翻译、天气新闻 | deepseek-v4.1-flash（火山） | 极低 |
| `coding` | 写代码、跑命令、文件操作、MCP 工具调用 | kimi-k3.1-pro（火山 Coding Plan 包月） | 包月内免费 |
| `complex` | 架构设计、复杂分析、规划 | claude-opus-5-5（Reverix 按量） | 按量 |
| `expert` | 手动指定的最高难度任务 | claude-fable-5-2 | 按量 |

- **分类器双模式**：云端小模型（默认，复用已有上游，零部署）或本地 Ollama 小模型（UI 一键下载 `ollama pull`，完全离线）
- **会话粘性**：同一会话内的追问（"继续/好的/ok…"）不降级，保持同一模型，保住 prompt 缓存、不丢上下文
- **工具意图关键词覆盖**：提醒/邮件/PDF/截图等任务直接确定性路由到 coding，不依赖分类器猜
- **多级 fallback**：主模型失败自动依次尝试备选链，可跨上游混合
- **预算熔断**：按上游 host 设置每日预算（USD 或请求数），超限自动跳过走兜底——**Reverix 按量计费永不失控**
- **热重载**：Web UI 改配置即时生效，无需重启；API Key 脱敏显示、留空不覆盖
- **Agent 一键接入**：一键把 Hermes 等 Agent 切到 `model=auto`，其他 Agent 填统一入口即可；总开关可关

### 🔀 反向代理

内置 `/px/<id>/` 前缀反代（HTTP + WebSocket，SSE 流式透传）：

- 一键代理本机所有 Agent 服务（hermes / mcphub / ollama / 任意端口），增删改、启停、健康探测、端口扫描
- **LLM 路由联动**：`http://127.0.0.1:3100/px/router/v1` 是所有 Agent 共用的模型入口，请求自动走智能路由——任何支持 OpenAI 兼容接口的工具改这一个地址即可

### 🎼 任务编排器

自然语言目标 → 自动拆解 → 子 Agent 执行 → 验收 → 返工/人工裁决 → 自动续步：

- planner 固定走 complex 路由（不来回切模型），拆解为带依赖的步骤图
- Worker 适配器：hermes(`-z`)、codex(`exec`)、devin(`-p`)，各家 CLI 登录后即用
- 验收失败自动返工（≤3 轮）；仍失败转入 **awaiting_review 人工裁决**：通过 / 再返工 / 终止，24h 超时自动终止
- **自动续步**：任务完成后自动规划下一步优化（上限可配），实现"目标驱动的持续保活"
- 并行派发（默认 2 并发）、正反辩论模式（needsDebate）、状态持久化重启不丢

### 📊 用量看板与巡检日报

- **今日用量下钻**：点 simple/coding/complex/expert 看具体用了哪个服务商的哪个模型；一键切换「服务商视图」按上游聚合
- **7 天趋势图**：各路线堆叠柱状图，失败数标红
- **上游余额**：Reverix 累计消耗、WorkBuddy 账号额度、火山欠费推断
- **每日巡检日报**：launchd 每天 21:00 自动汇总 24h 路由分布/失败/余额，让 complex 模型产出不超过 8 条优化建议，macOS 通知提醒——**系统自己会体检并告诉你哪里该优化**

### 🔌 MCP / Skill 统一生态

- 各 Agent 配置的 MCP 自动扫描、导入 MCPHub，所有 Agent 共享一套工具
- Skill 全量 symlink 铺到每个 Agent 的原生目录，跨 Agent 会话桥可读取任意 Agent 历史
- 事件驱动同步（fs.watch，~3 秒），MCP 健康监控 + 故障自动修复/通知

### 💓 保活

launchd 守护 Web UI / MCPHub / 看门狗 / 凭据同步 / 健康监控，全部 KeepAlive 自愈，重启 Mac 自动恢复。

---

## 快速开始

### 依赖

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18（推荐 22 LTS） | 运行全部服务 |
| python3 | agent-bridge MCP server（macOS 自带） |
| `@samanhappy/mcphub` | MCP 网关（可选，`npm i -g`） |
| `agent-skill-manager` (asm) | skill 管理（可选，`npm i -g`） |
| Ollama（可选） | 本地分类器/小模型，`brew install ollama` |

### 安装

```bash
git clone https://github.com/PingYan-wang/agent-manager.git && cd agent-manager
./install.sh            # 检查依赖、生成 config.json、安装 launchd 服务
```

打开 **http://localhost:3100**。

### 接入自动路由（可选但推荐）

```bash
mkdir -p ~/.hermes/router
cp router/config.example.json ~/.hermes/router/config.json
# 编辑 config.json 填入你的上游 API Key（或在 Web UI「自动路由 → 路由配置」里在线填写）
node router/router.mjs &   # 或自行用 launchd/systemd 托管
```

然后在 UI「自动路由 → Agent 接入」一键把 Hermes 切到自动路由；其他 Agent 把 Base URL 改为 `http://127.0.0.1:3100/px/router/v1`（经反代）或 `http://127.0.0.1:8788/v1`（直连）即可。

---

## 配置参考

### `config.json`（Agent Manager 主配置，install.sh 生成）

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | 3100 | Web UI 端口 |
| `hubUrl` / `hubKey` | localhost:3000 | MCPHub 地址与 API Key |
| `asmBin` | `~/.npm-global/bin/asm` | skill 管理器路径 |

### `~/.hermes/router/config.json`（路由器配置）

| 字段 | 说明 |
|---|---|
| `routes.<name>` | 路由定义：`baseUrl` / `apiKey` / `model` / `fallbacks[]`（可跨上游） |
| `classifier.mode` | `cloud`（默认，复用路由上游）或 `local`（Ollama） |
| `classifier.route` / `classifier.model` | 云端分类器继承的路由与模型（model 留空跟随） |
| `classifierModel` / `ollamaUrl` | 本地分类器模型与 Ollama 地址 |
| `budgets.<host>` | 每日预算：`{ "usd": 20 }`（按量计费）或 `{ "requests": 5000 }`（包月订阅），超限自动走兜底 |
| `upstreamTimeoutMs` | 上游超时（默认 600s，兼容慢速推理模型） |

改动可在 UI「路由配置」在线完成（保存即热重载，自动备份，Key 脱敏）。

---

## API 概览

| 端点 | 说明 |
|---|---|
| `GET/PUT /api/router/config` | 路由配置读取（脱敏）/保存（热重载） |
| `GET /api/router/status` `/stats` `/balance` `/trend` `/model-usage` | 路由器健康、用量、余额、趋势、下钻明细 |
| `GET/POST /api/router/local-models` `/pull` | Ollama 本地模型列表/下载 |
| `GET/PUT /api/router/agent-apply` · `POST /agents/apply` | Agent 接入开关与一键接入 |
| `GET /api/proxy/*` | 反代条目增删改、启停、端口扫描 |
| `GET/POST /api/orchestrator/tasks` · `POST .../review` | 编排任务与人工裁决（pass/retry/abort） |
| `GET /api/router/digests` `/digest` | 巡检日报列表/详情 |

完整 API 见 `server.js` 路由表。

---

## 目录结构

```
server.js               # HTTP 服务 + 全部 API + fs.watch 自动同步
orchestrator.js         # 任务编排引擎（规划/派发/验收/返工/人工裁决/续步）
config.js               # 配置加载（env > config.json > 默认）
public/index.html       # 中文 Web UI（自动路由/反代/编排/看板/MCP 市场）
router/
  router.mjs            # LLM 智能路由代理（OpenAI 兼容，:8788）
  config.example.json   # 路由配置模板（填入你的 Key 后放到 ~/.hermes/router/）
skills/agent-ecosystem/ # 内置 skill：生态系统能力说明书
tools/
  agent-bridge/         # 跨 Agent 会话读取 MCP server
  mcp-monitor.js        # MCP 健康监控/修复/macOS 通知
  watchdog.sh           # launchd 保活看门狗
  wb-cred-sync.js       # WorkBuddy 凭据→MCPHub 注入（可选）
launchd/                # launchd plist 模板
config.example.json     # 主配置模板
```

## launchd 服务

`install.sh` 安装 5 个服务（`~/Library/LaunchAgents/`）：Web UI、MCPHub、HTTP 探活看门狗、WorkBuddy 凭据同步（可选）、MCP 健康监控。路由器可用同样方式托管：`node router/router.mjs` 配 KeepAlive plist 即可。

## 安全说明

- `config.json` / `~/.hermes/router/config.json` 含 API Key，**均已 gitignore / 不入库**，示例文件只有占位符
- 路由器仅监听 `127.0.0.1`，反代同样仅本机；不要暴露到公网
- 预算熔断建议对所有按量计费上游设置 `budgets.usd` 上限
- `tools/decrypt-wb-creds.js` 仅用于迁移用户自己的已授权凭据，请勿用于他人数据

## Roadmap

- [ ] 路由质量指标看板（任务成功率/返工次数/token 成本）
- [ ] per-deployment cooldown + 指数退避（故障上游自动摘除）
- [ ] verify 独立 agent 验收（消除 planner 自评偏差）
- [ ] 编排 worker 角色化配置（researcher/reviewer/tester）
- [ ] RouteLLM 本地路由模型（用积累的分类数据微调，进一步降本）

## License

MIT
