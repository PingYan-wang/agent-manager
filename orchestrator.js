// orchestrator.js — 跨 Agent 任务编排器（Loop + 子 Agent + 辩论 + 自动续步）
// 由 server.js 挂载: initOrchestrator() 启动 tick; handleOrchestratorApi() 处理 /api/orchestrator/*
import { readFile, writeFile, mkdir, access, rename, unlink } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const STATE_PATH = path.join(DATA_DIR, 'orchestrator.json');
const WORK_ROOT = path.join(DATA_DIR, 'orchestrator-work');

const DEFAULT_CONFIG = {
  enabled: false,          // 总开关：loop 编排
  crossClient: false,      // 跨 Client 开关：允许派发给 codex/devin 等其他 Agent CLI
  autoContinue: true,      // 任务完成后自动规划下一步优化（持续保活）
  maxContinuations: 5,     // 自动续步上限
  tickSeconds: 15,
  maxConcurrent: 2,        // 同时运行的子 Agent 数
  dispatchTimeoutMs: 15 * 60 * 1000,
  maxRepairs: 3,           // 验收失败后最多返工轮数
  maxDepth: 2,             // 递归拆解深度上限（子 Agent 发现步骤过复杂可再拆，拆到能执行为止）
  planner: {
    baseUrl: 'http://127.0.0.1:8788/v1',
    apiKey: 'hermes-local-router',
    model: 'complex',      // 规划/验收固定用这一个模型，不来回切
  },
};

// Hermes CLI 的 shebang 是 `#!/usr/bin/env python3`，在 macOS 自带的 python 3.9 下会因
// `str | None` 语法直接崩溃（TypeError: unsupported operand type(s) for |）。必须显式用
// 装了依赖的 venv python 启动，否则派发给 Hermes 的子任务全部瞬间失败。
function resolveHermesPython() {
  const cands = [];
  const installs = path.join(HOME, '.hermes', 'installs');
  try {
    for (const a of readdirSync(installs)) {
      const envs = path.join(installs, a, 'environments');
      let names = [];
      try { names = readdirSync(envs); } catch { continue; }
      for (const b of names) {
        cands.push(path.join(envs, b, 'venv', 'bin', 'python3'));
        cands.push(path.join(envs, b, 'venv', 'bin', 'python'));
      }
    }
  } catch { /* 没有 installs 目录就走下面的兜底 */ }
  cands.push(path.join(HOME, '.hermes', 'hermes-agent', 'venv', 'bin', 'python3'));
  for (const p of cands) if (existsSync(p)) return p;
  return 'python3';
}
const HERMES_PYTHON = resolveHermesPython();
const HERMES_CLI = path.join(HOME, '.hermes', 'hermes-agent', 'hermes');

// worker 适配器：{prompt} 占位符替换为任务提示词；available() 探测是否可用
const AGENT_WORKERS = {
  hermes: {
    label: 'Hermes',
    cmd: HERMES_PYTHON,
    args: [HERMES_CLI, '-z', '{prompt}'],
    always: true,
    note: 'venv python + hermes -z 无头模式，本地路由',
  },
  codex: {
    label: 'Codex',
    cmd: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    args: ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '{prompt}'],
    note: '认证走 ChatGPT App 会话（非 auth.json）；二进制存在即视为可用，运行时失败会记录在任务日志',
    authCheck: async () => {
      // codex CLI 内嵌于 ChatGPT.app，认证由 App 会话管理，auth.json 不存在也能跑
      try { await access(AGENT_WORKERS.codex.cmd); return true; } catch { return false; }
    },
  },
  devin: {
    label: 'Devin',
    cmd: '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin',
    args: ['-p', '--permission-mode', 'accept-edits', '--', '{prompt}'],
    note: '认证走 Devin App 会话；二进制存在即视为可用，运行时失败会记录在任务日志',
    authCheck: async () => {
      // devin CLI 内嵌于 Devin.app，认证由 App 管理，config.json 无 token 也能跑
      try { await access(AGENT_WORKERS.devin.cmd); return true; } catch { return false; }
    },
  },
};

// ---------- state ----------
let state = { config: structuredClone(DEFAULT_CONFIG), tasks: [], agents: [] }; // agents: 子 Agent 池实例
let dirty = false;
let saveFlight = null;
let tickFlight = null;
let initialized = false;
let initFlight = null;
let shuttingDown = false;
let tickTimer = null;
let saveTimer = null;
const executions = new WeakMap();
const runtime = { fetch: (...args) => fetch(...args), workers: AGENT_WORKERS, killGraceMs: 1000,
  writeFile, rename };
const pendingDispatch = new Map(); // taskId -> Map(stepKey -> Promise)
const running = new Map(); // stepKey -> {child, taskId, stepId, agent, startedAt}

class Cancelled extends Error {}
function executionFor(task) {
  if (!executions.has(task)) executions.set(task, { controller: new AbortController(), plannerVersion: 0, planners: new Set() });
  return executions.get(task);
}
function assertCurrent(task, execution, planner = false) {
  if (shuttingDown || findTask(task.id) !== task || executions.get(task) !== execution || execution.controller.signal.aborted || (planner && task.status === 'paused')) throw new Cancelled('任务执行已失效');
}
function invalidate(task) {
  executionFor(task).controller.abort();
  executions.delete(task);
  for (const entry of running.values()) if (entry.taskId === task.id) entry.terminate();
  for (const step of task.plan || []) if (step.status === 'running') {
    step.status = 'interrupted';
    stepNode(task, step, { status: 'interrupted', detail: '执行已中止；重试前需人工确认副作用' });
  }
  dirty = true;
}

