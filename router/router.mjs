#!/usr/bin/env node
// Hermes auto-router: OpenAI-compatible proxy that classifies each request with a
// local Ollama model and forwards it to the matching upstream provider.
// Routes: simple -> workbuddy, coding -> volcengine, complex -> reverix.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));

const CLASSIFY_PROMPT = `Classify the user's latest request into exactly one category:
- CODING: writing, debugging, refactoring, running code, scripts, repo/file tasks, OR any task that needs operating the local computer — files, apps, reminders, notes, documents, media, automation, or MCP/skill tools
- COMPLEX: architecture design, planning, task breakdown/计划/方案/规划, reviewing or accepting finished work (验收/评审), deep reasoning, multi-step analysis
- SIMPLE: pure conversation — chat, questions, explanations answerable directly; weather, news, general knowledge, translations, brainstorming, or any question that does NOT ask to operate the local computer, files, apps, reminders, documents, media, automation, or MCP/skill tools
Reply with exactly one word: CODING, COMPLEX, or SIMPLE.`;

const classifyCache = new Map();
const CACHE_MAX = 1000;

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      const c = m.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
      }
    }
  }
  return '';
}

// Session stickiness: within one conversation, short follow-ups ("继续", "ok",
// brief confirmations) keep the session's current non-simple tier instead of
// dropping to SIMPLE mid-task, which would switch models and lose prompt cache.
// Substantial new messages still classify fresh, so planning/acceptance turns
// upgrade to COMPLEX as usual. Keyed by the conversation's first user message.
const sessionRoutes = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX = 500;
// Follow-ups that continue the current task; anything else classifies fresh.
const CONTINUATION = /^(继续|好|ok|okay|嗯|对|是的|可以|行|没问题|收到|明白|知道了|谢谢|感谢|下一步|然后呢|接着|再|还有|另外|补充)[，,。.！!\s]*/i;

function sessionKey(messages) {
  for (const m of messages) {
    if (m && m.role === 'user') {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return crypto.createHash('sha1').update(c.slice(0, 1000)).digest('hex');
    }
  }
  return '';
}

function stickyRoute(key, text, route) {
  if (!key) return route;
  const now = Date.now();
  if (sessionRoutes.size >= SESSION_MAX) sessionRoutes.clear();
  const prev = sessionRoutes.get(key);
  let out = route;
  if (prev && prev.route !== 'simple' && route === 'simple' && CONTINUATION.test(text.trim())) {
    out = prev.route;
  }
  sessionRoutes.set(key, { route: out, ts: now });
  if (Math.random() < 0.02) {
    for (const [k, v] of sessionRoutes) if (now - v.ts > SESSION_TTL_MS) sessionRoutes.delete(k);
  }
  return out;
}

// Deterministic tool-intent override: high-confidence requests that need local
// skills/MCP tools go straight to CODING (strong tool-calling model).
const TOOL_INTENT = [
  /提醒|闹钟|reminder|alarm|待办|\bto-?do\b/i,
  /备忘录|obsidian/i,
  /短信|发信息|发短信|imessage/i,
  /查找.{0,8}(设备|airtag)|findmy|定位.{0,4}(设备|手机)/i,
  /邮件|收件箱|\binbox\b|email/i,
  /\bpdf\b/i,
  /\bword\b|\bexcel\b|\bppt\b|幻灯片/i,
  /youtube|视频(总结|内容|要点|文案)/i,
  /论文|arxiv/i,
  /价格监控|product price/i,
  /竞品/i,
  /会议纪要|meeting notes?/i,
  /地图|路线规划|导航|\bmap\b/i,
  /截图|screenshot|录屏/i,
  /重命名|文件夹|压缩包|解压|转成\s*pdf|格式转换/i,
  /日历|日程/i,
  /自动化|定时任务|cron|workflow/i,
  /操作电脑|computer use/i,
  /查一下|帮我查|搜索一下|搜一下|google一下|百度一下/i,
];

function toolIntentRoute(text) {
  return TOOL_INTENT.some(re => re.test(text)) ? 'coding' : null;
}

