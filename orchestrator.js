// orchestrator.js — 跨 Agent 任务编排器（Loop + 子 Agent + 辩论 + 自动续步）
// 由 server.js 挂载: initOrchestrator() 启动 tick; handleOrchestratorApi() 处理 /api/orchestrator/*
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
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
  planner: {
    baseUrl: 'http://127.0.0.1:8788/v1',
    apiKey: 'hermes-local-router',
    model: 'complex',      // 规划/验收固定用这一个模型，不来回切
  },
};

// worker 适配器：{prompt} 占位符替换为任务提示词；available() 探测是否可用
const AGENT_WORKERS = {
  hermes: {
    label: 'Hermes',
    cmd: `${HOME}/.hermes/hermes-agent/hermes`,
    args: ['-z', '{prompt}'],
    always: true,
    note: 'hermes -z 无头模式，本地路由',
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
let state = { config: structuredClone(DEFAULT_CONFIG), tasks: [] };
let dirty = false;
const pendingDispatch = new Map(); // taskId -> Map(stepKey -> Promise)
const running = new Map(); // stepKey -> {child, taskId, stepId, agent, startedAt}

async function load() {
  try { state = { ...state, ...JSON.parse(await readFile(STATE_PATH, 'utf8')) }; }
  catch { /* 首次 */ }
  state.config = { ...structuredClone(DEFAULT_CONFIG), ...(state.config || {}) };
  state.config.planner = { ...DEFAULT_CONFIG.planner, ...(state.config.planner || {}) };
  state.tasks = state.tasks || [];
}
async function save() {
  if (!dirty) return;
  dirty = false;
  try {
    await mkdir(path.dirname(STATE_PATH), { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) { console.log('[orch] save failed:', e.message); }
}
setInterval(save, 5000).unref();

function log(task, level, msg) {
  task.log = task.log || [];
  task.log.push({ ts: Date.now(), level, msg: String(msg).slice(0, 500) });
  if (task.log.length > 300) task.log = task.log.slice(-300);
  dirty = true;
}
const findTask = (id) => state.tasks.find((t) => t.id === id);

// ---------- planner ----------
async function plannerChat(task, userPrompt) {
  const p = state.config.planner;
  const agents = await availableAgents();
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
- 子 Agent 提示词要自包含：包含背景、输入、期望输出、验收标准。`;
  const body = {
    model: p.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `任务目标: ${task.goal}\n\n当前计划:\n${JSON.stringify(task.plan || [], null, 1)}\n\n最近结果:\n${JSON.stringify((task.plan || []).filter((s) => s.result).map((s) => ({ id: s.id, status: s.status, result: String(s.result).slice(0, 1500) })), null, 1)}\n\n工作目录: ${task.workdir}\n\n请输出下一步 JSON。` },
    ],
  };
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`planner HTTP ${res.status}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('planner 返回非 JSON: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

async function availableAgents() {
  const out = [];
  for (const [id, w] of Object.entries(AGENT_WORKERS)) {
    let ok = true;
    if (w.authCheck) { try { ok = await w.authCheck(); } catch { ok = false; } }
    out.push({ id, label: w.label, available: ok, note: w.note, crossOnly: id !== 'hermes' });
  }
  return out;
}

function allowedAgents() {
  // crossClient=off 时只允许 hermes（本地常驻 worker）
  return Object.keys(AGENT_WORKERS).filter((id) => state.config.crossClient || id === 'hermes');
}

// ---------- dispatch ----------
function buildPrompt(step, task) {
  return `${step.prompt}\n\n---\n背景: 这是整体任务「${task.goal}」的子任务(${step.id}: ${step.title})。工作目录: ${task.workdir}。请完成后输出清晰的结果摘要。`;
}

function dispatchStep(task, step, persona) {
  const w = AGENT_WORKERS[step.agent];
  if (!w) return Promise.resolve({ ok: false, error: `未知 agent ${step.agent}` });
  const prompt = persona ? `${persona}\n\n${buildPrompt(step, task)}` : buildPrompt(step, task);
  const args = w.args.map((a) => (a === '{prompt}' ? prompt : a));
  const key = `${task.id}:${step.id}${persona ? ':' + persona.slice(0, 8) : ''}`;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(w.cmd, args, { cwd: task.workdir || HOME, env: { ...process.env, PATH: `${HOME}/.npm-global/bin:${process.env.PATH}` } });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    let out = '', err = '', done = false;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, state.config.dispatchTimeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 400000) out = out.slice(-400000); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 100000) err = err.slice(-100000); });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); } });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      running.delete(key);
      const text = (out || '') + (err ? `\n[stderr]\n${err.slice(-3000)}` : '');
      resolve({ ok: code === 0, code, output: text.slice(-12000) });
    });
    running.set(key, { child, taskId: task.id, stepId: step.id, agent: step.agent, startedAt: Date.now() });
    log(task, 'info', `dispatch ${step.id} → ${step.agent}${persona ? ' (' + persona + ')' : ''}`);
    dirty = true;
  });
}