async function load() {
  let loaded;
  try { loaded = JSON.parse(await readFile(STATE_PATH, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error(`无法加载编排器状态: ${error.message}`); }
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || !Array.isArray(loaded.tasks) || !Array.isArray(loaded.agents) || !loaded.config || typeof loaded.config !== 'object') throw new Error('编排器状态结构损坏');
  for (const task of loaded.tasks) {
    if (!task || typeof task.id !== 'string' || !Array.isArray(task.plan) || (task.tree !== undefined && !Array.isArray(task.tree))) throw new Error('编排器任务状态损坏');
    if (task.plan.length) validateSteps(task.plan);
    migrateTaskTree(task);
  }
  state = { ...state, ...loaded };
  state.config = { ...structuredClone(DEFAULT_CONFIG), ...state.config };
  state.config.planner = { ...DEFAULT_CONFIG.planner, ...(state.config.planner || {}) };
}
export function flushOrchestrator() {
  if (saveFlight) return saveFlight;
  saveFlight = (async () => {
    while (dirty) {
      dirty = false;
      const snapshot = JSON.stringify(state, null, 2);
      const temporary = `${STATE_PATH}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(STATE_PATH), { recursive: true });
        await runtime.writeFile(temporary, snapshot);
        await runtime.rename(temporary, STATE_PATH);
      } catch (error) {
        dirty = true;
        await unlink(temporary).catch(() => {});
        throw error;
      }
    }
  })().finally(() => { saveFlight = null; });
  return saveFlight;
}
const save = flushOrchestrator;

function log(task, level, msg) {
  task.log = task.log || [];
  task.log.push({ ts: Date.now(), level, msg: String(msg).slice(0, 500) });
  if (task.log.length > 300) task.log = task.log.slice(-300);
  dirty = true;
}
const findTask = (id) => state.tasks.find((t) => t.id === id);
const BEARER = (key) => `Bearer ${key}`;

// ---------- 子 Agent 池 + 执行树 + 失败自愈 ----------
function classifyFail(text) {
  const s = String(text || '');
  if (/quota|insufficient|余额不足|额度不足|credit|billing|429|rate.?limit/i.test(s)) return 'quota';
  if (/ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|连接|超时|timeout/i.test(s)) return 'network';
  return 'llm';
}

function createPoolAgent(client) {
  const w = runtime.workers[client];
  if (!w) return null;
  const n = (state.agents || []).filter((a) => a.client === client).length + 1;
  const ag = { id: `a_${client}_${n}_${Date.now().toString(36)}`, client, label: `${w.label} #${n}`, status: 'idle', createdAt: Date.now(), lastUsed: 0 };
  state.agents.push(ag); dirty = true; return ag;
}

// 选一个可用池实例：优先空闲；并行额度内自动扩容；否则复用最久未用
function pickPoolAgent(client) {
  const now = Date.now();
  const mine = (state.agents || []).filter((a) => a.client === client && !(a.cooldownUntil > now));
  const idle = mine.filter((a) => a.status !== 'busy').sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  if (idle.length) return idle[0];
  const maxPar = Math.max(1, state.config.maxConcurrent || 2);
  if (mine.length < maxPar || !mine.length) return createPoolAgent(client);
  return mine.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))[0];
}

// 失败自愈候选：首选 client +（跨 Client 开启时）一个备选 client
function recoveryCandidates(client) {
  const out = [client];
  if (state.config.crossClient) {
    for (const c of allowedAgents()) if (c !== client) { out.push(c); break; }
  }
  return out;
}

// 兼容旧数据：旧任务只有 plan 没有 tree，按 plan 重建 goal/plan/step 节点
function migrateTaskTree(task) {
  if (Array.isArray(task.tree) && task.tree.length) return;
  task.tree = [];
  const goal = { id: 'n1', kind: 'goal', label: String(task.goal || '').slice(0, 80),
    status: task.status === 'done' ? 'done' : task.status === 'blocked' ? 'failed' : 'pending',
    ts: task.createdAt || Date.now(), endTs: task.status === 'done' ? (task.updatedAt || Date.now()) : undefined };
  task.tree.push(goal);
  if (!task.plan || !task.plan.length) { dirty = true; return; }
  const plan = { id: 'n2', kind: 'plan', label: '执行计划', parentId: goal.id,
    status: task.status === 'done' ? 'done' : 'pending', ts: task.createdAt || Date.now() };
  task.tree.push(plan);
  for (const s of task.plan) {
    task.tree.push({ id: `step_${s.id}`, kind: 'step', parentId: plan.id,
      label: `${s.id} ${s.title || ''}`.trim(), agent: s.agent, status: s.status || 'pending',
      ts: s.startedAt || task.createdAt || Date.now(), endTs: s.endedAt || undefined,
      stepId: s.id, deps: s.deps || [], depth: s.depth || 0, needsDebate: !!s.needsDebate,
      progress: s.status === 'done' ? 100 : 0, detail: s.result ? String(s.result).slice(0, 200) : undefined });
  }
  dirty = true;
}

// 执行树节点
function ensureTree(task) { if (!Array.isArray(task.tree)) task.tree = []; }
function nodeFind(task, id) { return (task.tree || []).find((n) => n.id === id) || null; }
function nodePatch(task, id, patch) {
  const n = nodeFind(task, id); if (!n) return null;
  Object.assign(n, patch);
  if (patch.status === 'done' || patch.status === 'failed') n.endTs = Date.now();
  dirty = true; return n;
}
function trunkNode(task, kind, label, extra) {
  ensureTree(task);
  const n = { id: `n${task.tree.length + 1}`, kind, label: String(label || '').slice(0, 120), status: 'running', ts: Date.now(), ...(extra || {}) };
  task.tree.push(n); dirty = true; return n;
}
function goalNode(task, patch) {
  ensureTree(task);
  let n = task.tree.find((x) => x.kind === 'goal');
  if (!n) { n = { id: 'n1', kind: 'goal', label: String(task.goal || '').slice(0, 80), status: 'pending', ts: task.createdAt || Date.now() }; task.tree.unshift(n); }
  return nodePatch(task, n.id, patch);
}
function planNodeFor(task, create) {
  ensureTree(task);
  let n = task.tree.find((x) => x.kind === 'plan');
  if (!n && create) n = trunkNode(task, 'plan', '执行计划', {});
  return n || null;
}
function ensureStepNode(task, step) {
  ensureTree(task);
  const id = `step_${step.id}`;
  let n = nodeFind(task, id);
  if (!n) {
    const plan = planNodeFor(task);
    const parentId = step.parentStep && nodeFind(task, `step_${step.parentStep}`) ? `step_${step.parentStep}` : (plan ? plan.id : null);
    n = { id, kind: 'step', parentId, label: `${step.id} ${step.title || ''}`.trim(), agent: step.agent, status: 'pending', ts: Date.now(),
      stepId: step.id, deps: step.deps || [], depth: step.depth || 0, needsDebate: !!step.needsDebate, progress: 0 };
    task.tree.push(n); dirty = true;
  }
  return n;
}
function stepNode(task, step, patch) {
  const n = ensureStepNode(task, step);
  nodePatch(task, n.id, patch);
  return n;
}

// ---------- 递归聚合（参考 recursive-learning bucketMastery：父 = 0.7×min + 0.3×avg 短板优先） ----------
// 在 tree 节点上原地写 progress / gate 字段，由前端渲染进度条与依赖锁
function aggregateProgress(task) {
  const nodes = task.tree || [];
  if (!nodes.length) return;
  const byId = {}; nodes.forEach((n) => { byId[n.id] = n; });
  const kids = {}; nodes.forEach((n) => { const p = n.parentId && byId[n.parentId] ? n.parentId : null; (kids[p] = kids[p] || []).push(n); });
  const plan = task.plan || [];
  const stepById = {}; plan.forEach((s) => { stepById[s.id] = s; });

  // deps 闸门：只对 step 节点算，跨分支且依赖未 done 时记录 gate
  for (const n of nodes) {
    if (n.kind !== 'step' || !n.stepId) continue;
    const s = stepById[n.stepId];
    if (!s) continue;
    const deps = s.deps || [];
    const pending = deps.filter((d) => {
      const dn = stepById[d];
      return !dn || dn.status !== 'done';
    });
    if (pending.length && n.status === 'pending') {
      n.gate = { waitingFor: pending };
    } else if (n.gate) {
      delete n.gate;
    }
  }

  // 递归聚合 progress：叶子看 status，父节点 0.7min + 0.3avg
  function leafProgress(n) {
    if (n.status === 'done') return 100;
    if (n.status === 'failed') return 0;
    if (n.status === 'running' || n.status === 'retrying') return Math.max(10, n.progress || 10);
    return n.progress || 0;
  }
  function calc(n) {
    const ks = kids[n.id] || [];
    if (!ks.length) { n.progress = leafProgress(n); return n.progress; }
    let sum = 0, min = 100;
    for (const k of ks) { const p = calc(k); sum += p; if (p < min) min = p; }
    const avg = sum / ks.length;
    n.progress = Math.round(0.7 * min + 0.3 * avg);
    return n.progress;
  }
  (kids[null] || []).forEach(calc);
  dirty = true;
}

// 带失败自愈的派发：重试 → 冷却 → 切换备选 client
async function dispatchWithRecovery(task, step, persona, nodeId, execution, primary = step.agent) {
  const candidates = [primary];
  if (state.config.crossClient) for (const client of allowedAgents()) if (client !== primary) { candidates.push(client); break; }
  const maxAttempts = candidates.length > 1 ? 3 : 2;
  let last = { ok: false, error: 'no attempt', code: -1, output: '' };
  let attempt = 0;
  for (const client of candidates) {
    const reps = client === primary ? 2 : 1;
    for (let rep = 0; rep < reps && attempt < maxAttempts; rep++, attempt++) {
      assertCurrent(task, execution);
      if (task.status === 'paused' && attempt > 0) return last;
      const ag = pickPoolAgent(client);
      if (!ag) continue;
      ag.status = 'busy'; ag.lastUsed = Date.now(); ag.taskId = task.id; ag.stepId = step.id; dirty = true;
      const isRetry = attempt > 0;
      nodePatch(task, nodeId, { status: isRetry ? 'retrying' : 'running', agent: client, agentId: ag.id, detail: isRetry ? `第 ${attempt + 1} 次尝试` : undefined, attempt: attempt + 1 });
      if (isRetry) log(task, 'warn', `步骤 ${step.id} 第 ${attempt + 1} 次尝试 → ${ag.label}(${client})`);
      const r = await dispatchStep(task, step, persona, ag);
      if (execution.controller.signal.aborted) { ag.status = 'idle'; ag.taskId = undefined; ag.stepId = undefined; dirty = true; }
      assertCurrent(task, execution);
      if (task.status === 'paused') { ag.status = 'idle'; ag.taskId = undefined; ag.stepId = undefined; dirty = true; return r; }
      if (r.ok) { ag.status = 'idle'; ag.taskId = undefined; ag.stepId = undefined; dirty = true; return r; }
      last = r;
      const cls = classifyFail(r.error || r.output || '');
      const cooldown = cls === 'quota' ? 30 * 60000 : 5 * 60000;
      ag.status = 'cooldown'; ag.cooldownUntil = Date.now() + cooldown; ag.lastError = String(r.error || r.output || '').slice(0, 200);
      ag.taskId = undefined; ag.stepId = undefined; dirty = true;
      log(task, 'warn', `步骤 ${step.id} 尝试${attempt + 1}失败(${cls}) ${ag.label}: ${String(r.error || '').slice(0, 120)}`);
      if (cls === 'quota') break; // 额度类不在同 client 重试，直接换备选
    }
  }
  nodePatch(task, nodeId, { status: 'failed', detail: String(last.error || `exit ${last.code}`).slice(0, 200) });
  return last;
}

// ---------- planner ----------
function validateSteps(steps, existing = []) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 100) throw new Error('计划 steps 必须为 1–100 项数组');
  const ids = new Set();
  const normalized = steps.map((step) => {
    if (!step || typeof step.id !== 'string' || !/^[\w.-]{1,100}$/.test(step.id) || ids.has(step.id)) throw new Error('步骤 id 缺失、无效或重复');
    ids.add(step.id);
    if (typeof step.title !== 'string' || !step.title.trim() || typeof step.prompt !== 'string' || !step.prompt.trim()) throw new Error('步骤 title/prompt 必须为非空字符串');
    if (!Object.hasOwn(runtime.workers, step.agent)) throw new Error(`未知步骤 agent: ${step.agent}`);
    if (!Array.isArray(step.deps) || step.deps.some((id) => typeof id !== 'string') || new Set(step.deps).size !== step.deps.length) throw new Error('步骤 deps 必须为不重复的 id 数组');
    if (step.needsDebate !== undefined && typeof step.needsDebate !== 'boolean') throw new Error('needsDebate 必须为布尔值');
    return { ...step, deps: [...step.deps] };
  });
  const graph = new Map(existing.map((step) => [step.id, step]));
  normalized.forEach((step) => graph.set(step.id, step));
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('步骤依赖存在环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of graph.get(id).deps || []) {
      if (!graph.has(dep) || dep === id) throw new Error(`步骤 ${id} 存在未知或自身依赖: ${dep}`);
      visit(dep);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return normalized;
}
function validateReply(reply, task, actions) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || !actions.includes(reply.action)) throw new Error('planner 返回了不符合当前阶段的 action');
  if (['decompose', 'repair'].includes(reply.action)) reply.steps = validateSteps(reply.steps, reply.action === 'repair' ? task.plan || [] : []);
  if (reply.action === 'verify' && (typeof reply.pass !== 'boolean' || typeof reply.feedback !== 'string')) throw new Error('verify 需要布尔 pass 和字符串 feedback');
  for (const [action, field] of [['done', 'summary'], ['next_goal', 'goal'], ['blocked', 'reason']]) {
    if (reply.action === action && (typeof reply[field] !== 'string' || !reply[field].trim())) throw new Error(`${action} 需要非空 ${field}`);
  }
  return reply;
}
function applyRepair(task, reply) {
  const replacements = new Map(reply.steps.map((step) => [step.id, { ...step, status: 'pending', result: undefined, depth: 0 }]));
  task.plan = task.plan.map((step) => replacements.get(step.id) || step);
  for (const step of replacements.values()) if (!task.plan.some((old) => old.id === step.id)) task.plan.push(step);
  for (const step of replacements.values()) stepNode(task, step, { status: 'pending', detail: undefined });
  dirty = true;
}
async function plannerChat(task, userPrompt, execution, actions) {
  assertCurrent(task, execution, true);
  const plannerVersion = execution.plannerVersion;
  const check = () => { assertCurrent(task, execution, true); if (execution.plannerVersion !== plannerVersion) throw new Cancelled('规划阶段已失效'); };
  const p = state.config.planner;
  const agents = await availableAgents();
  check();
  const sys = `你是一个任务编排规划器。你管理一个多 Agent 系统，目标是把用户目标拆成可执行的子任务并派发给子 Agent。
可用子 Agent: ${JSON.stringify(agents.map((a) => ({ id: a.id, available: a.available })))}
规则:
- 只输出一个 JSON 对象，不要 markdown 代码块。
- action 枚举: decompose | dispatch_note | debate_mark | verify | done | next_goal | blocked | repair
- decompose: {"action":"decompose","steps":[{"id":"s1","title":"...","agent":"hermes","prompt":"给子agent的完整指令","deps":[],"needsDebate":false}]}
- verify: {"action":"verify","pass":true|false,"feedback":"..."}  (pass=true 表示任务可验收完成)
- done: {"action":"done","summary":"..."}
- next_goal: {"action":"next_goal","goal":"基于已完成工作提出的下一步优化目标"} (仅在 autoContinue 场景)
- blocked: {"action":"blocked","reason":"..."}
- repair: {"action":"repair","steps":[...同 decompose 结构...]}
- 辩论: 当步骤需要正反方论证时设 needsDebate=true，引擎会派两个 Agent 各执一词再综合。
- 跨 Client 开关当前: ${state.config.crossClient ? '开(可用全部 agent)' : '关(只能用 hermes)'}
- 步骤的 agent 字段填客户端类型(hermes/codex/devin)即可；系统会从子 Agent 池自动选择空闲实例并行执行，一个 client 可有多个实例。
- 子 Agent 提示词要自包含：包含背景、输入、期望输出、验收标准。`;
  const body = {
    model: p.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `任务目标: ${task.goal}\n\n当前计划:\n${JSON.stringify(task.plan || [], null, 1)}\n\n最近结果:\n${JSON.stringify((task.plan || []).filter((s) => s.result).map((s) => ({ id: s.id, status: s.status, result: String(s.result).slice(0, 1500) })), null, 1)}\n\n工作目录: ${task.workdir}\n\n当前阶段指令:\n${userPrompt}\n\n请输出下一步 JSON。` },
    ],
  };
  const controller = new AbortController();
  execution.planners.add(controller);
  const cancel = () => controller.abort();
  execution.controller.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 120000);
  const PLANNER_RETRIES = 3;
  try {
    let res, lastErr;
    for (let attempt = 0; attempt < PLANNER_RETRIES; attempt++) {
      check();
      try {
        res = await runtime.fetch(`${p.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: BEARER(p.apiKey) },
          body: JSON.stringify(body), signal: controller.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`planner HTTP ${res.status}`);
          const retryAfter = Number(res.headers?.get?.('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * (attempt + 1);
          log(task, 'warn', `planner ${res.status}，${wait}ms 后重试 (${attempt + 1}/${PLANNER_RETRIES})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) throw new Error(`planner HTTP ${res.status}`);
        lastErr = null;
        break;
      } catch (error) {
        if (error.name === 'AbortError' || error instanceof Cancelled) throw error;
        lastErr = error;
        if (attempt < PLANNER_RETRIES - 1) {
          log(task, 'warn', `planner ${error.message}，${500 * (attempt + 1)}ms 后重试 (${attempt + 1}/${PLANNER_RETRIES})`);
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
      }
    }
    check();
    if (lastErr) throw lastErr;
    const j = await res.json();
    check();
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('planner 响应缺少字符串 content');
    const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return validateReply(JSON.parse(raw), task, actions);
  } catch (error) {
    check();
    throw error;
  } finally {
    execution.planners.delete(controller);
    clearTimeout(timer);
    execution.controller.signal.removeEventListener('abort', cancel);
  }
}

