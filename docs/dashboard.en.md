[English](dashboard.en.md) · [中文](dashboard.md)

# Usage Dashboard and Daily Inspection Report

[← Back to README](../README.md)

- **Drill-down into today's usage**: click simple / coding / complex / expert to see exactly which provider and model was used
- **Provider view**: one-click switch to aggregate usage per model grouped by upstream
- **7-day trend**: stacked bar chart per route, failures highlighted in red
- **Upstream balance / health**: cumulative spend and quota for each upstream
- **Daily inspection report**: launchd runs a timed summary every day of 24h routing distribution / failures / balances, with the complex model producing optimization suggestions and sending macOS notifications

## Keep-Alive

launchd keeps the Web UI / MCPHub / watchdog / health monitor alive — all with KeepAlive self-healing; everything resumes automatically after a Mac restart.

## Related

- [LLM Smart Routing](routing.en.md)
