#!/usr/bin/env node
// Hermes auto-router v2 —— OpenAI 兼容代理，按任务等级路由，并做「失败归因」分流。
//
// 路由语义：
//   每个 route 的链路是「厂商分组」，组内是有序模型，组间是有序厂商：
//     chain: [
//       { provider: 'ark',     models: ['kimi-k3.1-pro', 'doubao-seed-2.1-pro'] },
//       { provider: 'reverix', models: ['claude-opus-5-5', 'gpt-6.1-sol'] },
//     ]
//
//   失败先归因，再决定怎么退：
//     · 模型级（模型不存在 / 参数不支持 / 上下文超限 / 单模型不可用）→ 换同厂商的下一个模型
//     · 厂商级（余额不足 / 配额耗尽 / 鉴权失败 / 网关 5xx / 连不上）→ 整家跳过，按顺序换下一家厂商
//     · 请求级（messages 结构非法等）→ 不浪费尝试，直接回给客户端
//   厂商级失败触发「账号级熔断」（落盘 breaker-state.json），能解析配额重置时间就精确到那一刻恢复。
//
//   Agent 重试感知：同一会话同一句请求在窗口内再次到达（且上次是失败）时，
//     retry=1 → 跳过已试过的厂商/模型，从断点继续；
//     retry>=escalateAfter(默认 2) → 升级到下一档 route（simple→coding→complex→expert）再叠兜底池。
//
//   路由策略跟随配置：routes.<name>.strategy = priority(默认) | latency | cost | healthy，
//     只在「同一档位内」重排厂商/模型，不改变链路成员，也不会把请求送进能力不匹配的厂商。
//
//   快速失败（避免 Agent 客户端 30s×3 空转）：
//     · 能力过滤后一个候选都不剩（如只配了本地 3B 却带 19 个工具）→ 立即 400，不重试；
//     · 全部厂商熔断且预计等待超过 minWaitMs，或同一请求已重试过 afterRetries 次 → 立即 400，不重试。
//     这两类都带 retryable=false，客户端不该再等。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// ROUTER_CONFIG 可指向别处的配置（多实例 / 回归测试用），熔断状态跟随配置目录
const CFG_FILE = process.env.ROUTER_CONFIG ? path.resolve(process.env.ROUTER_CONFIG) : path.join(DIR, 'config.json');
const STATE_DIR = path.dirname(CFG_FILE);
const BREAKER_FILE = path.join(STATE_DIR, 'breaker-state.json');
const ROUTER_VERSION = 2;

let CFG = {};
let PROVIDERS = {};   // pid -> { id, baseUrl, apiKey, label }
let ROUTES = {};      // name -> { name, groups: [{ pid, models: [] }] }
let RESERVE = [];     // [{ pid, models: [] }]
let ROUTE_LOOKUP = {}; // 小写名 -> 真实路由名（"Auto"/"SIMPLE" 也能命中）
let POL = {};
let CD = {};
let GUARD = {};
const STRATEGIES = new Set(['priority', 'latency', 'cost', 'healthy']);

// ---------------------------------------------------------------- 基础工具
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
function hostOf(u) { try { return new URL(u).host; } catch { return String(u || ''); } }
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- 配置归一化
function synthProvider(providers, baseUrl, apiKey, label) {
  const url = trimSlash(baseUrl);
  if (!url) return null;
  // 同一家（host + 同 key）只建一个账号实体；不同 key 视为不同账号
  const id = `${hostOf(url)}${apiKey ? '#' + sha1(apiKey).slice(0, 6) : ''}`;
  if (!providers[id]) {
    providers[id] = { id, baseUrl: url, apiKey: apiKey || '', label: label || hostOf(url), synthetic: true };
  }
  return id;
}

function normGroups(list, providers, fallbackBase, fallbackKey) {
  const groups = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw) continue;
    let pid = raw.provider && providers[raw.provider] ? raw.provider : null;
    if (!pid) pid = synthProvider(providers, raw.baseUrl || fallbackBase, raw.apiKey || fallbackKey, raw.provider);
    if (!pid) continue;
    const models = (Array.isArray(raw.models) ? raw.models : [raw.model]).filter((m) => m && typeof m === 'string');
    if (!models.length) continue;
    const last = groups[groups.length - 1];
    if (last && last.pid === pid) { for (const m of models) if (!last.models.includes(m)) last.models.push(m); }
    else groups.push({ pid, models: [...models] });
  }
  return groups;
}

function normalizeConfig(cfg) {
  const providers = {};
  for (const [id, p] of Object.entries(cfg.providers || {})) {
    if (!p || !p.baseUrl) continue;
    providers[id] = {
      id,
      baseUrl: trimSlash(p.baseUrl),
      apiKey: p.apiKey || '',
      label: p.label || id,
      // 成本（USD / 1M tokens），strategy=cost 时用它排序；没有就排在后面
      cost: Number(p.cost) > 0 ? Number(p.cost) : null,
      // 能力声明：本地小模型等能力受限的厂商用它挡住不合适的请求
      capabilities: (p.capabilities && typeof p.capabilities === 'object') ? { ...p.capabilities } : null,
    };
  }
  const routes = {};
  for (const [name, r] of Object.entries(cfg.routes || {})) {
    if (!r) continue;
    let groups = [];
    if (Array.isArray(r.chain) && r.chain.length) {
      groups = normGroups(r.chain, providers);
    } else if (r.model) {
      // 兼容旧结构：{ baseUrl, apiKey, model, fallbacks:[{model,baseUrl?,apiKey?}] }
      const base = r.provider && providers[r.provider] ? providers[r.provider].baseUrl : r.baseUrl;
      const key = r.provider && providers[r.provider] ? providers[r.provider].apiKey : r.apiKey;
      const pid = r.provider && providers[r.provider] ? r.provider : synthProvider(providers, base, key);
      if (pid) groups.push({ pid, models: [r.model] });
      for (const f of r.fallbacks || []) {
        if (!f || !f.model) continue;
        const fpid = f.provider && providers[f.provider] ? f.provider
          : synthProvider(providers, f.baseUrl || base, f.apiKey || key);
        if (!fpid) continue;
        const last = groups[groups.length - 1];
        if (last && last.pid === fpid) { if (!last.models.includes(f.model)) last.models.push(f.model); }
        else groups.push({ pid: fpid, models: [f.model] });
      }
    }
    if (!groups.length) continue;
    const strategy = STRATEGIES.has(String(r.strategy || '')) ? String(r.strategy) : 'priority';
    routes[name] = { name, groups, strategy, provider: groups[0].pid };
  }
  const reserve = [];
  if (Array.isArray(cfg.reserve)) {
    for (const g of normGroups(cfg.reserve, providers)) {
      const dup = reserve.find((x) => x.pid === g.pid);
      if (dup) { for (const m of g.models) if (!dup.models.includes(m)) dup.models.push(m); }
      else reserve.push({ pid: g.pid, models: [...g.models] });
    }
  }
  return { providers, routes, reserve };
}