async function availableAgents() {
  const out = [];
  for (const [id, w] of Object.entries(runtime.workers)) {
    let ok = true;
    if (w.authCheck) { try { ok = await w.authCheck(); } catch { ok = false; } }
    out.push({ id, label: w.label, available: ok, note: w.note, crossOnly: id !== 'hermes' });
  }
  return out;
}

function allowedAgents() {
  // crossClient=off 时只允许 hermes（本地常驻 worker）
  return Object.keys(runtime.workers).filter((id) => state.config.crossClient || id === 'hermes');
}

// ---------- dispatch ----------
function buildPrompt(step, task) {
  const depth = step.depth || 0;
  const maxDepth = state.config.maxDepth ?? 2;
  const splitHint = depth < maxDepth
    ? `\n\n【递归拆解】如果你判断此步骤过于复杂、无法一次完成：先不要动手，直接输出第一行 <<<SPLIT>>>，第二行起用 JSON 给出 2-6 个更小的子步骤（格式 {"steps":[{"title":"...","prompt":"自包含提示词","agent":"hermes|codex|devin"}]}），子步骤将由子 Agent 递归执行后合并。`
    : '';
  return `${step.prompt}\n\n---\n背景: 这是整体任务「${task.goal}」的子任务(${step.id}: ${step.title})。工作目录: ${task.workdir}。请完成后输出清晰的结果摘要。${splitHint}`;
}

