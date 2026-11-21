#!/usr/bin/env node
// 把解密出的 WorkBuddy 连接器凭据注入 MCPHub server 的 headers，让所有接入 agent 免再授权
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
// 读取仓库根 config.json（不入库）+ 环境变量
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')); } catch { return {}; }
}
const CFG = loadCfg();
const HUB_BASE = (process.env.MCPHUB_URL || CFG.hubUrl || 'http://localhost:3000').replace(/\/$/, '');
const HUB = HUB_BASE + '/api';
const KEY = process.env.MCPHUB_KEY || CFG.hubKey || '';
if (!KEY) { console.error('缺少 MCPHUB_KEY：请在 config.json 写 hubKey 或设环境变量 MCPHUB_KEY'); process.exit(1); }

const creds = JSON.parse(fs.readFileSync(path.join(process.env.MCPHUB_DATA_DIR || path.join(os.homedir(), 'mcphub'), 'wb-headers.json'), 'utf8'));

const h = (p, opts = {}) => fetch(`${HUB}${p}`, {
  ...opts,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}`, ...(opts.headers || {}) },
}).then((r) => r.json());

// hub server 名 → workbuddy connector 名（headerOverrides）
const MAP = {
  'workbuddy-tencent-docs': 'tencent-docs',
  'workbuddy-ima-mcp': 'ima-mcp',
};

(async () => {
  for (const [server, conn] of Object.entries(MAP)) {
    const token = creds.headerOverrides?.[conn]?.Authorization;
    if (!token || token.startsWith('__DECRYPT_FAIL__')) { console.log(server, 'no token'); continue; }
    const cur = await h(`/servers/${server}`);
    const cfg = cur.data?.config || {};
    const next = {
      type: cfg.type || 'streamable-http',
      url: cfg.url,
      headers: { ...(cfg.headers || {}), Authorization: `Bearer ${token}` },
    };
    const r = await h(`/servers/${server}`, { method: 'PUT', body: JSON.stringify({ config: next }) });
    console.log(server, 'PUT →', JSON.stringify(r).slice(0, 200));
    await h(`/servers/${server}/reload`, { method: 'POST', body: '{}' });
  }
  // lighthouse-ops: OAuth accessToken（短期）+ refreshToken
  const slot = Object.entries(creds.mcpOAuth || {})[0];
  if (slot) {
    const [, tok] = slot;
    if (tok.accessToken && !String(tok.accessToken).startsWith('__')) {
      const server = 'workbuddy-lighthouse-ops';
      const cur = await h(`/servers/${server}`);
      const cfg = cur.data?.config || {};
      const next = {
        type: cfg.type || 'streamable-http',
        url: cfg.url || tok.serverUrl,
        headers: { ...(cfg.headers || {}), Authorization: `Bearer ${tok.accessToken}` },
      };
      const r = await h(`/servers/${server}`, { method: 'PUT', body: JSON.stringify({ config: next }) });
      console.log(server, 'PUT →', JSON.stringify(r).slice(0, 200));
      await h(`/servers/${server}/reload`, { method: 'POST', body: '{}' });
      console.log('  note: accessToken expiresAt', new Date(tok.expiresAt).toISOString(), '— 需刷新机制');
    }
  }
})();