function loadConfig() {
  CFG = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  const n = normalizeConfig(CFG);
  PROVIDERS = n.providers;
  ROUTES = n.routes;
  RESERVE = n.reserve;
  ROUTE_LOOKUP = Object.fromEntries(Object.keys(ROUTES).map((k) => [k.toLowerCase(), k]));
  const rp = CFG.retryPolicy || {};
  // 档位升级顺序跟路由配置挂钩：配置里显式写了 tiers 就严格按它（删除的路由自动剔除）；
  // 没写才退回「路由出现顺序」，保证新增档位天然参与升级链。
  const declared = Array.isArray(rp.tiers) ? rp.tiers.filter((t) => ROUTES[t]) : [];
  const tiers = declared.length ? [...new Set(declared)] : Object.keys(ROUTES);
  POL = {
    retryWindowMs: rp.windowMs > 0 ? rp.windowMs : 300000,
    escalateAfter: rp.escalateAfter > 0 ? rp.escalateAfter : 2,
    tiers,
    crossTier: rp.crossTier !== false,
  };
  const b = CFG.breaker || {};
  CD = {
    quota: b.quotaMs > 0 ? b.quotaMs : 15 * 60000,
    auth: b.authMs > 0 ? b.authMs : 60 * 60000,
    rate: b.rateMs > 0 ? b.rateMs : 2 * 60000,
    server: b.serverMs > 0 ? b.serverMs : 60000,
    network: b.networkMs > 0 ? b.networkMs : 30000,
    model: b.modelMs > 0 ? b.modelMs : 600000,
  };
  const g = CFG.guard || {};
  GUARD = {
    upgradeOnTools: g.upgradeOnTools !== false,
    toolsMin: Number(g.toolsMin) > 0 ? Number(g.toolsMin) : 1,
    toolsUpgradeTo: typeof g.toolsUpgradeTo === 'string' && ROUTES[g.toolsUpgradeTo] ? g.toolsUpgradeTo : 'coding',
    // 快速失败：0 = 关闭。afterRetries 指同一请求第几次重试开始不再等（默认 2）
    fastFailAfterRetries: g.fastFailAfterRetries === 0 ? 0 : (Number(g.fastFailAfterRetries) >= 0 ? Number(g.fastFailAfterRetries) : 2),
    // 熔断已经存在超过这么久（毫秒）就别再让客户端空转：默认 45s，恰好长于 30s 网络型熔断
    fastFailStaleMs: g.fastFailStaleMs === 0 ? 0 : (Number(g.fastFailStaleMs) > 0 ? Number(g.fastFailStaleMs) : 45000),
    fastFailMinWaitMs: g.fastFailMinWaitMs === 0 ? 0 : (Number(g.fastFailMinWaitMs) > 0 ? Number(g.fastFailMinWaitMs) : 120000),
  };
}
loadConfig();

// ---------------------------------------------------------------- 熔断（按厂商账号）
let breakers = {};
try { breakers = JSON.parse(fs.readFileSync(BREAKER_FILE, 'utf8')).providers || {}; } catch { breakers = {}; }

let breakerDirty = false;
function saveBreakersSoon() {
  if (breakerDirty) return;
  breakerDirty = true;
  setTimeout(() => {
    breakerDirty = false;
    try { fs.writeFileSync(BREAKER_FILE, JSON.stringify({ updated: nowIso(), providers: breakers }, null, 2)); } catch { /* 忽略落盘失败 */ }
  }, 400).unref?.();
}

function breakerOpen(pid) {
  const b = breakers[pid];
  return !!(b && b.openUntil > Date.now());
}
function breakerLeft(pid) {
  const b = breakers[pid];
  return b && b.openUntil > Date.now() ? b.openUntil - Date.now() : 0;
}

function parseResetAt(text) {
  // "It will reset at 2026-11-22 04:06:22 +0800 CST"
  let m = text.match(/reset\s*(?:at|on)?\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}:?\d{2})?/i);
  if (m) {
    const tz = (m[3] || '').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const t = Date.parse(`${m[1]}T${m[2]}${tz}`);
    if (!Number.isNaN(t) && t > Date.now()) return t;
  }
  // "At most 30 requests per 1 minute(s)" / "try again in 30s" / "reset after 5 minutes"
  m = text.match(/(?:try again|retry|available|reset|per|within)[^.\d]{0,20}(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hour|hours?)\b/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit.startsWith('h') ? 3600000 : unit.startsWith('m') ? 60000 : 1000;
    const t = Date.now() + n * mult;
    if (t > Date.now()) return t;
  }
  return null;
}

function trip(pid, cls) {
  const base = cls.kind === 'balance' || cls.kind === 'quota' ? CD.quota
    : cls.kind === 'auth' ? CD.auth
      : cls.kind === 'rate' ? CD.rate
        : cls.kind === 'network' ? CD.network : CD.server;
  let until = parseResetAt(cls.text || '');
  const cap = Date.now() + 6 * 3600000;
  if (until) until = Math.min(until, cap);
  else until = Date.now() + base;
  const prev = breakers[pid] || {};
  breakers[pid] = {
    openUntil: Math.max(until, prev.openUntil || 0),
    kind: cls.kind,
    scope: cls.scope,
    reason: String(cls.text || '').replace(/\s+/g, ' ').slice(0, 300),
    hits: (prev.hits || 0) + 1,
    updated: nowIso(),
    resetSrc: !!parseResetAt(cls.text || ''),
  };
  saveBreakersSoon();
  console.log(`[router] ${nowIso()} breaker=open provider=${pid} kind=${cls.kind} until=${new Date(breakers[pid].openUntil).toISOString()} hits=${breakers[pid].hits}`);
}

function clearBreaker(pid) {
  if (!breakers[pid]) return false;
  delete breakers[pid];
  saveBreakersSoon();
  console.log(`[router] ${nowIso()} breaker=reset provider=${pid}`);
  return true;
}

// ---------------------------------------------------------------- 模型冷却（只针对单个模型）
const modelCool = new Map(); // pid|model -> until
function coolModel(pid, model) { modelCool.set(`${pid}|${model}`, Date.now() + CD.model); }
function modelCooled(pid, model) { const t = modelCool.get(`${pid}|${model}`) || 0; return t > Date.now(); }

// ---------------------------------------------------------------- 重试感知账本
// key = 会话首条用户消息 + 最后一条用户消息；只有上一轮「失败」才算 retry，避免误判用户复述。
const ledger = new Map();
const LEDGER_MAX = 400;
function ledgerGet(key) { return key ? ledger.get(key) : null; }
function ledgerSet(key, val) {
  if (!key) return;
  if (ledger.size >= LEDGER_MAX) {
    const cut = Date.now() - POL.retryWindowMs * 2;
    for (const [k, v] of ledger) if (!v.ts || v.ts < cut) ledger.delete(k);
    if (ledger.size >= LEDGER_MAX) ledger.clear();
  }
  ledger.set(key, val);
}

// ---------------------------------------------------------------- 分类器
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
      if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
    }
  }
  return '';
}

const sessionRoutes = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_MAX = 500;
const CONTINUATION = /^(继续|好|ok|okay|嗯|对|是的|可以|行|没问题|收到|明白|知道了|谢谢|感谢|下一步|然后呢|接着|再|还有|另外|补充)[，,。.！!\s]*/i;