function dispatchStep(task, step, persona, agent) {
  const client = agent?.client || step.agent;
  const w = runtime.workers[client];
  if (!w) return Promise.resolve({ ok: false, error: `未知 agent ${client}` });
  const prompt = persona ? `${persona}\n\n${buildPrompt(step, task)}` : buildPrompt(step, task);
  const args = w.args.map((a) => (a === '{prompt}' ? prompt : a));
  const key = `${task.id}:${step.id}${persona ? ':' + persona.slice(0, 8) : ''}`;
  const agentId = agent?.id || null;
  const execution = executionFor(task);
  assertCurrent(task, execution);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(w.cmd, args, { cwd: task.workdir || HOME, detached: process.platform !== 'win32', env: { ...process.env, PATH: `${HOME}/.npm-global/bin:${process.env.PATH}` } });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    let out = '', err = '', done = false, terminating = false, killTimer;
    const signalGroup = (signal) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (e) { if (e.code !== 'ESRCH') console.log('[orch] kill failed:', e.message); }
    };
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), runtime.killGraceMs);
    };
    const timer = setTimeout(terminate, state.config.dispatchTimeoutMs);
    const finish = (result) => {
      if (done) return;
      done = true; clearTimeout(timer);
      // 终止后即使父进程先退出，也继续清理可能遗留的同组子进程。
      if (!terminating) clearTimeout(killTimer);
      running.delete(key);
      resolve(result);
    };
    child.stdout.on('data', (d) => { out += d; if (out.length > 400000) out = out.slice(-400000); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 100000) err = err.slice(-100000); });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const text = (out || '') + (err ? `\n[stderr]\n${err.slice(-3000)}` : '');
      finish({ ok: code === 0 && !terminating, code, output: text.slice(-12000), error: terminating ? 'worker 已终止或超时' : undefined });
    });
    running.set(key, { child, terminate, taskId: task.id, stepId: step.id, agent: client, agentId, startedAt: Date.now() });
    log(task, 'info', `dispatch ${step.id} → ${agent?.label || client}${persona ? ' (' + persona + ')' : ''}`);
    dirty = true;
  });
}