// ---------- engine ----------
async function tick() {
  if (!state.config.enabled) return;
  const active = state.tasks.filter((t) => ['pending', 'planning', 'running', 'verifying'].includes(t.status));
  for (const task of active) {
    try { await stepTask(task); } catch (e) { log(task, 'error', 'tick error: ' + e.message); task.status = 'blocked'; }
    await save();
  }
}

async function stepTask(task) {
  // 1) 还没有计划 → 让 planner 拆解
  if (!task.plan || !task.plan.length) {
    task.status = 'planning';
    log(task, 'info', '请求 planner 拆解任务');
    const d = await plannerChat(task, '请将该目标拆解为子任务 steps(decompose)。若目标简单可只拆 1-2 步。');
    if (d.action === 'decompose' && Array.isArray(d.steps) && d.steps.length) {
      task.plan = d.steps.map((s, i) => ({
        id: s.id || `s${i + 1}`, title: s.title || `step ${i + 1}`, agent: s.agent || 'hermes',
        prompt: s.prompt || s.title || '', deps: s.deps || [], needsDebate: !!s.needsDebate,
        status: 'pending',
      }));
      task.status = 'running';
      log(task, 'info', `计划就绪: ${task.plan.map((s) => `${s.id}(${s.agent})`).join(', ')}`);
    } else {
      log(task, 'warn', 'planner 未返回 decompose: ' + JSON.stringify(d).slice(0, 300));
      task.status = 'blocked';
    }
    return;
  }

  // 2) 检查运行中的步骤（spawn 是同步登记、close 回调异步——用结果轮询替代）
  // 简化: dispatchStep 是 await 的 promise; 为支持并发, 先收集 runningPromises
  let pend = pendingDispatch.get(task.id); if (!pend) { pend = new Map(); pendingDispatch.set(task.id, pend); }

  // 3) 全部终态 → 验收
  const steps = task.plan;
  const allDone = steps.every((s) => ['done', 'failed'].includes(s.status)) && pend.size === 0;
  if (allDone) {
    task.status = 'verifying';
    const failed = steps.filter((s) => s.status === 'failed');
    if (failed.length && (task.repairs || 0) < state.config.maxRepairs) {
      task.repairs = (task.repairs || 0) + 1;
      log(task, 'warn', `验收前自检: ${failed.length} 步失败, 返工第 ${task.repairs} 轮`);
      const d = await plannerChat(task, `以下步骤失败: ${failed.map((s) => s.id).join(',')}。请输出 repair 计划补齐或替代方案。`);
      if (d.action === 'repair' && Array.isArray(d.steps)) {
        for (const ns of d.steps) {
          const ex = steps.find((s) => s.id === ns.id);
          if (ex) Object.assign(ex, { status: 'pending', prompt: ns.prompt || ex.prompt, agent: ns.agent || ex.agent, result: undefined });
          else steps.push({ id: ns.id || `s${steps.length + 1}`, title: ns.title || '', agent: ns.agent || 'hermes', prompt: ns.prompt || '', deps: ns.deps || [], needsDebate: !!ns.needsDebate, status: 'pending' });
        }
        task.status = 'running';
        return;
      }
      task.status = 'awaiting_review';
      task.reviewDeadline = Date.now() + REVIEW_TIMEOUT_MS;
      log(task, 'warn', '返工规划失败，转人工裁决（24h 超时自动终止）');
      return;
    }
    // planner 验收
    const v = await plannerChat(task, '所有子任务已完成。请验收整体目标是否达成: verify(pass=true/false, feedback)。若未完全达成请说明差距。若已完全达成也可直接返回 done+summary。');
    // planner 可能返回 verify(pass=true) 或直接 done+summary，两者都视为验收通过
    if ((v.action === 'verify' && v.pass) || v.action === 'done') {
      task.status = 'done';
      task.summary = v.feedback || v.summary || '';
      log(task, 'info', '验收通过: ' + (v.feedback || '').slice(0, 200));
      await maybeContinue(task);
    } else if (v.action === 'verify' && !v.pass && (task.repairs || 0) < state.config.maxRepairs) {
      task.repairs = (task.repairs || 0) + 1;
      log(task, 'warn', '验收未通过: ' + (v.feedback || '').slice(0, 200));
      const d = await plannerChat(task, `验收反馈: ${v.feedback || '未达标'}。请 repair 给出补齐步骤。`);
      if (d.action === 'repair' && Array.isArray(d.steps)) {
        for (const ns of d.steps) steps.push({ id: ns.id || `s${steps.length + 1}`, title: ns.title || '', agent: ns.agent || 'hermes', prompt: ns.prompt || '', deps: ns.deps || [], needsDebate: !!ns.needsDebate, status: 'pending' });
        task.status = 'running';
      } else { task.status = 'awaiting_review'; task.reviewDeadline = Date.now() + REVIEW_TIMEOUT_MS; log(task, 'warn', '验收未通过，转人工裁决'); }
    } else {
      task.status = 'awaiting_review';
      task.reviewDeadline = Date.now() + REVIEW_TIMEOUT_MS;
      log(task, 'warn', '验收未通过且无法自动返工，转人工裁决: ' + (v.feedback || JSON.stringify(v)).slice(0, 200));
    }
    return;
  }

  // 4) 派发就绪步骤（deps 已 done、status pending、并发未满）
  // pend 与 status='running' 是同一批在途步骤，不能重复计数（否则并发额度减半）
  const runningCount = steps.filter((s) => s.status === 'running').length;
  const capacity = Math.max(0, state.config.maxConcurrent - runningCount);
  if (capacity <= 0) return;

  const ready = steps.filter((s) => s.status === 'pending' && (s.deps || []).every((d) => steps.find((x) => x.id === d)?.status === 'done'));
  for (const step of ready.slice(0, capacity)) {
    const allowed = allowedAgents();
    if (!allowed.includes(step.agent)) {
      step.status = 'failed';
      step.result = `agent ${step.agent} 当前不可用(crossClient=${state.config.crossClient})`;
      continue;
    }
    const w = AGENT_WORKERS[step.agent];
    if (w?.authCheck && !(await w.authCheck())) {
      step.status = 'failed';
      step.result = `${w.label} 未登录/不可用: ${w.note || ''}`;
      log(task, 'warn', `步骤 ${step.id} 的 agent ${step.agent} 不可用`);
      continue;
    }
    step.status = 'running';
    const p = (async () => {
      try {
        if (step.needsDebate) {
          // 辩论: 两个 agent 正反方 → planner 综合
          const others = allowed.filter((a) => a !== step.agent);
          const agents = [step.agent, others[0] || step.agent];
          const [r1, r2] = await Promise.all([
            dispatchStep(task, step, '你是正方，请给出支持该子任务目标的充分论证和方案。'),
            dispatchStep(task, { ...step, agent: agents[1] }, '你是反方，请指出风险、反对意见和替代方案。'),
          ]);
          const debateNote = `正方(${agents[0]}):\n${(r1.output || r1.error || '').slice(0, 4000)}\n\n反方(${agents[1]}):\n${(r2.output || r2.error || '').slice(0, 4000)}`;
          const syn = await plannerChat(task, `步骤 ${step.id} 进行了正反辩论:\n${debateNote}\n\n请综合双方给出最终执行结论(JSON 即可, 作为步骤结果)。`);
          step.result = syn && syn.summary ? syn.summary : debateNote.slice(0, 6000);
          step.status = 'done';
        } else {
          const r = await dispatchStep(task, step);
          step.result = r.ok ? r.output : `FAILED(code=${r.code}): ${(r.output || r.error || '').slice(0, 4000)}`;
          step.status = r.ok ? 'done' : 'failed';
        }
      } catch (e) {
        step.status = 'failed'; step.result = 'dispatch exception: ' + e.message;
      } finally {
        pend.delete(`${task.id}:${step.id}`); if (pend.size === 0) pendingDispatch.delete(task.id);
        dirty = true;
      }
    })();
    pend.set(`${task.id}:${step.id}`, p);
  }
}

