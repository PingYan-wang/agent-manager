#!/usr/bin/env node
// MCP 健康监控 + 自动修复 + macOS 通知
// 每 5min 由 launchd 运行:
//   1. 拉取 MCPHub server 列表,找出异常(disconnected/error/oauth_required)
//   2. 自动修复: 先 reload;workbuddy-* 再跑 wb-cred-sync 重注凭据
//   3. 状态变化时发 macOS 通知(新故障/已恢复),持续故障只记录不重复轰炸
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
// 读取仓库根 config.json（不入库）+ 环境变量
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); } catch { return {}; }
}
const CFG = loadCfg();
const HUB_BASE = (process.env.MCPHUB_URL || CFG.hubUrl || 'http://localhost:3000').replace(/\/$/, '');
const HUB = HUB_BASE + '/api';
const KEY = process.env.MCPHUB_KEY || CFG.hubKey || '';
if (!KEY) { console.error('缺少 MCPHUB_KEY：请在 config.json 写 hubKey 或设环境变量 MCPHUB_KEY'); process.exit(1); }

const STATE_FILE = path.join(process.env.MCPHUB_DATA_DIR || path.join(os.homedir(), 'mcphub'), 'mcp-monitor-state.json');
const LOG = path.join(process.env.MCPHUB_DATA_DIR || path.join(os.homedir(), 'mcphub'), 'mcp-monitor.log');
const SYNC_SCRIPT = path.join(__dirname, 'wb-cred-sync.js');
const NODE = process.execPath;
const BAD = new Set(['disconnected', 'error', 'oauth_required', 'failed']);

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
};

const h = (p, o = {}) => fetch(`${HUB}${p}`, {
  ...o,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
}).then((r) => r.json()).catch((e) => ({ error: e.message }));

function notify(title, msg) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(msg)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { servers: {} }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 }); } catch {}
}

(async () => {
  const list = await h('/servers');
  const servers = Array.isArray(list.data) ? list.data : list.data?.data || [];
  const state = loadState();
  const now = Date.now();
  const bad = [], good = [];

  for (const s of servers) {
    if (s.enabled === false) continue;
    const st = s.status || 'unknown';
    (BAD.has(st) ? bad : good).push({ name: s.name, status: st, error: s.error });
  }

  // ---- 自动修复 ----
  // 只对「有可用凭据可重注」的 workbuddy 服务跑 wb-cred-sync,避免对无凭据的 oauth_required 空转
  let creds = {};
  try { creds = JSON.parse(fs.readFileSync(path.join(process.env.MCPHUB_DATA_DIR || path.join(os.homedir(), 'mcphub'), 'wb-headers.json'), 'utf8')); } catch {}
  const fixable = new Set();
  for (const conn of Object.keys(creds.headerOverrides || {})) fixable.add(`workbuddy-${conn}`.replace(/[^\w.-]/g, '_'));
  for (const t of Object.values(creds.mcpOAuth || {})) {
    if (t.serverName) fixable.add(`workbuddy-${t.serverName}`.replace(/[^\w.-]/g, '_'));
  }
  const wbBad = bad.filter((s) => s.name.startsWith('workbuddy-') && (fixable.has(s.name) || s.status !== 'oauth_required'));
  const otherBad = bad.filter((s) => !s.name.startsWith('workbuddy-'));

  // 1) 所有异常先 reload 一次
  for (const s of bad) {
    await h(`/servers/${encodeURIComponent(s.name)}/reload`, { method: 'POST', body: '{}' });
  }

  // 2) workbuddy-* 重新注入凭据(解密最新 + 续期 + PUT + reload)
  if (wbBad.length) {
    log('workbuddy servers unhealthy:', wbBad.map((s) => `${s.name}(${s.status})`).join(', '), '→ running wb-cred-sync');
    await new Promise((res) => execFile(NODE, [SYNC_SCRIPT], { timeout: 120000 }, (e) => { if (e) log('wb-cred-sync error:', e.message); res(); }));
  }

  // 3) 其他 server 只能 reload,持续失败则等人工
  for (const s of otherBad) log('non-workbuddy unhealthy:', s.name, s.status, String(s.error || '').slice(0, 120));

  // ---- 状态 diff → 通知 ----
  const prev = state.servers || {};
  const cur = {};
  const newFailures = [], recovered = [];

  for (const s of bad) {
    cur[s.name] = { status: s.status, since: prev[s.name]?.since || now, error: String(s.error || '').slice(0, 200), attempts: (prev[s.name]?.attempts || 0) + 1 };
    if (!prev[s.name] || !BAD.has(prev[s.name].status)) newFailures.push(s);
  }
  for (const s of good) {
    if (prev[s.name] && BAD.has(prev[s.name].status)) recovered.push(s.name);
    cur[s.name] = { status: s.status, since: now };
  }
  // 清理已删除 server 的状态
  const alive = new Set(servers.map((s) => s.name));
  for (const k of Object.keys(cur)) if (!alive.has(k)) delete cur[k];

  state.servers = cur;
  state.lastRun = now;
  saveState(state);

  if (newFailures.length) {
    const names = newFailures.map((s) => s.name).join(', ');
    notify('MCP 服务异常', `${names} 连接失败，已尝试自动修复`);
    log('NOTIFY new failures:', names);
  }
  if (recovered.length) {
    notify('MCP 服务恢复', `${recovered.join(', ')} 已恢复连接`);
    log('NOTIFY recovered:', recovered.join(', '));
  }
  if (!bad.length && !newFailures.length) log('all healthy:', servers.length, 'servers');
})();