// ---------- engine ----------
export function tick() {
  if (tickFlight) return tickFlight;
  tickFlight = (async () => {
    if (!state.config.enabled || shuttingDown) return;
    const active = state.tasks.filter((t) => ['pending', 'planning', 'running', 'verifying'].includes(t.status));
    for (const task of active) {
      const execution = executionFor(task);
      try { await stepTask(task, execution); }
      catch (e) {
        if (!(e instanceof Cancelled) && findTask(task.id) === task && executions.get(task) === execution) {
          log(task, 'error', 'tick error: ' + e.message); task.status = 'blocked'; goalNode(task, { status: 'blocked', detail: String(e.message).slice(0, 200) });
        }
      }
      await save().catch((e) => console.log('[orch] save failed:', e.message));
    }
  })().finally(() => { tickFlight = null; });
  return tickFlight;
}

async function stepTask(task, execution) {
  // 1) 还没有计划 → 让 planner 拆解
  if (!task.plan || !task.plan.length) {
    task.status = 'planning';
    goalNode(task, { status: 'running', detail: '规划中' });
    log(task, 'info', '请求 planner 拆解任务');
    const d = await plannerChat(task, '请将该目标拆解为子任务 steps(decompose)。若目标简单可只拆 1-2 步。', execution, ['decompose', 'blocked']);
    if (d.action === 'decompose' && Array.isArray(d.steps) && d.steps.length) {
      task.plan = d.steps.map((s, i) => ({
        id: s.id || `s${i + 1}`, title: s.title || `step ${i + 1}`, agent: s.agent || 'hermes',
        prompt: s.prompt || s.title || '', deps: s.deps || [], needsDebate: !!s.needsDebate,
        status: 'pending', depth: 0,
      }));
      task.status = 'running';
      const pn = planNodeFor(task, true);
      if (pn) nodePatch(task, pn.id, { detail: `${task.plan.length} 个子任务` });
      log(task, 'info', `计划就绪: ${task.plan.map((s) => `${s.id}(${s.agent})`).join(', ')}`);
    } else {
      log(task, 'warn', 'planner 未返回 decompose: ' + JSON.stringify(d).slice(0, 300));
      task.status = 'blocked';
      goalNode(task, { status: 'blocked', detail: 'planner 未返回计划' });
    }
    return;
  }

  // 2) 检查运行中的步骤（spawn 是同步登记、close 回调异步——用结果轮询替代）
  // 简化: dispatchStep 是 await 的 promise; 为支持并发, 先收集 runningPromises
  let pend = pendingDispatch.get(task.id); if (!pend) { pend = new Map(); pendingDispatch.set(task.id, pend); }

  // 3) 全部终态 → 验收
  const steps = task.plan;
  // 2.5) 递归拆解父步骤收口：子步骤全部结束后合并回父步骤（逐层整合）
  for (const s of steps) {
    if (s.status !== 'split') continue;
    const children = steps.filter((c) => c.parentStep === s.id);
    if (!children.length) { s.status = 'failed'; s.result = '拆解后无子步骤'; continue; }
    if (children.every((c) => c.status === 'done')) {
      s.status = 'done';
      s.result = `由 ${children.length} 个子步骤合并：\n` + children.map((c) => `- ${c.id} ${c.title}: ${(c.result || '').slice(0, 500)}`).join('\n');
      stepNode(task, s, { status: 'done', detail: `已合并 ${children.length} 个子步骤` });
      log(task, 'info', `步骤 ${s.id} 子步骤全部完成，已合并`);
    } else if (children.every((c) => ['done', 'failed'].includes(c.status)) && children.some((c) => c.status === 'failed')) {
      s.status = 'failed';
      s.result = `子步骤失败: ${children.filter((c) => c.status === 'failed').map((c) => c.id).join(', ')}`;
      stepNode(task, s, { status: 'failed', detail: s.result });
      log(task, 'warn', `步骤 ${s.id} 子步骤失败，标记失败`);
    }
  }
  const allDone = steps.every((s) => ['done', 'failed'].includes(s.status)) && pend.size === 0;
  if (allDone) {
    task.status = 'verifying';
    const pn0 = planNodeFor(task);
    if (pn0 && !['done', 'failed'].includes(pn0.status)) nodePatch(task, pn0.id, { status: steps.some((s) => s.status === 'failed') ? 'failed' : 'done', detail: `${steps.length} 步全部结束` });
    const failed = steps.filter((s) => s.status === 'failed');
    if (failed.length && (task.repairs || 0) < state.config.maxRepairs) {
      task.repairs = (task.repairs || 0) + 1;
      log(task, 'warn', `验收前自检: ${failed.length} 步失败, 返工第 ${task.repairs} 轮`);
      const d = await plannerChat(task, `以下步骤失败: ${failed.map((s) => s.id).join(',')}。请输出 repair 计划补齐或替代方案。`, execution, ['repair', 'blocked']);
      if (d.action === 'repair' && Array.isArray(d.steps)) {
        applyRepair(task, d);
        trunkNode(task, 'repair', `返工第 ${task.repairs} 轮`, { detail: `${d.steps.length} 个补救步骤` });
        task.status = 'running';
        return;
      }
      task.status = 'awaiting_review';
      task.reviewDeadline = Date.now() + REVIEW_TIMEOUT_MS;
      task.reviewNodeId = trunkNode(task, 'review', '人工裁决', { status: 'awaiting', detail: '返工规划失败' }).id;
      log(task, 'warn', '返工规划失败，转人工裁决（24h 超时自动终止）');
      return;
    }
    // planner 验收
    const verifyNode = trunkNode(task, 'verify', '验收', {});
    const v = await plannerChat(task, '所有子任务已完成。请验收整体目标是否达成: verify(pass=true/false, feedback)。若未完全达成请说明差距。若已完全达成也可直接返回 done+summary。', execution, ['verify', 'done', 'blocked']);
    const verifyPass = (v.action === 'verify' && v.pass) || v.action === 'done';
    nodePatch(task, verifyNode.id, { status: verifyPass ? 'done' : 'failed', detail: (v.feedback || v.summary || '').slice(0, 300) });
    // planner 可能返回 verify(pass=true) 或直接 done+summary，两者都视为验收通过
    if ((v.action === 'verify' && v.pass) || v.action === 'done') {
      task.status = 'done';
      task.summary = v.feedback || v.summary || '';
      goalNode(task, { status: 'done', detail: (task.summary || '').slice(0, 200) });
      log(task, 'info', '验收通过: ' + (v.feedback || '').slice(0, 200));
      await maybeContinue(task, execution);
    } else if (v.action === 'verify' && !v.pass && (task.repairs || 0) < state.config.maxRepairs) {
      task.repairs = (task.repairs || 0) + 1;
      log(task, 'warn', '验收未通过: ' + (v.feedback || '').slice(0, 200));
      const d = await plannerChat(task, `验收反馈: ${v.feedback || '未达标'}。请 repair 给出补齐步骤。`, execution, ['repair', 'blocked']);
      if (d.action === 'repair' && Array.isArray(d.steps)) {
        applyRepair(task, d);
        trunkNode(task, 'repair', `返工第 ${task.repairs} 轮`, { detail: `${d.steps.length} 个补救步骤` });
        task.status = 'running';
      } else { task.status = 'awaiting_review'; task.reviewDeadline = Date.now() + REVIEW_TIMEOUT_MS; task.reviewNodeId = trunkNode(task, 'review', '人工裁决', { status: 'awaiting', detail: '验收未通过' }).id; log(task, 'warn', '验收未通过，转人工裁决'); }
    } else {
      task.status = 'awaiting_review';
      task.reviewDeadline = Date.now() + REVIEW_TIMEOUT_MS;
      task.reviewNodeId = trunkNode(task, 'review', '人工裁决', { status: 'awaiting', detail: (v.feedback || '验收未通过').slice(0, 200) }).id;
      log(task, 'warn', '验收未通过且无法自动返工，转人工裁决: ' + (v.feedback || JSON.stringify(v)).slice(0, 200));
    }
    return;
  }

  // 4) 派发就绪步骤（deps 已 done、status pending、并发未满）
  // pend 与 status='running' 是同一批在途步骤，不能重复计数（否则并发额度减半）
  const runningCount = [...pendingDispatch.values()].reduce((count, entries) => count + entries.size, 0);
  const capacity = Math.max(0, state.config.maxConcurrent - runningCount);
  if (capacity <= 0) return;

  const ready = steps.filter((s) => s.status === 'pending' && (s.deps || []).every((d) => steps.find((x) => x.id === d)?.status === 'done'));
  for (const step of ready.slice(0, capacity)) {
    const allowed = allowedAgents();
    const effAgent = task.client && allowed.includes(task.client) ? task.client : step.agent;
    if (!allowed.includes(effAgent)) {
      step.status = 'failed';
      step.result = `agent ${effAgent} 当前不可用(crossClient=${state.config.crossClient})`;
      stepNode(task, step, { status: 'failed', agent: effAgent, detail: step.result });
      continue;
    }
    assertCurrent(task, execution, true);
    const w = runtime.workers[effAgent];
    const authenticated = !w?.authCheck || await w.authCheck();
    assertCurrent(task, execution, true);
    if (!authenticated) {
      step.status = 'failed';
      step.result = `${w.label} 未登录/不可用: ${w.note || ''}`;
      log(task, 'warn', `步骤 ${step.id} 的 agent ${effAgent} 不可用`);
      stepNode(task, step, { status: 'failed', agent: effAgent, detail: step.result });
      continue;
    }
    step.agent = effAgent;
    step.status = 'running';
    const nodeId = ensureStepNode(task, step).id;
    stepNode(task, step, { status: 'running', agent: effAgent });
    const p = (async () => {
      try {
        if (step.needsDebate) {
          // 辩论: 两个 agent 正反方 → planner 综合（各自从池中取实例，天然不同 client 优先）
          const others = allowed.filter((a) => a !== effAgent);
          const clients = [effAgent, others[0] || effAgent];
          const debateRun = async (client, persona) => {
            const r = await dispatchWithRecovery(task, step, persona, nodeId, execution, client);
            return { client, ok: r.ok, text: r.ok ? r.output : `FAILED(code=${r.code}): ${(r.output || r.error || '').slice(0, 2000)}` };
          };
          // 辩论双方依次执行，共享该步骤的一个全局并发名额。
          const r1 = await debateRun(clients[0], '你是正方，请给出支持该子任务目标的充分论证和方案。');
          assertCurrent(task, execution);
          const r2 = task.status === 'paused' ? { client: clients[1], ok: false, text: '暂停前未派发反方；不再自动派发' }
            : await debateRun(clients[1], '你是反方，请指出风险、反对意见和替代方案。');
          const debateNote = `正方(${r1.client}):\n${r1.text.slice(0, 4000)}\n\n反方(${r2.client}):\n${r2.text.slice(0, 4000)}`;
          assertCurrent(task, execution);
          if (task.status === 'paused') { step.status = 'done'; step.result = debateNote; stepNode(task, step, { status: 'done', detail: '辩论结果已保留' }); return; }
          const syn = await plannerChat(task, `步骤 ${step.id} 进行了正反辩论:\n${debateNote}\n\n请综合双方给出最终执行结论(done+summary)。`, execution, ['done']);
          step.result = syn && syn.summary ? syn.summary : debateNote.slice(0, 6000);
          step.status = 'done';
          stepNode(task, step, { status: 'done', detail: '辩论完成' });
        } else {
          const r = await dispatchWithRecovery(task, step, undefined, nodeId, execution);
          assertCurrent(task, execution);
          if (r.ok && applySplit(task, step, r.output || '')) {
            stepNode(task, step, { status: 'running', detail: `已递归拆解为子步骤（深度 ${(step.depth || 0) + 1}）` });
          } else {
            step.result = r.ok ? r.output : `FAILED(code=${r.code}): ${(r.output || r.error || '').slice(0, 4000)}`;
            step.status = r.ok ? 'done' : 'failed';
            stepNode(task, step, { status: step.status, detail: step.status === 'done' ? undefined : String(r.error || `exit ${r.code}`).slice(0, 200) });
          }
        }
      } catch (e) {
        if (e instanceof Cancelled || execution.controller.signal.aborted) return;
        step.status = 'failed'; step.result = 'dispatch exception: ' + e.message;
        stepNode(task, step, { status: 'failed', detail: String(e.message).slice(0, 200) });
      } finally {
        pend.delete(`${task.id}:${step.id}`); if (pend.size === 0 && pendingDispatch.get(task.id) === pend) pendingDispatch.delete(task.id);
        dirty = true;
      }
    })();
    pend.set(`${task.id}:${step.id}`, p);
  }
}