function sessionKey(messages) {
  for (const m of messages) {
    if (m && m.role === 'user') {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sha1(c.slice(0, 1000));
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
  if (prev && prev.route !== 'simple' && route === 'simple' && CONTINUATION.test(text.trim())) out = prev.route;
  sessionRoutes.set(key, { route: out, ts: now });
  if (Math.random() < 0.02) for (const [k, v] of sessionRoutes) if (now - v.ts > SESSION_TTL_MS) sessionRoutes.delete(k);
  return out;
}

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

function toolIntentRoute(text) { return TOOL_INTENT.some((re) => re.test(text)) ? 'coding' : null; }

async function classify(text) {
  const key = sha1(text.slice(0, 4000));
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
    let out = '';
    if (mode === 'cloud') {
      // 分类器也要能跨厂商：沿继承路由的厂商顺序挑第一个未熔断的
      const cands = [];
      if (cc.baseUrl && cc.model) cands.push({ baseUrl: trimSlash(cc.baseUrl), apiKey: cc.apiKey || '', model: cc.model, pid: '' });
      const rn = ROUTE_LOOKUP[String(cc.route || 'simple').toLowerCase()] || Object.keys(ROUTES)[0];
      const baseRoute = ROUTES[rn];
      if (baseRoute) {
        for (const g of baseRoute.groups) {
          const p = PROVIDERS[g.pid];
          if (!p || !g.models.length) continue;
          const model = cc.model && !cands.length ? cc.model : g.models[0];
          cands.push({ baseUrl: p.baseUrl, apiKey: p.apiKey, model, pid: g.pid });
        }
      }
      if (!cands.length) throw new Error('cloud classifier not configured');
      for (const c of cands.slice(0, 4)) {
        if (c.pid && breakerOpen(c.pid)) continue;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        try {
          const res = await fetch(`${c.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
            body: JSON.stringify({
              model: c.model, temperature: 0, max_tokens: 384, stream: false,
              messages: [
                { role: 'system', content: CLASSIFY_PROMPT },
                { role: 'user', content: text.slice(0, 3000) },
              ],
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (!res.ok) continue;
          const data = await res.json();
          out = String(data.choices?.[0]?.message?.content || '').toUpperCase();
          if (out) break;
        } catch { clearTimeout(timer); }
      }
    } else {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
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

// ---------------------------------------------------------------- 预算熔断
const BUDGET_STATE = path.join(STATE_DIR, 'budget-state.json');
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

// ---------------------------------------------------------------- 出站净化
// Agent 客户端（Devin Desktop / Windsurf / Cline 一类）会把上一轮 assistant 的思维链
// 原样回传（reasoning_content / thinking 块 / reasoning_effort）。这些是「客户端本地状态」，
// 上游多半不认：Reverix 这类 OpenAI→Anthropic 转换层会直接 400
// "cannot preserve ... messages.reasoning_content"，本地 Ollama 会 400 "does not support thinking"。
// 发出去之前统一剥掉，只保留真正的对话语义。厂商若确实需要，用 keepFields 声明保留。
const TOP_DROP = new Set([
  'reasoning_effort', 'reasoning', 'think', 'thinking',
  'verbosity', 'prompt_cache_key', 'safety_identifier', 'service_tier',
]);
const MSG_DROP = new Set([
  'reasoning_content', 'reasoning', 'reasoning_details', 'reasoning_text',
  'thinking', 'thinking_blocks', 'provider_specific_fields',
  'cache_control', 'annotations', 'audio', 'refusal',
]);
const THINKING_BLOCK = new Set(['thinking', 'redacted_thinking']);

function sanitizeMessages(msgs, keep) {
  const out = [];
  let dropped = 0;
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || typeof m !== 'object') continue;
    const o = {};
    for (const [k, v] of Object.entries(m)) {
      if (!keep.has(k) && MSG_DROP.has(k)) { dropped++; continue; }
      o[k] = v;
    }
    if (Array.isArray(o.content)) {
      const parts = o.content.filter((p) => !(p && THINKING_BLOCK.has(p.type)));
      if (parts.length !== o.content.length) { dropped++; o.content = parts; }
      // 只剩思维链、没有正文也没工具调用 → 这条消息没有语义，丢掉，避免 "content must not be empty"
      if (!o.content.length && !(Array.isArray(o.tool_calls) && o.tool_calls.length)) continue;
    } else if (typeof o.content === 'string' && !o.content && !(Array.isArray(o.tool_calls) && o.tool_calls.length) && o.role === 'assistant') {
      continue;
    }
    out.push(o);
  }
  return { messages: out, dropped };
}

function buildPayload(base, prov, drops, tempOverride) {
  const keep = new Set(prov.keepFields || []);
  const out = { ...base };
  let dropped = 0;
  for (const k of TOP_DROP) if (k in out && !keep.has(k)) { delete out[k]; dropped++; }
  for (const k of drops) delete out[k];
  if (Array.isArray(out.messages)) {
    const r = sanitizeMessages(out.messages, keep);
    out.messages = r.messages;
    dropped += r.dropped;
  }
  if (tempOverride != null) out.temperature = tempOverride;
  return { payload: out, dropped };
}

// 只记录形状，不落正文，方便线上复盘「这条请求带了什么导致 400」
function shapeOf(p) {
  const msgs = Array.isArray(p.messages) ? p.messages : [];
  const has = (k) => msgs.some((m) => m && m[k] != null);
  const parts = [`n=${msgs.length}`];
  for (const k of ['reasoning_content', 'reasoning', 'thinking']) if (has(k)) parts.push(k === 'reasoning_content' ? 'rc' : k);
  if (p.reasoning_effort) parts.push(`eff=${p.reasoning_effort}`);
  if (p.reasoning) parts.push('reasoning');
  if (Array.isArray(p.tools)) parts.push(`tools=${p.tools.length}`);
  if (p.response_format) parts.push('fmt');
  if (p.stream) parts.push('stream');
  if (p.max_completion_tokens != null) parts.push('mct');
  return parts.join(',');
}

// ---------------------------------------------------------------- 失败归因
const RE_QUOTA = /insufficient_user_quota|insufficient[_\s-]?(?:available[_\s-]?)?(?:balance|quota|credit|funds)|quota[_\s-]?exceeded|exceeded[^.]{0,30}quota|accountquota|arrears|payment required|余额不足|欠费|额度不足|配额|可用余额/i;
// 限流：窗口短、恢复快，必须比「配额/余额」先判定，否则会把 30 次/分钟的限流当成 15 分钟配额耗尽
const RE_RATE = /rate[_\s-]?limit|too many requests|requests? per\s+\d+\s*(?:second|minute|hour)|throttl|slow down|限流|请求频率|频率达到限制|稍后再试/i;
const RE_AUTH = /invalid[_\s-]?(?:api[_\s-]?key|token)|incorrect api key|unauthorized|authentication[_\s-]?fail|permission[_\s-]?denied|鉴权失败|密钥无效|令牌无效/i;
const RE_TEMP = /temperature[^.]{0,40}only\s*([0-9.]+)\s*is\s*allowed|temperature[^.]{0,40}(?:must|should)\s*be\s*([0-9.]+)/i;
// 只有「请求本身不可解析 / 缺少必填」才算请求级；其余 400 一律按下游能力问题处理，继续兜底
const RE_FATAL_REQ = /invalid json|json[_\s-]?parse|unexpected token|messages[^.]{0,40}(?:is required|are required|must be an array|must be provided)|no messages|request body[^.]{0,30}(?:required|invalid|empty)/i;

// 「字段不被支持」→ 就地降级重试同一目标，而不是放弃整条链
const HEAL = [
  {
    re: /reasoning_content|protocol conversion|preserve the requested feature|unsupported protocol/i,
    label: 'reasoning-echo',
    drop: ['reasoning_effort', 'reasoning', 'think'],
  },
  {
    re: /does not support (?:thinking|reasoning)|(?:thinking|reasoning) is not supported|not support(?:ed)? (?:the )?(?:thinking|reasoning) (?:mode|feature)/i,
    label: 'no-thinking',
    drop: ['reasoning_effort', 'reasoning', 'think'],
  },
  {
    re: /(?:tools?|function calling|tool_choice|parallel_tool_calls)[^.]{0,50}(?:not supported|unsupported|does not support)|(?:not supported|unsupported)[^.]{0,30}(?:tools?|function calling)/i,
    label: 'no-tools',
    drop: ['tools', 'tool_choice', 'parallel_tool_calls'],
  },
  {
    re: /(?:response_format|json_schema|json mode)[^.]{0,50}(?:not supported|unsupported|does not support)/i,
    label: 'no-json-mode',
    drop: ['response_format'],
  },
  {
    re: /max_completion_tokens[^.]{0,50}(?:not supported|unsupported|unknown|unrecognized)/i,
    label: 'max-tokens',
    drop: [],
  },
  {
    re: /(?:developer)[^.]{0,20}role|role[^.]{0,20}developer/i,
    label: 'developer-role',
    drop: [],
  },
];

function healFor(text) {
  const s = String(text || '');
  for (const h of HEAL) if (h.re.test(s)) return h;
  return null;
}

function parseTemp(text) {
  const m = text.match(RE_TEMP);
  if (!m) return null;
  const v = Number(m[1] || m[2]);
  return Number.isFinite(v) ? v : null;
}

// scope: model（换模型） | provider（换厂商） | request（不重试）
function classifyFailure(status, text) {
  text = String(text || '');
  if (status === 0) return { kind: 'network', scope: 'provider' };
  if (status === 401) return { kind: 'auth', scope: 'provider' };
  if (status === 402) return { kind: 'balance', scope: 'provider' };
  if (status === 403) {
    if (RE_QUOTA.test(text)) return { kind: 'balance', scope: 'provider' };
    if (RE_AUTH.test(text)) return { kind: 'auth', scope: 'provider' };
    if (/model/i.test(text)) return { kind: 'model_forbidden', scope: 'model' };
    return { kind: 'forbidden', scope: 'provider' };
  }
  if (status === 404) return /model/i.test(text) ? { kind: 'model_not_found', scope: 'model' } : { kind: 'endpoint', scope: 'provider' };
  if (status === 429) {
    if (RE_RATE.test(text)) return { kind: 'rate', scope: 'provider' };
    if (RE_QUOTA.test(text)) return { kind: 'quota', scope: 'provider' };
    return { kind: 'rate', scope: 'provider' };
  }
  if (status === 400 || status === 422) {
    if (RE_TEMP.test(text)) return { kind: 'temperature', scope: 'model' };
    // 能力/字段不被上游支持：先自愈重试，再不行就换模型、换厂商——绝不立刻中止
    if (healFor(text)) return { kind: 'unsupported_field', scope: 'model' };
    if (/context[_\s-]?length|maximum context|too many tokens|reduce the length/i.test(text)) return { kind: 'context', scope: 'model' };
    if (RE_FATAL_REQ.test(text)) return { kind: 'bad_request', scope: 'request' };
    return { kind: 'bad_param', scope: 'model' };
  }
  if (status === 413) return { kind: 'too_large', scope: 'request' };
  if (status >= 500) return { kind: 'server', scope: 'provider' };
  return { kind: `http_${status}`, scope: 'provider' };
}

// ---------------------------------------------------------------- 能力守卫
// 请求侧画像：本地 3B 这类厂商不能接工具调用 / 长上下文，否则会一本正经地胡说
function requestContext(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  let chars = 0;
  try { chars = JSON.stringify(messages).length; } catch { chars = 0; }
  return {
    hasTools: tools.length > 0,
    toolCount: tools.length,
    n: messages.length,
    chars,
    stream: !!body.stream,
    maxTokens: Number(body.max_tokens || body.max_completion_tokens || 0) || 0,
  };
}

// 返回不可用原因，null 表示可用
function incapableReason(pid, ctx) {
  const cap = PROVIDERS[pid] && PROVIDERS[pid].capabilities;
  if (!cap || !ctx) return null;
  // 档位限制：本地小模型只配处理 simple，coding / complex / expert 一律不接
  if (Array.isArray(cap.tiers) && cap.tiers.length && ctx.route && !cap.tiers.includes(ctx.route)) return `tier(${ctx.route})`;
  if (cap.tools === false && ctx.hasTools) return `no-tools(${ctx.toolCount})`;
  if (cap.stream === false && ctx.stream) return 'no-stream';
  if (Number(cap.maxChars) > 0 && ctx.chars > Number(cap.maxChars)) return `ctx>${cap.maxChars}`;
  if (Number(cap.maxMessages) > 0 && ctx.n > Number(cap.maxMessages)) return `n>${cap.maxMessages}`;
  return null;
}

// ---------------------------------------------------------------- 运行期统计（策略排序用）
// 只存在内存里：延迟用 EWMA 平滑，失败只记时间戳，重启归零，不污染配置。
const modelStat = new Map(); // pid|model -> { n, ok, lat, fails: [] }
const provStat = new Map();  // pid -> { n, ok, lat, fails: [] }
const FAIL_WINDOW_MS = 5 * 60000;

function statFor(map, key) {
  let s = map.get(key);
  if (!s) { s = { n: 0, ok: 0, lat: null, fails: [] }; map.set(key, s); }
  return s;
}
function noteStat(pid, model, ms, ok) {
  for (const s of [statFor(provStat, pid), statFor(modelStat, `${pid}|${model}`)]) {
    s.n++;
    if (ok) {
      s.ok++;
      s.lat = s.lat == null ? ms : s.lat * 0.7 + ms * 0.3;
    } else {
      s.fails.push(Date.now());
      if (s.fails.length > 20) s.fails.shift();
    }
  }
}
function recentFailCount(pid, model) {
  const cut = Date.now() - FAIL_WINDOW_MS;
  const s = modelStat.get(`${pid}|${model}`);
  const p = provStat.get(pid);
  return (s ? s.fails.filter((t) => t > cut).length : 0) + (p ? p.fails.filter((t) => t > cut).length : 0);
}

function stepScore(pid, model, strategy) {
  if (strategy === 'cost') {
    const c = PROVIDERS[pid] && PROVIDERS[pid].cost;
    return c == null ? Number.POSITIVE_INFINITY : c;
  }
  if (strategy === 'latency') {
    const s = modelStat.get(`${pid}|${model}`);
    const p = provStat.get(pid);
    const v = (s && s.lat) || (p && p.lat);
    return v == null ? Number.POSITIVE_INFINITY : v;
  }
  if (strategy === 'healthy') return recentFailCount(pid, model) * 1000 + (breakerOpen(pid) ? 1e6 : 0);
  return 0;
}

// 只重排「同一条链路里的顺序」，不增删成员：策略永远不能越过能力守卫
function applyStrategy(groups, strategy) {
  const plain = groups.map((g) => ({ pid: g.pid, models: [...g.models] }));
  if (!strategy || strategy === 'priority') return plain;
  const scored = plain.map((g, i) => {
    const models = g.models
      .map((m, mi) => ({ m, mi, s: stepScore(g.pid, m, strategy) }))
      .sort((a, b) => a.s - b.s || a.mi - b.mi)
      .map((x) => x.m);
    const best = models.reduce((acc, m) => Math.min(acc, stepScore(g.pid, m, strategy)), Number.POSITIVE_INFINITY);
    return { g: { pid: g.pid, models }, i, best };
  });
  scored.sort((a, b) => a.best - b.best || a.i - b.i);
  return scored.map((x) => x.g);
}

// ---------------------------------------------------------------- 计划生成
function planFor(routeName, retryCount, tried) {
  const route = ROUTES[routeName] || ROUTES[Object.keys(ROUTES)[0]];
  let groups = applyStrategy(route.groups, route.strategy);
  let escalated = false;
  let escTo = null;
  if (retryCount >= POL.escalateAfter && POL.crossTier) {
    const i = POL.tiers.indexOf(routeName);
    const next = i >= 0 ? POL.tiers[i + 1] : null;
    if (next && ROUTES[next]) {
      escalated = true;
      escTo = next;
      groups = [...applyStrategy(ROUTES[next].groups, ROUTES[next].strategy), ...groups];
    }
  }
  // 跨厂商兜底池：只补链路里没出现过的厂商，且追加在最后，保持「厂商顺序」语义
  for (const g of RESERVE) {
    if (groups.some((x) => x.pid === g.pid)) continue;
    groups.push({ pid: g.pid, models: [...g.models] });
  }
  // 去重 + 展开
  const seen = new Set();
  const steps = [];
  for (const g of groups) {
    for (const m of g.models) {
      const k = `${g.pid}|${m}`;
      if (seen.has(k)) continue;
      seen.add(k);
      steps.push({ pid: g.pid, model: m });
    }
  }
  return { steps, escalated, escTo, strategy: route.strategy, route: route.name };
}

function resolveSteps(plan, tried, log, ctx) {
  let steps = plan.steps;
  // 「整条计划里有没有能力匹配的成员」必须在跳过重试/冷却之前算：
  // 否则重试时把已试过的厂商跳掉，会把「试过了」误判成「没有能力匹配的模型」
  const capableInPlan = ctx ? plan.steps.filter((s) => !incapableReason(s.pid, ctx)).length : plan.steps.length;
  const diag = { plan: steps.length, capableInPlan, retry: 0, cool: 0, capable: 0, breaker: 0, capableBlocked: false, allCooling: false };
  // 重试：跳过上一轮已试过的厂商+模型
  if (tried && tried.length) {
    const skip = new Set(tried);
    const left = steps.filter((s) => !skip.has(`${s.pid}|${s.model}`));
    if (left.length) { diag.retry = steps.length - left.length; steps = left; }
    else log.push('retry-skip=none-left');
  }
  // 模型冷却（只跳过被判定为模型问题的）
  const noCool = steps.filter((s) => !modelCooled(s.pid, s.model));
  if (noCool.length) steps = noCool; else if (steps.length) { diag.allCooling = true; log.push('model-cool=all'); }
  // 能力过滤：本地小模型不接工具调用 / 超长上下文，跳过而不是硬答
  if (ctx) {
    const capable = [];
    for (const s of steps) {
      const why = incapableReason(s.pid, ctx);
      if (why) { log.push(`skip=incapable(${s.pid}:${why})`); continue; }
      capable.push(s);
    }
    diag.capableBlocked = steps.length > 0 && capable.length === 0;
    diag.capable = capable.length;
    // 可能是空集：交给上层跨档借用有能力的厂商，而不是让不合适的模型硬答
    steps = capable;
  }
  // 厂商熔断
  const open = steps.filter((s) => !breakerOpen(s.pid));
  let allOpen = false;
  if (!open.length && steps.length) {
    // 整个计划里的厂商都在熔断冷却中：直接快速失败，不再做无谓探测
    allOpen = true;
    log.push('skip=all-open');
    steps = [];
  } else {
    if (open.length !== steps.length) log.push(`skip=breaker(${steps.length - open.length})`);
    diag.breaker = steps.length - open.length;
    steps = open;
  }
  diag.usable = steps.length;
  return { steps, allOpen, diag };
}

// ---------------------------------------------------------------- 上游请求
async function forwardOnce(prov, model, payload, res) {
  const ctrl = new AbortController();
  const onClose = () => { if (!res.writableFinished) ctrl.abort(); };
  res.on('close', onClose);
  if (res.destroyed) ctrl.abort();
  const timer = setTimeout(() => ctrl.abort(), CFG.upstreamTimeoutMs || 600000);
  const started = Date.now();
  try {
    const upstream = await fetch(`${prov.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${prov.apiKey}` },
      body: JSON.stringify({ ...payload, model }),
      signal: ctrl.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => '');
      clearTimeout(timer);
      return { ok: false, status: upstream.status, body: txt.slice(0, 800), ctrl, ms: Date.now() - started };
    }
    return { ok: true, upstream, ctrl, timer, ms: Date.now() - started };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, body: String((e && e.message) || e), ctrl, ms: Date.now() - started };
  } finally {
    res.off('close', onClose);
  }
}

async function pipeStream(upstream, res, extraHeaders, timer, ctrl, started) {
  const streamStarted = Date.now();
  const contentType = upstream.headers.get('content-type') || 'application/json';
  const isSse = contentType.toLowerCase().includes('text/event-stream');
  let firstContentMs = null;
  let doneMarker = false;
  let eventBuffer = '';
  const decoder = new TextDecoder();
  let clientCancelled = res.destroyed;
  let streamError = null;
  // 只观察事件，不修改转发字节；心跳、role 和 usage 不算首内容。
  const observeEvent = (event) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data.trim() === '[DONE]') { doneMarker = true; return; }
    try {
      const parsed = JSON.parse(data);
      if (parsed.error) streamError = 'upstream stream error';
      if (firstContentMs == null && parsed.choices?.some((choice) => {
        const delta = choice.delta || choice.message || {};
        return delta.content || delta.reasoning_content || delta.refusal || delta.tool_calls?.length || delta.function_call || choice.text;
      })) firstContentMs = Date.now() - started;
    } catch { /* 非 JSON 心跳不影响原样转发 */ }
  };
  res.writeHead(upstream.status, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    ...extraHeaders,
  });
  const reader = upstream.body.getReader();
  const onClose = () => {
    if (!res.writableFinished) {
      clientCancelled = true;
      try { ctrl.abort(); } catch { /* 忽略 */ }
      reader.cancel().catch(() => {});
    }
  };
  res.on('close', onClose);
  if (clientCancelled) { ctrl.abort(); await reader.cancel().catch(() => {}); }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (isSse) {
          eventBuffer += decoder.decode();
          if (eventBuffer.trim()) observeEvent(eventBuffer);
        }
        break;
      }
      const chunk = Buffer.from(value);
      if (isSse) {
        eventBuffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(eventBuffer))) {
          observeEvent(eventBuffer.slice(0, boundary.index));
          eventBuffer = eventBuffer.slice(boundary.index + boundary[0].length);
        }
      } else if (chunk.length && firstContentMs == null) firstContentMs = Date.now() - started;
      if (!res.write(chunk)) await new Promise((resolve) => {
        const resume = () => {
          res.off('drain', resume);
          res.off('close', resume);
          ctrl.signal.removeEventListener('abort', resume);
          resolve();
        };
        res.once('drain', resume);
        res.once('close', resume);
        ctrl.signal.addEventListener('abort', resume, { once: true });
        if (res.destroyed || ctrl.signal.aborted) resume();
      });
      if (clientCancelled) break;
      if (ctrl.signal.aborted) throw new Error('upstream timeout');
    }
  } catch (e) {
    if (!clientCancelled) streamError = String((e && e.message) || e);
  } finally {
    clearTimeout(timer);
  }
  if (!clientCancelled && !streamError && (!isSse || doneMarker)) {
    await new Promise((resolve) => {
      const settled = () => { res.off('finish', settled); res.off('close', settled); resolve(); };
      res.once('finish', settled);
      res.once('close', settled);
      res.end();
      if (res.writableFinished || res.destroyed) settled();
    });
  }
  const totalMs = Date.now() - streamStarted;
  const e2eMs = Date.now() - started;
  const state = clientCancelled ? 'client_cancelled'
    : streamError ? (ctrl.signal.aborted ? 'upstream_timeout' : 'upstream_interrupted')
      : isSse && !doneMarker ? 'upstream_interrupted' : 'completed';
  res.off('close', onClose);
  if (state !== 'completed' && !clientCancelled && !res.destroyed) res.destroy();
  return { state, firstContentMs, totalMs, e2eMs, error: streamError };
}

const recentFails = [];
function noteFail(entry) {
  recentFails.push(entry);
  if (recentFails.length > 30) recentFails.shift();
}

// ---------------------------------------------------------------- HTTP
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, version: ROUTER_VERSION,
        routes: Object.keys(ROUTES),
        providers: Object.keys(PROVIDERS).map((pid) => ({
          id: pid, baseUrl: PROVIDERS[pid].baseUrl,
          open: breakerOpen(pid), openUntil: breakers[pid]?.openUntil || 0, kind: breakers[pid]?.kind || '',
        })),
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin/health') {
      const now = Date.now();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, version: ROUTER_VERSION, ts: nowIso(),
        providers: Object.keys(PROVIDERS).map((pid) => {
          const b = breakers[pid] || null;
          return {
            id: pid, label: PROVIDERS[pid].label || pid, baseUrl: PROVIDERS[pid].baseUrl,
            open: !!(b && b.openUntil > now), openUntil: b?.openUntil || 0,
            leftMs: b && b.openUntil > now ? b.openUntil - now : 0,
            kind: b?.kind || '', reason: b?.reason || '', hits: b?.hits || 0, resetSrc: !!b?.resetSrc,
            modelsCooling: [...modelCool].filter(([k, v]) => k.startsWith(pid + '|') && v > now).map(([k]) => k.slice(pid.length + 1)),
          };
        }),
        routes: Object.fromEntries(Object.entries(ROUTES).map(([n, r]) => [n, {
          strategy: r.strategy || 'priority',
          chain: r.groups.map((g) => ({ provider: g.pid, host: hostOf(PROVIDERS[g.pid]?.baseUrl || ''), models: g.models })),
        }])),
        reserve: RESERVE.map((g) => ({ provider: g.pid, models: g.models })),
        policy: POL,
        guard: GUARD,
        cooldowns: CD,
        latency: Object.fromEntries([...provStat].filter(([, s]) => s.lat != null).map(([p, s]) => [p, Math.round(s.lat)])),
        ledger: ledger.size,
        recentFails: recentFails.slice(-12),
      }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/admin/breaker/reset') {
      const raw = await readBody(req).catch(() => Buffer.from('{}'));
      let pid = '';
      try { pid = JSON.parse(raw.toString('utf8') || '{}').provider || ''; } catch { /* 忽略 */ }
      const cleared = pid ? (clearBreaker(pid) ? [pid] : []) : Object.keys(breakers).filter((p) => clearBreaker(p));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cleared }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/admin/reload') {
      try {
        loadConfig();
        console.log(`[router] config reloaded routes=${Object.keys(ROUTES).join(',')} providers=${Object.keys(PROVIDERS).join(',')}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, routes: Object.keys(ROUTES), providers: Object.keys(PROVIDERS) }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin/plan') {
      const route = url.searchParams.get('route') || 'simple';
      const retry = Number(url.searchParams.get('retry') || 0);
      // 可带请求画像预览：?tools=19&chars=12000&n=24&stream=1
      const ctx = {
        route,
        hasTools: Number(url.searchParams.get('tools') || 0) > 0,
        toolCount: Number(url.searchParams.get('tools') || 0),
        chars: Number(url.searchParams.get('chars') || 0),
        n: Number(url.searchParams.get('n') || 0),
        stream: url.searchParams.get('stream') === '1',
        maxTokens: 0,
      };
      const plan = planFor(route, retry, []);
      const log = [];
      const resolved = resolveSteps(plan, [], log, ctx);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        route, retry, escalated: plan.escalated, escTo: plan.escTo,
        strategy: plan.strategy || 'priority',
        steps: resolved.steps.map((s) => ({ provider: s.pid, model: s.model, open: breakerOpen(s.pid) })),
        skipped: plan.steps.filter((s) => !resolved.steps.some((x) => x.pid === s.pid && x.model === s.model))
          .map((s) => ({ provider: s.pid, model: s.model, why: incapableReason(s.pid, ctx) || (breakerOpen(s.pid) ? 'breaker' : modelCooled(s.pid, s.model) ? 'cooling' : 'tried') })),
        diag: resolved.diag,
        notes: log,
      }));
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: ['auto', ...Object.keys(ROUTES)].map((id) => ({ id, object: 'model', created: 0, owned_by: 'hermes-router' })),
      }));
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      const requestStarted = Date.now();
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      let route = (() => {
        const explicit = String(body.model || '').toLowerCase();
        return ROUTES[explicit] ? explicit : (ROUTE_LOOKUP[explicit] || null);
      })();
      let stick = false;
      if (!route) {
        const text = lastUserText(messages);
        const cat = text ? await classify(text) : 'simple';
        // 分类结果必须落到配置里真实存在的档位：改名/删档后不再指向不存在的路由
        const cls = ROUTES[cat] ? cat : (ROUTES.simple ? 'simple' : Object.keys(ROUTES)[0]);
        const sticky = stickyRoute(sessionKey(messages), text || '', cls);
        stick = sticky !== cls;
        route = sticky;
      }

      const sk = sessionKey(messages);
      const lk = sk ? `${sk}|${sha1(lastUserText(messages) || '')}` : '';
      const prev = ledgerGet(lk);
      const isRetry = !!(prev && prev.ts && Date.now() - prev.ts < POL.retryWindowMs && prev.ok === false);
      const retryCount = isRetry ? (prev.count || 0) + 1 : 0;
      const tried = isRetry ? (prev.tried || []) : [];
      const rctx = requestContext(body);
      const notes = [];

      // 能力守卫：带工具的 Agent 请求不是「简单任务」，落到 simple 只会被 flash / 本地小模型糟蹋
      if (rctx.hasTools && route === 'simple' && GUARD.upgradeOnTools && ROUTES[GUARD.toolsUpgradeTo]) {
        notes.push(`upgrade=${route}->${GUARD.toolsUpgradeTo}(tools=${rctx.toolCount})`);
        route = GUARD.toolsUpgradeTo;
      }
      rctx.route = route;

      let plan = planFor(route, retryCount, tried);
      let resolved = resolveSteps(plan, tried, notes, rctx);
      // 本档没有「有能力且未熔断」的厂商时，逐级借用后面的档位（simple→coding→complex→expert）
      if (!resolved.steps.length && POL.crossTier) {
        const ti = POL.tiers.indexOf(route);
        for (let k = (ti >= 0 ? ti : 0) + 1; k < POL.tiers.length; k++) {
          const alt = planFor(POL.tiers[k], 0, tried);
          // 借档时能力判定要按「借来的那一档」算，否则 simple 的档位限制会放行本不该接单的本地模型
          const r2 = resolveSteps(alt, tried, notes, { ...rctx, route: POL.tiers[k] });
          if (r2.steps.length) {
            alt.escalated = true;
            alt.escTo = POL.tiers[k];
            plan = alt;
            resolved = r2;
            notes.push(`borrow=${POL.tiers[k]}`);
            break;
          }
        }
      }
      let steps = resolved.steps;
      if (plan.escalated) notes.push(`escalate=${plan.escTo}`);
      // 请求到达时就已经熔断的厂商：用来判断「这次请求有没有真的试出新信息」
      const preOpenAt = Date.now();
      const preOpenPids = [...new Set(plan.steps.map((s) => s.pid))].filter((p) => breakerOpen(p));

      const basePayload = { ...body };
      delete basePayload.route;
      delete basePayload.provider;

      const attempts = [];
      let lastErr = null;
      let lastCls = null;
      let i = 0;
      const drops = new Set();      // 被上游证明不支持的顶层字段（跨目标累积）
      const healed = new Set();     // pid|model|label，每个目标每种自愈只做一次
      let tempOverride;
      const t0 = Date.now();

      while (i < steps.length) {
        const step = steps[i];
        const prov = PROVIDERS[step.pid];
        if (!prov) { i++; continue; }
        // 同一厂商可能在链路里出现多次（如升档后重复），熔断后一律跳过
        if (breakerOpen(step.pid)) {
          console.log(`[router] ${nowIso()} route=${route} model=${step.model} provider=${step.pid} skip=breaker`);
          i++;
          continue;
        }
        const host = hostOf(prov.baseUrl);
        if (budgetExceeded(host)) {
          console.log(`[router] ${nowIso()} route=${route} model=${step.model} host=${host} provider=${step.pid} skip=budget`);
          attempts.push({ provider: step.pid, model: step.model, status: 0, kind: 'budget', scope: 'provider' });
          lastErr = { status: 429, body: 'daily budget exceeded: ' + host };
          lastCls = { kind: 'budget', scope: 'provider' };
          i++;
          continue;
        }
        const built = buildPayload(basePayload, prov, drops, tempOverride);
        const payload = built.payload;
        const r = await forwardOnce(prov, step.model, payload, res);
        if (res.destroyed) {
          clearTimeout(r.timer);
          r.ctrl.abort();
          if (lk) ledger.delete(lk);
          console.log(`[router] ${nowIso()} route=${route} model=${step.model} host=${host} CANCEL provider=${step.pid} state=client_cancelled first=- e2e=${Date.now() - requestStarted}ms`);
          return;
        }
        if (r.ok) {
          const extra = {
            'x-router-provider': step.pid,
            'x-router-model': step.model,
            'x-router-attempts': String(attempts.length + 1),
            'x-router-retry': String(retryCount),
            ...(plan.escalated ? { 'x-router-escalate': String(plan.escTo || '1') } : {}),
          };
          clearBreaker(step.pid);
          const stream = await pipeStream(r.upstream, res, extra, r.timer, r.ctrl, requestStarted);
          noteStat(step.pid, step.model, stream.firstContentMs != null ? stream.firstContentMs : stream.totalMs, stream.state === 'completed');
          const outcome = stream.state === 'completed' ? 'ok' : stream.state === 'client_cancelled' ? 'CANCEL' : 'FAIL';
          console.log(`[router] ${nowIso()} route=${route} model=${step.model} host=${host}${stick ? ' stick=1' : ''} ${outcome} provider=${step.pid} attempt=${attempts.length + 1} retry=${retryCount}${plan.escalated ? ' esc=1' : ''} strategy=${plan.strategy || 'priority'} dur=${stream.totalMs}ms e2e=${stream.e2eMs}ms first=${stream.firstContentMs == null ? '-' : stream.firstContentMs + 'ms'} state=${stream.state}${stream.error ? ` error=${JSON.stringify(stream.error.slice(0, 180))}` : ''}${notes.length ? ' ' + notes.join(' ') : ''}`);
          if (stream.state === 'completed') {
            if (lk) ledgerSet(lk, { ts: Date.now(), ok: true, count: retryCount, tried: [], route });
          } else if (stream.state === 'client_cancelled') {
            if (lk) ledger.delete(lk);
          } else {
            const reason = stream.state;
            const rec = { ts: nowIso(), route, provider: step.pid, model: step.model, status: 200, kind: reason, scope: 'stream', retry: retryCount, shape: shapeOf(payload), dropped: built.dropped, msg: stream.error || reason };
            noteFail(rec);
            if (lk) ledgerSet(lk, { ts: Date.now(), ok: false, count: retryCount, tried: [...new Set([...(isRetry ? prev.tried || [] : []), `${step.pid}|${step.model}`])], route });
          }
          return;
        }

        const cls = classifyFailure(r.status, r.body);
        lastCls = cls;
        noteStat(step.pid, step.model, r.ms, false);
        const rec = { ts: nowIso(), route, provider: step.pid, model: step.model, status: r.status, kind: cls.kind, scope: cls.scope, retry: retryCount, shape: shapeOf(payload), dropped: built.dropped, msg: String(r.body).replace(/\s+/g, ' ').slice(0, 240) };
        noteFail(rec);
        attempts.push({ provider: step.pid, model: step.model, status: r.status, kind: cls.kind, scope: cls.scope });
        lastErr = r;
        console.log(`[router] ${nowIso()} route=${route} model=${step.model} host=${host} provider=${step.pid} FAIL status=${r.status} kind=${cls.kind} scope=${cls.scope} retry=${retryCount} dur=${r.ms}ms shape=[${rec.shape}] dropped=${built.dropped} ${String(r.body).replace(/\s+/g, ' ').slice(0, 400)}`);

        // 模型级：参数不被支持时先就地修正再试同一目标一次
        if (cls.kind === 'temperature') {
          const key = `${step.pid}|${step.model}`;
          const t = parseTemp(r.body);
          if (t != null && !healed.has(key + '|temperature')) {
            healed.add(key + '|temperature');
            tempOverride = t;
            console.log(`[router] ${nowIso()} route=${route} model=${step.model} fix=temperature:${t} provider=${step.pid}`);
            continue; // 同一目标重试
          }
        }

        // 能力型 400：剥掉上游不认的字段，重试同一目标一次（reasoning 回显 / tools / json mode）
        const heal = healFor(r.body);
        if (heal) {
          const hk = `${step.pid}|${step.model}|${heal.label}`;
          if (!healed.has(hk)) {
            healed.add(hk);
            for (const k of heal.drop) drops.add(k);
            if (heal.label === 'max-tokens' && basePayload.max_completion_tokens != null) {
              basePayload.max_tokens = basePayload.max_completion_tokens;
              delete basePayload.max_completion_tokens;
            }
            if (heal.label === 'developer-role' && Array.isArray(basePayload.messages)) {
              basePayload.messages = basePayload.messages.map((m) => (m && m.role === 'developer' ? { ...m, role: 'system' } : m));
            }
            console.log(`[router] ${nowIso()} route=${route} model=${step.model} provider=${step.pid} fix=${heal.label} drop=[${heal.drop.join(',')}]`);
            continue; // 同一目标重试（已降级）
          }
        }

        if (cls.scope === 'request') {
          // 请求本身有问题，换模型也没用：立刻回给客户端，省掉后续无谓重试
          if (lk) ledgerSet(lk, { ts: Date.now(), ok: true, count: retryCount, tried: [], route });
          res.writeHead(r.status || 400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: `router: request rejected by ${step.pid}/${step.model}`,
              type: 'invalid_request_error', code: cls.kind,
              detail: String(r.body).slice(0, 600),
            },
          }));
          return;
        }

        if (cls.scope === 'provider') {
          // 5xx 先按「单模型故障」处理：同一厂商还有别的模型就先换模型，
          // 连续两次 5xx 才认定厂商级故障——避免一个坏模型（如 gemini-4-hydrogen）拖垮整家
          if (r.status >= 500) {
            const n5 = attempts.filter((a) => a.provider === step.pid && a.status >= 500).length;
            if (n5 < 2) {
              coolModel(step.pid, step.model);
              console.log(`[router] ${nowIso()} route=${route} model=${step.model} provider=${step.pid} downgrade=model(5xx#${n5})`);
              i++;
              continue;
            }
          }
          trip(step.pid, { ...cls, text: r.body });
          // 整家跳过：同一厂商剩下的模型不再试
          while (i < steps.length && steps[i].pid === step.pid) i++;
          continue;
        }

        // 模型级：换同厂商下一个模型
        coolModel(step.pid, step.model);
        i++;
      }

      // 全军覆没：记账，让 agent 下一次重试能接着往下走 / 升级
      if (lk) {
        const prevTried = isRetry ? (prev.tried || []) : [];
        const merged = [...new Set([...prevTried, ...steps.map((s) => `${s.pid}|${s.model}`)])];
        ledgerSet(lk, { ts: Date.now(), ok: false, count: retryCount, tried: merged, route });
      }

      const planPids = [...new Set(plan.steps.map((s) => s.pid))];
      const lefts = planPids.map((p) => breakerLeft(p)).filter((x) => x > 0);
      const minLeft = lefts.length ? Math.min(...lefts) : 0;
      const diag = resolved.diag || {};
      const poolEmpty = attempts.length === 0;
      // 一个候选都没试过时，分开两种原因：能力全被挡（永久）/ 厂商全熔断（临时）
      const noCapable = poolEmpty && diag.capableInPlan === 0;
      const allCooling = poolEmpty && diag.capableInPlan > 0;
      const retriedEnough = allCooling && GUARD.fastFailAfterRetries > 0 && retryCount >= GUARD.fastFailAfterRetries;
      const waitTooLong = allCooling && GUARD.fastFailMinWaitMs > 0 && minLeft >= GUARD.fastFailMinWaitMs;
      // 已知且「请求到达前就存在一段时间」的故障：整池都是老故障就别再让客户端等。
      // 只算请求开始前就熔断的厂商——本次请求自己试出来的新故障，说明它确实被探测过。
      const preOpenAges = preOpenPids.map((p) => preOpenAt - Date.parse(breakers[p]?.updated || 0)).filter((n) => Number.isFinite(n) && n >= 0);
      const youngestOpenMs = preOpenAges.length ? Math.min(...preOpenAges) : 0;
      const staleOutage = allCooling && GUARD.fastFailStaleMs > 0
        && preOpenAges.length > 0 && preOpenAges.length === planPids.length
        && youngestOpenMs >= GUARD.fastFailStaleMs;
      // 账号级长故障（配额 / 欠费 / 鉴权）不会因为等 30 秒就好；只要它已经存在一段时间，
      // 且客户端已经重试过一次，就别再耗它。
      const LONG_KINDS = new Set(['quota', 'balance', 'auth']);
      const hasStaleLongOutage = GUARD.fastFailStaleMs > 0 && planPids.some((p) => {
        const b = breakers[p];
        return breakerOpen(p) && LONG_KINDS.has(b?.kind) && (Date.now() - Date.parse(b?.updated || 0)) >= GUARD.fastFailStaleMs;
      });
      const longOutageRetry = allCooling && hasStaleLongOutage && retryCount >= 1;
      const fastFail = noCapable || staleOutage || longOutageRetry || retriedEnough || waitTooLong;
      const allOpen = allCooling && !fastFail;
      // 只有「请求本身不可解析」和能力/等待死局才回 400，让客户端别再空转；
      // 其余全部失败一律 502/429，客户端会按服务器故障重试。
      const reqFatal = !!(lastCls && lastCls.scope === 'request' && lastErr && lastErr.status === 400);
      const head = fastFail ? 400
        : allOpen || allCooling ? 503
          : reqFatal ? 400
            : lastErr && lastErr.status === 429 ? 429
              : 502;
      // 全熔断时按「最早恢复」估算，但至少 30 秒：避免被反复短熔断的厂商（网络型 30s）带着客户端空转
      const retryAfterSec = (allOpen || allCooling) ? (lefts.length ? Math.max(30, Math.ceil(minLeft / 1000)) : 60) : 1;
      const breakerView = Object.fromEntries(Object.keys(PROVIDERS).map((p) => {
        const b = breakers[p] || null;
        return [p, {
          open: breakerOpen(p), leftMs: breakerLeft(p), kind: b?.kind || '',
          resetAt: b && b.openUntil ? new Date(b.openUntil).toISOString() : '',
          reason: String(b?.reason || '').replace(/\s+/g, ' ').slice(0, 160),
        }];
      }));
      const deadList = planPids.filter((p) => breakerOpen(p));
      const summary = attempts.map((a) => `${a.provider}/${a.model}:${a.kind}(${a.status})`).join(' → ');
      const failKind = noCapable ? 'no-capable' : staleOutage ? `stale-${Math.round(youngestOpenMs / 1000)}s` : longOutageRetry ? `long-outage-${retryCount}` : retriedEnough ? `retried-${retryCount}` : waitTooLong ? `wait-${Math.ceil(minLeft / 1000)}s` : '';
      const why = noCapable
        ? `no model in route ${route} can serve this request (${shapeOf(basePayload)}); excluded by capabilities: ${notes.filter((n) => n.startsWith('skip=incapable')).join(' ') || 'all candidates'}`
        : `all providers for route ${route} are cooling down (${deadList.map((p) => `${p}:${breakers[p]?.kind || '?'}`).join(', ')}); earliest recovery in ${Math.ceil(minLeft / 1000)}s`;
      console.log(`[router] ${nowIso()} route=${route} FAILALL head=${head} attempts=${attempts.length} allOpen=${allOpen} fastfail=${failKind || '-'} retry=${retryCount} last=${lastCls ? lastCls.kind : '-'} strategy=${plan.strategy || 'priority'} shape=[${shapeOf(basePayload)}] ${summary} dur=${Date.now() - t0}ms`);
      res.writeHead(head, {
        'content-type': 'application/json',
        ...(retryAfterSec && !fastFail ? { 'retry-after': String(retryAfterSec) } : {}),
        'x-router-reason': lastCls ? lastCls.kind : 'unknown',
        ...(fastFail ? { 'x-router-retryable': '0', 'x-router-fail': failKind } : {}),
      });
      res.end(JSON.stringify({
        error: {
          message: fastFail ? `router: ${why} — not retrying` : (allOpen || allCooling)
            ? `router: all providers are cooling down for route ${route}; retry in ${retryAfterSec}s`
            : `router: all candidates failed for route ${route}${plan.escalated ? ` (escalated to ${plan.escTo || 'reserve'})` : ''}`,
          type: fastFail ? (noCapable ? 'router_no_capable_model' : 'router_cooling') : (allOpen || allCooling) ? 'router_all_open' : 'router_unavailable',
          retryable: !fastFail,
          retryAfterSec: fastFail ? 0 : retryAfterSec,
          hint: noCapable
            ? '本地模型不支持这次请求（工具调用 / 上下文长度 / 档位），云端又不可用。换一个能做工具调用的厂商，或等云端恢复。'
            : fastFail ? '云端账号都在熔断或额度用尽，重试同一个请求只会继续等；恢复后再发。' : '',
          route, retry: retryCount, escalated: plan.escalated, strategy: plan.strategy || 'priority',
          shape: shapeOf(basePayload),
          attempts,
          providers: breakerView,
        },
      }));
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
  console.log(`[router] v${ROUTER_VERSION} listening on 127.0.0.1:${CFG.port} routes=${Object.keys(ROUTES).join(',')} providers=${Object.keys(PROVIDERS).join(',')}`);
});