async function classify(text) {
  const key = crypto.createHash('sha1').update(text.slice(0, 4000)).digest('hex');
  if (classifyCache.has(key)) return classifyCache.get(key);
  const forced = toolIntentRoute(text);
  if (forced) {
    if (classifyCache.size >= CACHE_MAX) classifyCache.clear();
    classifyCache.set(key, forced);
    return forced;
  }
  let route = 'simple';
  const cc = CFG.classifier || {};
  const mode = cc.mode || 'local';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let out = '';
    if (mode === 'cloud') {
      // 云端小模型：可继承某条路由的上游（baseUrl/apiKey/model），也可自定义
      const base = cc.route && CFG.routes[cc.route];
      const baseUrl = String(cc.baseUrl || base?.baseUrl || '').replace(/\/+$/, '');
      const apiKey = cc.apiKey || base?.apiKey || '';;
      const model = cc.model || base?.model || '';
      if (!baseUrl || !model) throw new Error('cloud classifier not configured');
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature: 0, max_tokens: 384, stream: false,
          messages: [
            { role: 'system', content: CLASSIFY_PROMPT },
            { role: 'user', content: text.slice(0, 3000) },
          ],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        out = String(data.choices?.[0]?.message?.content || '').toUpperCase();
      }
    } else {
      const res = await fetch(`${cc.ollamaUrl || CFG.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cc.model || CFG.classifierModel,
          stream: false,
          think: false,
          options: { temperature: 0, num_predict: 8 },
          messages: [
            { role: 'system', content: CLASSIFY_PROMPT },
            { role: 'user', content: text.slice(0, 3000) },
          ],
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        out = String(data.message?.content || '').toUpperCase();
      }
    }
    if (out.includes('COMPLEX')) route = 'complex';
    else if (out.includes('CODING')) route = 'coding';
    else route = 'simple';
  } catch {
    route = 'simple';
  }
  if (classifyCache.size >= CACHE_MAX) classifyCache.clear();
  classifyCache.set(key, route);
  return route;
}

function explicitRoute(body) {
  const explicit = String(body.model || '').toLowerCase();
  if (CFG.routes[explicit]) return explicit;
  return null;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function hostOf(u){ try { return new URL(u).host; } catch { return String(u); } }

// 每日预算熔断：watchdog 每小时写 budget-state.json（按 host 统计 reqToday/usdToday），
// config.budgets = { host: { usd, requests } }，超限则跳过该上游走 fallback。
const BUDGET_STATE = path.join(DIR, 'budget-state.json');
let budgetCache = { ts: 0, data: {} };
function budgetState() {
  const now = Date.now();
  if (now - budgetCache.ts < 60000) return budgetCache.data;
  try { budgetCache = { ts: now, data: JSON.parse(fs.readFileSync(BUDGET_STATE, 'utf8')).hosts || {} }; }
  catch { budgetCache = { ts: now, data: {} }; }
  return budgetCache.data;
}
function budgetExceeded(host) {
  const b = (CFG.budgets || {})[host];
  if (!b) return false;
  const st = budgetState()[host] || {};
  if (b.usd && (st.usdToday || 0) >= b.usd) return true;
  if (b.requests && (st.reqToday || 0) >= b.requests) return true;
  return false;
}

async function pipeStream(upstream, res) {
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') || 'application/json',
    'cache-control': 'no-cache',
  });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

async function forwardOnce(target, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.upstreamTimeoutMs || 600000);
  try {
    const upstream = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${target.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => '');
      clearTimeout(timer);
      return { ok: false, status: upstream.status, body: txt.slice(0, 500) };
    }
    return { ok: true, upstream };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, body: String((e && e.message) || e) };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, routes: Object.keys(CFG.routes) }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/admin/reload') {
      try {
        CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
        console.log(`[router] config reloaded routes=${Object.keys(CFG.routes || {}).join(',')} classifier=${(CFG.classifier || {}).mode || 'local'}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, routes: Object.keys(CFG.routes || {}) }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: ['auto', ...Object.keys(CFG.routes)].map(id => ({ id, object: 'model', created: 0, owned_by: 'hermes-router' })),
      }));
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      let route = explicitRoute(body);
      let stick = false;
      if (!route) {
        const text = lastUserText(messages);
        const raw = text ? await classify(text) : 'simple';
        const sticky = stickyRoute(sessionKey(messages), text || '', raw);
        stick = sticky !== raw;
        route = sticky;
      }
      const cfgRoute = CFG.routes[route] || CFG.routes.simple;
      const payload = { ...body, model: cfgRoute.model };
      delete payload.route;

      const fallbacks = cfgRoute.fallbacks || (cfgRoute.fallback ? [cfgRoute.fallback] : []);
      const attempts = [cfgRoute, ...fallbacks];
      let lastErr = null;
      for (const target of attempts) {
        const host = hostOf(target.baseUrl);
        if (budgetExceeded(host)) {
          console.log(`[router] ${new Date().toISOString()} route=${route} model=${target.model} host=${host} skip=budget`);
          lastErr = { status: 429, body: 'daily budget exceeded: ' + host };
          continue;
        }
        const r = await forwardOnce(target, payload);
        if (r.ok) {
          await pipeStream(r.upstream, res);
          console.log(`[router] ${new Date().toISOString()} route=${route} model=${target.model} host=${hostOf(target.baseUrl)}${stick ? ' stick=1' : ''} ok`);
          return;
        }
        lastErr = r;
        console.log(`[router] ${new Date().toISOString()} route=${route} model=${target.model} host=${hostOf(target.baseUrl)} FAIL status=${r.status} ${r.body}`);
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `all upstreams failed for route ${route}`, detail: lastErr } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  } catch (e) {
    console.error('[router] error', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String((e && e.message) || e) } }));
    } else {
      res.end();
    }
  }
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log(`[router] listening on 127.0.0.1:${CFG.port} routes=${Object.keys(CFG.routes).join(',')}`);
});