// 递归拆解：worker 输出 <<<SPLIT>>> + JSON 子步骤时，把当前步骤替换为一组子步骤（深度+1）
function applySplit(task, step, output) {
  const marker = output.indexOf('<<<SPLIT>>>');
  if (marker < 0) return false;
  let parsed = null;
  try {
    const raw = output.slice(marker + 11).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/,'').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : JSON.parse(raw);
  } catch { return false; }
  const subs = Array.isArray(parsed?.steps) ? parsed.steps : (Array.isArray(parsed) ? parsed : null);
  if (!subs || !subs.length) return false;
  const depth = (step.depth || 0) + 1;
  const maxDepth = state.config.maxDepth ?? 2;
  if (depth > maxDepth) { log(task, 'warn', `步骤 ${step.id} 请求递归拆解但已达深度上限 ${maxDepth}，忽略`); return false; }
  subs.forEach((s, i) => {
    let uid = s.id || `${step.id}.${i + 1}`;
    let k = 1; while (task.plan.find((x) => x.id === uid)) uid = `${uid}_${k++}`;
    task.plan.push({
      id: uid, title: s.title || uid, agent: s.agent || step.agent,
      prompt: s.prompt || s.title || '', deps: [], needsDebate: !!s.needsDebate,
      status: 'pending', depth, parentStep: step.id,
    });
  });
  step.status = 'split';
  step.result = undefined;
  stepNode(task, step, { status: 'running', detail: `已递归拆解为 ${subs.length} 个子步骤（深度 ${depth}）` });
  trunkNode(task, 'plan', `递归拆解 · ${step.title || step.id}`, { detail: `${subs.length} 个子步骤 · 深度 ${depth}`, parentId: `step_${step.id}` });
  log(task, 'info', `步骤 ${step.id} 递归拆解为 ${subs.length} 个子步骤（深度 ${depth}）`);
  dirty = true;
  return true;
}

