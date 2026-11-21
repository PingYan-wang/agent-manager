[English](dashboard.en.md) · [中文](dashboard.md)

# 用量看板与巡检日报

[← 返回 README](../README.md)

- **今日用量下钻**：点 simple / coding / complex / expert 查看具体用了哪个服务商的哪个模型
- **服务商视图**：一键切换，按上游聚合各模型用量
- **7 天趋势**：各路线堆叠柱状图，失败数标红
- **上游余额 / 健康**：各上游累计消耗与额度
- **每日巡检日报**：launchd 每天定时汇总 24h 路由分布 / 失败 / 余额，由 complex 模型产出优化建议并发 macOS 通知

## 保活

launchd 守护 Web UI / MCPHub / 看门狗 / 健康监控，全部 KeepAlive 自愈，重启 Mac 自动恢复。

## 相关

- [LLM 智能路由](routing.md)
