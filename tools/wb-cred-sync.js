#!/usr/bin/env node
// WorkBuddy → MCPHub 凭据同步（launchd 定时运行）
// 1. 重新解密 WorkBuddy 最新加密凭据（拿到 WorkBuddy 自己刷新后的最新 token）
// 2. lighthouse-ops 的 OAuth accessToken 仅 2h 有效：用 refresh_token 主动续期
// 3. 把 Authorization 头注入对应 MCPHub server 并 reload
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// 读取仓库根 config.json（不入库）+ 环境变量
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); } catch { return {}; }
}
const CFG = loadCfg();
const HUB_BASE = (process.env.MCPHUB_URL || CFG.hubUrl || 'http://localhost:3000').replace(/\/$/, '');
const HUB = HUB_BASE + '/api';
const KEY = process.env.MCPHUB_KEY || CFG.hubKey || '';
if (!KEY) { console.error('缺少 MCPHUB_KEY：请在 config.json 写 hubKey 或设环境变量 MCPHUB_KEY'); process.exit(1); }

const HOME = os.homedir();
const NODE = process.execPath;
const DECRYPT = path.join(__dirname, 'decrypt-wb-creds.js');
const CREDS_FILE = path.join(process.env.MCPHUB_DATA_DIR || path.join(HOME, 'mcphub'), 'wb-headers.json');
const AGENT_MGR = (process.env.AGENT_MANAGER_URL || CFG.agentManagerUrl || 'http://localhost:3100').replace(/\/$/, '');
const LOG = path.join(process.env.MCPHUB_DATA_DIR || path.join(HOME, 'mcphub'), 'wb-cred-sync.log');

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
};

const h = (p, o = {}) => fetch(`${HUB}${p}`, {
  ...o,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...(o.headers || {}) },
}).then((r) => r.json()).catch((e) => ({ error: e.message }));

async function refreshLighthouse(creds) {
  const slot = Object.entries(creds.mcpOAuth || {}).find(([, t]) => t.serverName === 'lighthouse-ops' || /lighthouse/.test(t.serverName || ''));
  if (!slot) return null;
  const [slotKey, tok] = slot;
  // accessToken 未过期且还剩 >10min 直接用
  const stillValid = tok.expiresAt && tok.expiresAt - Date.now() > 10 * 60 * 1000 && tok.accessToken && !String(tok.accessToken).startsWith('__');
  if (stillValid) return { accessToken: tok.accessToken, expiresAt: tok.expiresAt, slotKey };
  if (!tok.refreshToken || String(tok.refreshToken).startsWith('__')) return null;
  const credDoc = JSON.parse(fs.readFileSync(path.join(HOME, '.workbuddy', 'connectors', creds.userId, '.credentials.v3.json'), 'utf8'));
  const clientId = credDoc.mcpClientInfo?.[slotKey]?.client_id;
  if (!clientId) { log('lighthouse: no client_id'); return null; }
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refreshToken, client_id: clientId });
  const r = await fetch('https://lightai.cloud.tencent.com/workbuddy/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { log('lighthouse refresh failed:', r.status, JSON.stringify(j).slice(0, 120)); return null; }
  // 更新本地凭据副本（refresh_token 不轮换，沿用旧值）
  tok.accessToken = j.access_token;
  tok.expiresAt = Date.now() + (j.expires_in || 7200) * 1000;
  tok.tokenType = j.token_type || 'Bearer';
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  log('lighthouse token refreshed, expires', new Date(tok.expiresAt).toISOString());
  return { accessToken: j.access_token, expiresAt: tok.expiresAt, slotKey };
}

async function putAuth(server, token) {
  const cur = await h(`/servers/${server}`);
  const cfg = cur.data?.config;
  if (!cfg) { log(server, 'config missing'); return; }
  const next = {
    type: cfg.type || 'streamable-http',
    url: cfg.url,
    headers: { ...(cfg.headers || {}), Authorization: `Bearer ${token}` },
  };
  const r = await h(`/servers/${server}`, { method: 'PUT', body: JSON.stringify({ config: next }) });
  await h(`/servers/${server}/reload`, { method: 'POST', body: '{}' });
  log(server, 'auth injected →', r.success ? 'ok' : JSON.stringify(r).slice(0, 120));
}

(async () => {
  try { execFileSync(NODE, [DECRYPT], { stdio: 'pipe' }); } catch (e) { log('decrypt failed:', e.message); }
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));

  const MAP = { 'workbuddy-tencent-docs': 'tencent-docs', 'workbuddy-ima-mcp': 'ima-mcp' };
  for (const [server, conn] of Object.entries(MAP)) {
    const token = creds.headerOverrides?.[conn]?.Authorization;
    if (token && !String(token).startsWith('__DECRYPT_FAIL__')) await putAuth(server, token);
    else log(server, 'no usable token');
  }
  const lh = await refreshLighthouse(creds);
  if (lh) await putAuth('workbuddy-lighthouse-ops', lh.accessToken);
  else log('lighthouse-ops: no token available');

  // ---- 自动发现：把 agent-manager 扫描到的新 MCP 自动导入网关 ----
  try {
    const r = await fetch(`${AGENT_MGR}/api/mcp/sync-all`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((x) => x.json());
    if (r.imported?.length) log('auto-import:', r.imported.join(', '));
    if (r.failed?.length) log('auto-import failed:', r.failed.join(', '));
  } catch (e) { log('sync-all failed:', e.message); }

  // ---- 自动注入：为所有已解密的连接器 Authorization 头，尝试匹配 workbuddy-<conn> 服务 ----
  const servers = await h('/servers');
  const names = new Set((Array.isArray(servers.data) ? servers.data : servers.data?.data || []).map((s) => s.name));
  const handled = new Set(Object.keys(MAP).map((s) => `workbuddy-${s}`.replace(/[^\w.-]/g, '_')));
  handled.add('workbuddy-lighthouse-ops');
  for (const [conn, fields] of Object.entries(creds.headerOverrides || {})) {
    const token = fields?.Authorization;
    if (!token || String(token).startsWith('__DECRYPT_FAIL__')) continue;
    const server = `workbuddy-${conn}`.replace(/[^\w.-]/g, '_');
    if (names.has(server) && !handled.has(server)) await putAuth(server, token);
  }
})();