async function maybeContinue(task, execution) {
  if (!state.config.autoContinue) return;
  const cont = (task.continuation || 0) + 1;
  if (cont > state.config.maxContinuations) { log(task, 'info', '已达自动续步上限'); return; }
  try {
    const d = await plannerChat(task, '任务已验收完成。请思考: 基于当前成果, 下一步最值得优化/推进的方向是什么? 用 next_goal 给出一个具体的新目标(不要重复已完成工作)。如果认为无需继续, 返回 done。', execution, ['next_goal', 'done', 'blocked']);
    if (d.action === 'next_goal' && d.goal) {
      const nt = {
        id: `t_${randomUUID()}`, goal: d.goal, parentId: task.id, continuation: cont,
        workdir: task.workdir, client: task.client, status: 'pending', plan: [], log: [], tree: [{ id: 'n1', kind: 'goal', label: String(d.goal).slice(0, 80), status: 'pending', ts: Date.now() }], createdAt: Date.now(), updatedAt: Date.now(),
      };
      state.tasks.push(nt);
      trunkNode(task, 'continue', `自动续步 #${cont}`, { status: 'done', detail: String(d.goal).slice(0, 200) });
      log(task, 'info', `自动续步 #${cont}: ${d.goal.slice(0, 120)}`);
      log(nt, 'info', `由 ${task.id} 自动续步生成`);
    }
  } catch (e) { if (!(e instanceof Cancelled) && !execution.controller.signal.aborted) log(task, 'warn', '续步规划失败: ' + e.message); }
}

// ---------- api ----------
export function initOrchestrator(options = {}) {
  if (initFlight) return initFlight;
  if (initialized) return Promise.resolve();
  runtime.fetch = options.fetch || runtime.fetch;
  runtime.workers = options.workers || runtime.workers;
  runtime.killGraceMs = options.killGraceMs ?? runtime.killGraceMs;
  runtime.writeFile = options.writeFile || writeFile;
  runtime.rename = options.rename || rename;
  shuttingDown = false;
  initFlight = (async () => {
    await load();
    // 外部副作用无法保证恰好一次；重启后的在途任务必须由用户确认后再执行。
    for (const task of state.tasks) {
      const interrupted = (task.plan || []).filter((step) => step.status === 'running');
      if (interrupted.length || ['planning', 'verifying', 'running'].includes(task.status)) {
        interrupted.forEach((step) => { step.status = 'interrupted'; stepNode(task, step, { status: 'interrupted', detail: '服务重启，执行结果未知' }); });
        task.status = 'awaiting_review'; task.interrupted = true;
        task.reviewDeadline = undefined;
        log(task, 'warn', '重启发现未确认的在途执行，需人工确认副作用后重试');
        goalNode(task, { status: 'awaiting_review', detail: '执行中断，等待人工确认' });
      }
    }
    for (const agent of state.agents) if (agent.status === 'busy') { agent.status = 'idle'; agent.taskId = undefined; agent.stepId = undefined; dirty = true; }
    await save();
    initialized = true;
    if (options.startTimers !== false) {
      tickTimer = setInterval(() => { tick().catch((e) => console.log('[orch] tick:', e.message)); }, (state.config.tickSeconds || 15) * 1000);
      saveTimer = setInterval(() => { save().catch((e) => console.log('[orch] save failed:', e.message)); }, 5000);
      tickTimer.unref(); saveTimer.unref();
    }
  })().finally(() => { initFlight = null; });
  return initFlight;
}
export async function shutdownOrchestrator() {
  shuttingDown = true;
  clearInterval(tickTimer); clearInterval(saveTimer);
  tickTimer = null; saveTimer = null;
  for (const task of state.tasks) {
    if (executions.has(task)) invalidate(task);
    if (['planning', 'verifying', 'running'].includes(task.status)) {
      task.status = 'awaiting_review'; task.interrupted = true; task.reviewDeadline = undefined; dirty = true;
    }
  }
  await Promise.allSettled([tickFlight, ...[...pendingDispatch.values()].flatMap((entries) => [...entries.values()])]);
  await save();
  initialized = false;
}

function publicConfig() { return { ...state.config, planner: { ...state.config.planner, apiKey: state.config.planner.apiKey ? '***' : '' } }; }
function configPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('配置必须为对象');
  const next = structuredClone(state.config);
  for (const key of ['enabled', 'crossClient', 'autoContinue']) if (Object.hasOwn(body, key)) {
    if (typeof body[key] !== 'boolean') throw new Error(`${key} 必须为布尔值`);
    next[key] = body[key];
  }
  for (const [key, min, max] of [['maxConcurrent', 1, 32], ['tickSeconds', 1, 3600], ['dispatchTimeoutMs', 1, 86400000], ['maxRepairs', 0, 100], ['maxDepth', 0, 10], ['maxContinuations', 0, 100]]) if (Object.hasOwn(body, key)) {
    if (!Number.isInteger(body[key]) || body[key] < min || body[key] > max) throw new Error(`${key} 超出允许范围`);
    next[key] = body[key];
  }
  if (Object.hasOwn(body, 'planner')) {
    if (!body.planner || typeof body.planner !== 'object' || Array.isArray(body.planner)) throw new Error('planner 必须为对象');
    for (const key of ['baseUrl', 'apiKey', 'model']) if (Object.hasOwn(body.planner, key)) {
      if (typeof body.planner[key] !== 'string') throw new Error(`planner.${key} 必须为字符串`);
      if (key !== 'apiKey' || body.planner[key] !== '***') next.planner[key] = body.planner[key];
    }
    const url = new URL(next.planner.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('planner baseUrl 必须为 HTTP(S) 地址');
    next.planner.baseUrl = url.toString().replace(/\/$/, '');
    if (!next.planner.model.trim()) throw new Error('planner model 不能为空');
  }
  return next;
}
export function orchConfig() { return publicConfig(); }