async function maybeContinue(task) {
  if (!state.config.autoContinue) return;
  const cont = (task.continuation || 0) + 1;
  if (cont > state.config.maxContinuations) { log(task, 'info', '已达自动续步上限'); return; }
  try {
    const d = await plannerChat(task, '任务已验收完成。请思考: 基于当前成果, 下一步最值得优化/推进的方向是什么? 用 next_goal 给出一个具体的新目标(不要重复已完成工作)。如果认为无需继续, 返回 done。');
    if (d.action === 'next_goal' && d.goal) {
      const nt = {
        id: `t_${Date.now().toString(36)}`, goal: d.goal, parentId: task.id, continuation: cont,
        workdir: task.workdir, status: 'pending', plan: [], log: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      state.tasks.push(nt);
      log(task, 'info', `自动续步 #${cont}: ${d.goal.slice(0, 120)}`);
      log(nt, 'info', `由 ${task.id} 自动续步生成`);
    }
  } catch (e) { log(task, 'warn', '续步规划失败: ' + e.message); }
}

// ---------- api ----------
export async function initOrchestrator() {
  await load();
  // 重启恢复：上次进程内的在途派发已丢失，把卡在 running 的步骤重置为 pending 重新执行
  let recovered = 0;
  for (const t of state.tasks) for (const s of t.plan || []) {
    if (s.status === 'running') { s.status = 'pending'; s.result = undefined; recovered++; }
  }
  if (recovered) { await save(); console.log(`[orch] recovered ${recovered} stale running steps`); }
  setInterval(() => { tick().catch((e) => console.log('[orch] tick:', e.message)); }, (state.config.tickSeconds || 15) * 1000).unref();
  console.log(`[orch] loaded ${state.tasks.length} tasks, enabled=${state.config.enabled}`);
}

export function orchConfig() { return state.config; }

const REVIEW_TIMEOUT_MS = 24 * 3600 * 1000; // 人工裁决超时

export async function handleOrchestratorApi(url, method, body) {
  const p = url.pathname;
  if (p === '/api/orchestrator/config' && method === 'GET') return { config: state.config, agents: await availableAgents() };
  if (p === '/api/orchestrator/config' && method === 'PUT') {
    state.config = { ...state.config, ...(body || {}) };
    state.config.planner = { ...DEFAULT_CONFIG.planner, ...(body?.planner || {}) };
    dirty = true; await save();
    return { ok: true, config: state.config };
  }
  if (p === '/api/orchestrator/tasks' && method === 'GET') {
    const nowTs = Date.now();
    for (const t of state.tasks) {
      if (t.status === 'awaiting_review' && t.reviewDeadline && nowTs > t.reviewDeadline) { t.status = 'failed'; log(t, 'error', '人工裁决超时(24h)，自动终止'); dirty = true; }
    }
    if (dirty) await save();
    return { tasks: state.tasks.map((t) => ({ ...t, plan: (t.plan || []).map((s) => ({ ...s, result: s.result ? String(s.result).slice(0, 300) : s.result })) })) };
  }
  if (p === '/api/orchestrator/tasks' && method === 'POST') {
    const { goal, workdir } = body || {};
    if (!goal) return { error: '缺少 goal' };
    const id = `t_${Date.now().toString(36)}`;
    const wd = workdir || path.join(WORK_ROOT, id);
    await mkdir(wd, { recursive: true });
    const t = { id, goal, workdir: wd, status: 'pending', plan: [], log: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.tasks.push(t); dirty = true; await save();
    return { ok: true, task: t };
  }
  const m = p.match(/^\/api\/orchestrator\/tasks\/([\w-]+)(\/(\w+))?$/);
  if (m) {
    const t = findTask(m[1]);
    if (!t) return { error: 'task not found' };
    const action = m[3];
    if (method === 'GET' && !action) return { task: t };
    if (method === 'POST' && action === 'pause') { t.status = 'paused'; dirty = true; }
    if (method === 'POST' && action === 'resume') { if (['paused', 'blocked', 'failed'].includes(t.status)) { t.status = 'pending'; t.error = undefined; } dirty = true; }
    if (method === 'POST' && action === 'stop') { t.status = 'failed'; log(t, 'warn', '手动停止'); dirty = true; }
    if (method === 'POST' && action === 'review') {
      const act = (body || {}).action;
      if (act === 'pass') { t.status = 'done'; t.summary = (t.summary || '') + '（人工裁决通过）'; log(t, 'info', '人工裁决: 通过'); }
      else if (act === 'retry') { t.status = 'pending'; t.repairs = 0; t.error = undefined; log(t, 'info', '人工裁决: 再返工'); }
      else if (act === 'abort') { t.status = 'failed'; log(t, 'warn', '人工裁决: 终止'); }
      else return { error: 'action 需为 pass/retry/abort' };
      dirty = true;
    }
    if (method === 'DELETE' && !action) { state.tasks = state.tasks.filter((x) => x.id !== t.id); dirty = true; }
    await save();
    return { ok: true, task: t };
  }
  return null;
}
