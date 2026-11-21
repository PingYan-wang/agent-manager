#!/bin/bash
# Agent Manager 安装脚本（macOS）
# 用法: ./install.sh [--no-launchd] [--with-mcphub] [--admin-pass PASS]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME"
HUB_DATA="$HOME_DIR/mcphub"
NO_LAUNCHD=0; WITH_MCPHUB=0; ADMIN_PASS=""
for arg in "$@"; do
  case "$arg" in
    --no-launchd) NO_LAUNCHD=1 ;;
    --with-mcphub) WITH_MCPHUB=1 ;;
    --admin-pass) shift_next=1 ;;
    --admin-pass=*) ADMIN_PASS="${arg#*=}" ;;
  esac
done
# 处理 --admin-pass PASS 形式
prev=""
for arg in "$@"; do [ "$prev" = "--admin-pass" ] && ADMIN_PASS="$arg"; prev="$arg"; done

echo "==> Agent Manager 安装  根目录: $ROOT"

# ---- 依赖检查 ----
command -v node >/dev/null || { echo "需要 Node.js >= 18，未找到"; exit 1; }
NODE_VER=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_VER" -ge 18 ] || { echo "Node.js >= 18 required (当前 $(node -v))"; exit 1; }
command -v python3 >/dev/null || { echo "需要 python3（agent-bridge 用）"; exit 1; }
echo "    node $(node -v)  python3 $(python3 -V 2>&1 | awk '{print $2}')"

if [ $WITH_MCPHUB -eq 1 ]; then
  npm i -g @samanhappy/mcphub
fi
command -v asm >/dev/null || echo "    提示: 未检测到 asm，将尝试 npm i -g agent-skill-manager"
if ! command -v asm >/dev/null; then
  read -r -p "    现在安装 agent-skill-manager? [Y/n] " ans
  [ "${ans:-Y}" != "n" ] && npm i -g agent-skill-manager || true
fi

# ---- config.json ----
if [ ! -f "$ROOT/config.json" ]; then
  ASM_BIN="$(command -v asm 2>/dev/null || echo "$HOME_DIR/.npm-global/bin/asm")"
  cat > "$ROOT/config.json" <<EOF
{
  "port": 3100,
  "hubUrl": "http://localhost:3000",
  "hubKey": "PASTE_YOUR_MCPHUB_KEY_HERE",
  "hubDataDir": "$HUB_DATA",
  "asmBin": "$ASM_BIN"
}
EOF
  echo "==> 已生成 config.json —— 请把 hubKey 改成 MCPHub Dashboard → Keys 里创建的 Key"
else
  echo "==> config.json 已存在，跳过"
fi

# ---- 运行时目录 ----
mkdir -p "$HOME_DIR/.agent-manager" "$HUB_DATA"

# ---- MCPHub 默认配置：本机部署关闭 API 限流（dotenv 读取，launchd 外运行也生效）----
HUB_ENV="$HUB_DATA/.env"
touch "$HUB_ENV"
if ! grep -q '^API_RATE_LIMIT_MAX=' "$HUB_ENV"; then
  echo "API_RATE_LIMIT_MAX=0" >> "$HUB_ENV"
  echo "==> $HUB_ENV 已写入 API_RATE_LIMIT_MAX=0（本机无限流）"
fi

# ---- launchd ----
if [ $NO_LAUNCHD -eq 0 ]; then
  NODE_BIN="$(command -v node)"
  NODE_DIR="$(dirname "$NODE_BIN")"
  NPM_BIN="$(npm prefix -g 2>/dev/null)/bin"; [ -d "$NPM_BIN" ] || NPM_BIN="$HOME_DIR/.npm-global/bin"
  MCPHUB_PKG="$(npm root -g 2>/dev/null)/@samanhappy/mcphub"
  [ -d "$MCPHUB_PKG" ] || MCPHUB_PKG=""
  ADMIN_PASS="${ADMIN_PASS:-$(openssl rand -hex 4)}"

  LA_DIR="$HOME_DIR/Library/LaunchAgents"
  mkdir -p "$LA_DIR"
  for tpl in "$ROOT"/launchd/*.plist; do
    name="$(basename "$tpl")"
    label="${name%.plist}"
    out="$LA_DIR/$name"
    sed -e "s|__ROOT__|$ROOT|g" \
        -e "s|__HOME__|$HOME_DIR|g" \
        -e "s|__NODE__|$NODE_BIN|g" \
        -e "s|__NODE_DIR__|$NODE_DIR|g" \
        -e "s|__NPM_BIN__|$NPM_BIN|g" \
        -e "s|__HUB_DATA__|$HUB_DATA|g" \
        -e "s|__MCPHUB_PKG__|$MCPHUB_PKG|g" \
        -e "s|__ADMIN_PASSWORD__|$ADMIN_PASS|g" \
        "$tpl" > "$out"
    # mcphub 未安装则跳过其 plist
    if [ "$label" = "com.mcphub" ] && [ -z "$MCPHUB_PKG" ]; then
      rm -f "$out"; echo "    跳过 com.mcphub（未安装 @samanhappy/mcphub，用 --with-mcphub 重装）"; continue
    fi
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$out" 2>/dev/null || launchctl load "$out"
    echo "    launchd: $label"
  done
  echo "==> MCPHub admin 密码: $ADMIN_PASS （请记录，仅保存在 plist 中）"
else
  echo "==> 跳过 launchd（--no-launchd）。手动运行: node $ROOT/server.js"
fi

cat <<EOF

完成。下一步：
  1. 编辑 $ROOT/config.json 填入 hubKey
  2. 若未装 MCPHub: npm i -g @samanhappy/mcphub && cd $HUB_DATA && mcphub start
     然后在 Dashboard (http://localhost:3000) → Keys 创建 API Key
  3. 打开 http://localhost:3100
EOF