const REVIEW_TIMEOUT_MS = 24 * 3600 * 1000; // 人工裁决超时

export async function handleOrchestratorApi(url, method, body) {
  if (!initialized) throw new Error('编排器尚未初始化');
  const p = url.pathname;
  if (p === '/api/orchestrator/config' && method === 'GET') return { config: publicConfig(), agents: await availableAgents() };
  if (p === '/api/orchestrator/config' && method === 'PUT') {
    try { state.config = configPatch(body); } catch (error) { return { error: error.message }; }
    dirty = true; await save();
    return { ok: true, config: publicConfig() };
  }
  if (p === '/api/orchestrator/tasks' && method === 'GET') {
    const nowTs = Date.now();
    for (const t of state.tasks) {
      if (t.status === 'awaiting_review' && t.reviewDeadline && nowTs > t.reviewDeadline) { t.status = 'failed'; log(t, 'error', '人工裁决超时(24h)，自动终止'); if (t.reviewNodeId) nodePatch(t, t.reviewNodeId, { status: 'failed', detail: '裁决超时' }); goalNode(t, { status: 'failed', detail: '人工裁决超时' }); dirty = true; }
    }
    if (dirty) await save();
    return { tasks: state.tasks.map((t) => ({ ...t, plan: (t.plan || []).map((s) => ({ ...s, result: s.result ? String(s.result).slice(0, 300) : s.result })) })) };
  }
  if (p === '/api/orchestrator/tasks' && method === 'POST') {
    const { goal, workdir, client } = body || {};
    if (typeof goal !== 'string' || !goal.trim()) return { error: '缺少有效 goal' };
    if (workdir !== undefined && (typeof workdir !== 'string' || !path.isAbsolute(workdir))) return { error: 'workdir 必须为绝对路径' };
    if (client !== undefined && !Object.hasOwn(runtime.workers, client)) return { error: '未知 client' };
    const id = `t_${randomUUID()}`;
    const wd = workdir || path.join(WORK_ROOT, id);
    await mkdir(wd, { recursive: true });
    const t = { id, goal, workdir: wd, client: client || undefined, status: 'pending', plan: [], log: [], tree: [{ id: 'n1', kind: 'goal', label: String(goal).slice(0, 80), status: 'pending', ts: Date.now() }], createdAt: Date.now(), updatedAt: Date.now() };
    state.tasks.push(t); dirty = true; await save();
    return { ok: true, task: t };
  }
  if (p === '/api/orchestrator/agent-pool' && method === 'GET') {
    return { agents: (state.agents || []).map((a) => ({ ...a, worker: AGENT_WORKERS[a.client]?.label || a.client, available: !!AGENT_WORKERS[a.client] })), workers: await availableAgents() };
  }
  if (p === '/api/orchestrator/agent-pool' && method === 'POST') {
    const { client, label } = body || {};
    if (!runtime.workers[client]) return { error: `未知 client: ${client}` };
    const ag = { id: `a_${client}_${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`, client, label: String(label || runtime.workers[client].label).slice(0, 40), status: 'idle', createdAt: Date.now(), lastUsed: 0 };
    state.agents = state.agents || []; state.agents.push(ag); dirty = true; await save();
    return { ok: true, agent: ag };
  }
  const am = p.match(/^\/api\/orchestrator\/agent-pool\/([\w-]+)$/);
  if (am && method === 'DELETE') {
    state.agents = (state.agents || []).filter((a) => a.id !== am[1]); dirty = true; await save();
    return { ok: true };
  }
  const m = p.match(/^\/api\/orchestrator\/tasks\/([\w-]+)(\/(\w+))?$/);
  if (m) {
    const t = findTask(m[1]);
    if (!t) return { error: 'task not found' };
    const action = m[3];
    if (method === 'GET' && !action) { aggregateProgress(t); return { task: t }; }
    if (method === 'POST' && action === 'pause') {
      if (!['done', 'failed', 'awaiting_review'].includes(t.status)) {
        t.status = 'paused'; const execution = executionFor(t); execution.plannerVersion++;
        for (const controller of execution.planners) controller.abort();
        dirty = true;
      }
    }
    if (method === 'POST' && action === 'resume') {
      if (t.interrupted || (t.plan || []).some((step) => step.status === 'interrupted')) return { error: '执行结果未知，请人工 review/retry 确认后再执行' };
      if (['paused', 'blocked', 'failed'].includes(t.status)) { t.status = 'pending'; t.error = undefined; dirty = true; }
    }
    if (method === 'POST' && action === 'stop') { invalidate(t); t.status = 'failed'; log(t, 'warn', '手动停止'); goalNode(t, { status: 'failed', detail: '手动停止' }); }
    if (method === 'POST' && action === 'review') {
      const act = (body || {}).action;
      if (act === 'pass') { invalidate(t); t.status = 'done'; t.interrupted = false; t.summary = (t.summary || '') + '（人工裁决通过）'; log(t, 'info', '人工裁决: 通过'); goalNode(t, { status: 'done', detail: '人工裁决通过' }); }
      else if (act === 'retry') {
        invalidate(t); t.interrupted = false; t.repairs = 0; t.error = undefined;
        for (const step of t.plan || []) if (step.status === 'interrupted' || step.status === 'running') { step.status = 'pending'; step.result = undefined; stepNode(t, step, { status: 'pending', detail: '已人工确认可重试' }); }
        for (const n of t.tree || []) if (['running', 'interrupted', 'awaiting'].includes(n.status)) nodePatch(t, n.id, { status: 'pending', detail: undefined });
        t.status = 'pending'; log(t, 'info', '人工裁决: 确认副作用后重试');
      }
      else if (act === 'abort') { invalidate(t); t.interrupted = false; t.status = 'failed'; log(t, 'warn', '人工裁决: 终止'); goalNode(t, { status: 'failed', detail: '人工裁决终止' }); }
      else return { error: 'action 需为 pass/retry/abort' };
      if (t.reviewNodeId) nodePatch(t, t.reviewNodeId, { status: 'done', detail: `人工裁决: ${act}` });
      dirty = true;
    }
    if (method === 'DELETE' && !action) { invalidate(t); state.tasks = state.tasks.filter((x) => x.id !== t.id); dirty = true; }
    await save();
    return { ok: true, task: t };
  }
  return null;
}
