#!/bin/bash
# 看门狗：每 60s 检查 agent-manager(:3100) 与 mcphub(:3000)，无响应则 kickstart 重启
UID_=$(id -u)
check() {
  local name="$1" url="$2"
  if ! curl -sf -m 5 -o /dev/null "$url"; then
    echo "[$(date '+%F %T')] $name 无响应，重启中"
    launchctl kickstart -k "gui/$UID_/$name" 2>/dev/null || true
  fi
}
check com.agent-manager http://localhost:3100/
check com.mcphub http://localhost:3000/health
