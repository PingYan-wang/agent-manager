# LLM 智能路由

[← 返回 README](../README.md)

<p align="center"><img src="screenshots/router.png" width="760" alt="自动路由面板"/></p>

一个 OpenAI 兼容的本地代理（`router/router.mjs`，监听 `127.0.0.1:8788`）。每个请求先由**分类器**判断任务等级，再路由到对应上游。

## 路由分级

| 路由 | 适用场景 | 默认模型 |
|---|---|---|
| `simple` | 闲聊、问答、翻译、天气新闻 | deepseek-v4.1-flash |
| `coding` | 写代码、跑命令、文件操作、MCP 工具调用 | kimi-k3.1-pro |
| `complex` | 架构设计、复杂分析、规划 | claude-opus-5-5 |
| `expert` | 手动指定的最高难度任务 | claude-fable-5-2 |

路由、模型、备选链均可在 UI 中自定义，也可新增路由（如 `fast` / `vision`）。

## 核心机制

- **分类器双模式**：云端小模型（默认，复用已有上游，零部署）或本地 Ollama 小模型（UI 一键 `ollama pull`，完全离线）；可探测各上游 `/models` 列表直接选
- **会话粘性**：同一会话内的追问（"继续 / 好的 / ok"）不降级，保住 prompt 缓存和上下文
- **工具意图覆盖**：提醒 / 邮件 / PDF / 截图等任务直接确定性路由到 coding，不依赖分类器猜
- **多级 fallback**：主模型失败依次尝试备选链，可跨上游混合（`model | baseUrl | apiKey`）
- **预算熔断**：按上游 host 设每日预算（`usd` 按量计费 / `requests` 包月订阅），超限自动跳过走兜底
- **热重载**：UI 保存即生效（`/admin/reload`），改动前自动备份；API Key 脱敏显示、留空不覆盖
- **自定义厂商**：添加任意 OpenAI 兼容厂商（名称 + baseUrl + Key）
- **Agent 一键接入**：一键把 Hermes 切到 `model=auto`；其他 Agent 把 Base URL 改为反代入口即可（总开关可关）

## 配置

```bash
mkdir -p ~/.hermes/router
cp router/config.example.json ~/.hermes/router/config.json
node router/router.mjs
```

| 字段 | 说明 |
|---|---|
| `routes.<name>` | `baseUrl` / `apiKey` / `model` / `fallbacks[]` |
| `classifier.mode` | `cloud`（默认）或 `local`（Ollama） |
| `classifier.route` / `classifier.model` | 云端分类器继承的路由与模型 |
| `budgets.<host>` | `{ "usd": 20 }` 或 `{ "requests": 5000 }` |
| `upstreamTimeoutMs` | 上游超时（默认 600s，兼容慢速推理模型） |

## 相关

- [反向代理](proxy.md) · [用量看板](dashboard.md)
