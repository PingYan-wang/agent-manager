// 路由器回归测试：验证「模型问题换模型 / 厂商问题换厂商 / 重试升档 / 全熔断快速失败」。
// 运行：npm run test:router
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.join(HERE, '..', 'router.mjs');
const MOCK = path.join(HERE, 'mock-upstream.mjs');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  <<< ' + detail}`);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function waitUp(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* 继续等 */ }
    await sleep(150);
  }
  return false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
const mockPort = await freePort();
const routerPort = await freePort();

const providers = {};
for (const id of ['pa', 'pb', 'pd', 'pe', 'pf', 'pg', 'ph', 'pi', 'pj', 'pk', 'pl', 'pm', 'pr', 'pn', 'po', 'pq']) {
  providers[id] = { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'k-' + id };
}
// 成本不同的两家，用来验证 strategy=cost 的排序（数值是 USD/1M tokens）
providers.pc1 = { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'k-pc1', cost: 1 };
providers.pc2 = { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'k-pc2', cost: 10 };
// 本地小模型：只接纯聊天，不接工具调用 / 超长上下文
providers.plocal = {
  baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'k-local', label: '本地 Ollama',
  capabilities: { tools: false, stream: true, maxChars: 6000, maxMessages: 12, tiers: ['simple', 'capability'] },
};

fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  port: routerPort,
  upstreamTimeoutMs: 8000,
  retryPolicy: { windowMs: 300000, escalateAfter: 2, tiers: ['retryA', 'retryB', 'borrowSrc', 'borrowDst', 'allfail'] },
  breaker: { quotaMs: 60000, authMs: 60000, rateMs: 60000, serverMs: 5000, networkMs: 5000, modelMs: 60000 },
  guard: { upgradeOnTools: true, toolsUpgradeTo: 'coding', fastFailStaleMs: 200 },
  providers,
  routes: {
    simple: { chain: [{ provider: 'pa', models: ['quota', 'good-a'] }, { provider: 'pb', models: ['good-b'] }] },
    coding: { chain: [{ provider: 'pd', models: ['nf', 'good-a'] }] },
    complex: { chain: [{ provider: 'pe', models: ['temp'] }] },
    expert: { chain: [{ provider: 'pf', models: ['reqbad', 'good-a'] }] },
    bal: { chain: [{ provider: 'pi', models: ['balance', 'good-a'] }, { provider: 'pb', models: ['good-b'] }] },
    rc: { chain: [{ provider: 'pk', models: ['rc'] }] },
    think: { chain: [{ provider: 'pk', models: ['think'] }] },
    notools: { chain: [{ provider: 'pl', models: ['notools'] }] },
    weird: { chain: [{ provider: 'pl', models: ['weird400', 'good-a'] }] },
    ctx: { chain: [{ provider: 'pl', models: ['ctx', 'good-a'] }] },
    badonly: { chain: [{ provider: 'pm', models: ['weird400'] }] },
    streamcut: { chain: [{ provider: 'pa', models: ['cut'] }] },
    streamnodone: { chain: [{ provider: 'pa', models: ['nodone'] }] },
    streamusage: { chain: [{ provider: 'pa', models: ['usage'] }] },
    streamslow: { chain: [{ provider: 'pa', models: ['slow'] }] },
    streamtools: { chain: [{ provider: 'pa', models: ['tools'] }] },
    streamtimeout: { chain: [{ provider: 'pa', models: ['timeout'] }] },
    streamdelayed: { chain: [{ provider: 'pa', models: ['delayed-headers', 'good-a'] }, { provider: 'pb', models: ['good-b'] }] },
    retryA: { chain: [{ provider: 'pg', models: ['quota'] }] },
    retryB: { chain: [{ provider: 'ph', models: ['good-b'] }] },
    allfail: { chain: [{ provider: 'pi', models: ['quota'] }, { provider: 'pj', models: ['auth'] }] },
    rate1: { chain: [{ provider: 'pr', models: ['ratelimit'] }, { provider: 'pb', models: ['good-b'] }] },
    capability: { chain: [{ provider: 'plocal', models: ['qwen3b'] }, { provider: 'pb', models: ['good-b'] }] },
    srvmodel: { chain: [{ provider: 'pn', models: ['flaky500', 'good-a'] }] },
    srvdead: { chain: [{ provider: 'po', models: ['dead500', 'dead501'] }, { provider: 'pb', models: ['good-b'] }] },
    borrowSrc: { chain: [{ provider: 'pi', models: ['quota'] }] },
    borrowDst: { chain: [{ provider: 'ph', models: ['good-b'] }] },
    cheap: { strategy: 'cost', chain: [{ provider: 'pc2', models: ['good-a'] }, { provider: 'pc1', models: ['good-b'] }] },
  },
  reserve: [{ provider: 'plocal', models: ['qwen3b'] }],
}, null, 2));

const mock = spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_PORT: String(mockPort) }, stdio: 'ignore' });
const router = spawn(process.execPath, [ROUTER], {
  env: { ...process.env, ROUTER_CONFIG: path.join(tmp, 'config.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
let log2 = '';
router.stdout.on('data', (d) => { log += d; });
router.stderr.on('data', (d) => { log += d; });

const base = `http://127.0.0.1:${routerPort}`;
const mockBase = `http://127.0.0.1:${mockPort}`;

async function post(body) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers) };
}
const calls = async () => (await fetch(`${mockBase}/__calls`)).json();
const resetCalls = () => fetch(`${mockBase}/__reset`);
const ask = (text, model = 'simple', extra = {}) => ({ model, stream: true, messages: [{ role: 'user', content: text }], ...extra });

// 第二台路由器：关闭跨档借用，专门验证「能力死局 / 已知故障」的快速失败——
// 主实例的跨档借出会从别的档位捞到活厂商，盖住这两条路径。
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test2-'));
const routerPort2 = await freePort();
fs.writeFileSync(path.join(tmp2, 'config.json'), JSON.stringify({
  port: routerPort2,
  upstreamTimeoutMs: 8000,
  retryPolicy: { escalateAfter: 2, crossTier: false, tiers: ['only', 'dead'] },
  breaker: { quotaMs: 60000, authMs: 60000, rateMs: 60000, serverMs: 5000, networkMs: 5000, modelMs: 60000 },
  guard: { fastFailStaleMs: 200 },
  providers: { plocal: providers.plocal, pq: providers.pq },
  routes: {
    only: { chain: [{ provider: 'plocal', models: ['qwen3b'] }] },
    dead: { chain: [{ provider: 'pq', models: ['quota'] }] },
  },
}, null, 2));
const router2 = spawn(process.execPath, [ROUTER], {
  env: { ...process.env, ROUTER_CONFIG: path.join(tmp2, 'config.json') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
router2.stdout.on('data', (d) => { log2 += d; });
router2.stderr.on('data', (d) => { log2 += d; });
const base2 = `http://127.0.0.1:${routerPort2}`;
async function post2(body) {
  const r = await fetch(`${base2}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text(), headers: Object.fromEntries(r.headers) };
}

try {
  if (!await waitUp(`${mockBase}/__calls`)) throw new Error('mock upstream 未启动');
  if (!await waitUp(`${base}/healthz`)) throw new Error('router 未启动');
  if (!await waitUp(`${base2}/healthz`)) throw new Error('router2 未启动');

  // 1 厂商级：配额耗尽 → 跳过整家（含未失败的同厂商第二个模型）
  await resetCalls();
  const r1 = await post(ask('case1'));
  const c1 = await calls();
  check('厂商配额耗尽后仍成功', r1.status === 200, `status=${r1.status} ${r1.text.slice(0, 160)}`);
  check('切到下一家厂商', r1.headers['x-router-provider'] === 'pb', `provider=${r1.headers['x-router-provider']}`);
  check('跳过同厂商剩余模型', !c1.some((c) => c.model === 'good-a'), JSON.stringify(c1.map((c) => c.model)));

  // 2 厂商级：余额不足（403 insufficient_user_quota）同样整家跳过
  await resetCalls();
  const r2 = await post(ask('case2', 'bal'));
  check('余额不足触发换厂商', r2.status === 200 && r2.headers['x-router-provider'] === 'pb', `provider=${r2.headers['x-router-provider']} status=${r2.status}`);

  // 3 模型级：模型不存在 → 留在同厂商换模型
  await resetCalls();
  const r3 = await post(ask('case3', 'coding'));
  const c3 = await calls();
  check('模型不存在后仍成功', r3.status === 200, `status=${r3.status}`);
  check('仍留在同厂商', r3.headers['x-router-provider'] === 'pd', `provider=${r3.headers['x-router-provider']}`);
  check('换到同厂商下一个模型', r3.headers['x-router-model'] === 'good-a', `model=${r3.headers['x-router-model']}`);
  check('只尝试 2 次', c3.length === 2, JSON.stringify(c3.map((c) => c.model)));

  // 4 参数自愈：temperature 不被支持 → 就地修正重试同一目标
  await resetCalls();
  const r4 = await post(ask('case4', 'complex', { temperature: 1.2 }));
  const c4 = await calls();
  const h4 = await (await fetch(`${base}/admin/health`)).json();
  check('温度自愈后成功', r4.status === 200, `status=${r4.status}`);
  check('末次请求温度改为 0.6', c4.length === 2 && c4[1].temperature === 0.6, JSON.stringify(c4));
  check('不误熔断厂商', h4.providers.find((p) => p.id === 'pe').open === false, 'pe 被熔断');

  // 5 请求级错误：立即返回，不浪费后续尝试
  await resetCalls();
  const r5 = await post(ask('case5', 'expert'));
  const c5 = await calls();
  check('请求级错误返回 400', r5.status === 400, `status=${r5.status}`);
  check('不浪费后续尝试', c5.length === 1, JSON.stringify(c5.map((c) => c.model)));

  // 6 重试感知：第二次自动升档
  await resetCalls();
  const b6 = ask('case6', 'retryA');
  const r6a = await post(b6);
  const r6b = await post(b6);
  check('首次按原档位失败', r6a.status !== 200, `status=${r6a.status}`);
  check('重试后成功', r6b.status === 200, `status=${r6b.status}`);
  check('升级到 retryB', r6b.headers['x-router-escalate'] === 'retryB', `escalate=${r6b.headers['x-router-escalate']}`);
  check('由下游厂商承接', r6b.headers['x-router-provider'] === 'ph', `provider=${r6b.headers['x-router-provider']}`);

  // 7 全部熔断：快速失败 503 + Retry-After，不再请求上游
  await fetch(`${base}/admin/breaker/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await resetCalls();
  const b7 = ask('case7', 'allfail');
  await post(b7);
  const t0 = Date.now();
  const r7 = await post(b7);
  const fast = Date.now() - t0;
  const c7 = await calls();
  check('二次快速失败 503', r7.status === 503, `status=${r7.status}`);
  check('带 Retry-After', Number(r7.headers['retry-after']) > 0, `retry-after=${r7.headers['retry-after']}`);
  check('不再请求上游', c7.length === 2, `calls=${c7.length}`);
  check('失败足够快', fast < 1000, `${fast}ms`);

  // 7b 本档厂商全熔断时，自动借用下一档的可用厂商，而不是直接失败
  await resetCalls();
  const r7b = await post(ask('case7b', 'borrowSrc'));
  check('本档全熔断时借用下一档', r7b.status === 200 && r7b.headers['x-router-provider'] === 'ph', `status=${r7b.status} provider=${r7b.headers['x-router-provider']}`);
  check('标记借档来源', r7b.headers['x-router-escalate'] === 'borrowDst', `escalate=${r7b.headers['x-router-escalate']}`);

  // 8 思维链回显：出站自动剥离（Reverix 协议转换层 400 的真实形态）
  await resetCalls();
  const r8 = await post(ask('case8', 'rc', {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo', reasoning_content: '内部推理', thinking_blocks: [{ type: 'thinking', thinking: 'x' }] },
      { role: 'user', content: '继续' },
    ],
    reasoning_effort: 'medium',
  }));
  const c8 = await calls();
  check('思维链回显被剥离后成功', r8.status === 200, `status=${r8.status} ${r8.text.slice(0, 160)}`);
  check('上游未收到 reasoning_content', c8.length === 1 && c8[0].rc === false, JSON.stringify(c8));
  check('上游未收到 reasoning_effort', c8.length === 1 && c8[0].eff === false, JSON.stringify(c8));
  check('默认净化无需二次重试', c8.length === 1, `calls=${c8.length}`);

  // 9 本地模型不支持 thinking（Ollama 400）→ 同样净化后直通
  await resetCalls();
  const r9 = await post(ask('case9', 'think', { reasoning_effort: 'high' }));
  const c9 = await calls();
  check('thinking 参数被剥离后成功', r9.status === 200, `status=${r9.status} ${r9.text.slice(0, 160)}`);
  check('thinking 只请求一次', c9.length === 1, `calls=${c9.length}`);

  // 10 工具调用不被支持 → 剥 tools 后就地重试同一目标，不放弃整条链
  await resetCalls();
  const r10 = await post(ask('case10', 'notools', {
    tools: [{ type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } } }],
  }));
  const c10 = await calls();
  check('工具不支持时自愈成功', r10.status === 200, `status=${r10.status} ${r10.text.slice(0, 160)}`);
  check('同一目标重试并剥掉 tools', c10.length === 2 && c10[1].tools === 0 && c10[1].model === 'notools', JSON.stringify(c10));
  check('不因工具缺失熔断厂商', r10.headers['x-router-provider'] === 'pl', `provider=${r10.headers['x-router-provider']}`);

  // 11 未知 400 不再一刀切为「请求非法」→ 换同厂商下一个模型
  await resetCalls();
  const r11 = await post(ask('case11', 'weird'));
  check('未知 400 继续兜底', r11.status === 200 && r11.headers['x-router-model'] === 'good-a', `status=${r11.status} model=${r11.headers['x-router-model']}`);

  // 12 上下文超限属于模型级：换模型而不是拒绝请求
  await resetCalls();
  const r12 = await post(ask('case12', 'ctx'));
  check('上下文超限换模型', r12.status === 200 && r12.headers['x-router-model'] === 'good-a', `status=${r12.status} model=${r12.headers['x-router-model']}`);

  // 13 非致命 400 全部失败时回 502（不是 400），客户端才会按「服务故障」重试
  await resetCalls();
  const r13 = await post(ask('case13', 'badonly'));
  check('非致命 400 全灭回 502', r13.status === 502, `status=${r13.status} ${r13.text.slice(0, 160)}`);
  check('错误类型标注为 router_unavailable', /router_unavailable/.test(r13.text), r13.text.slice(0, 200));

  // 14 限流不能被当成配额耗尽：换厂商 + 短窗口熔断
  await resetCalls();
  const r14 = await post(ask('case14', 'rate1'));
  const h14 = await (await fetch(`${base}/admin/health`)).json();
  const prState = h14.providers.find((p) => p.id === 'pr');
  check('限流后按顺序换厂商', r14.status === 200 && r14.headers['x-router-provider'] === 'pb', `status=${r14.status} provider=${r14.headers['x-router-provider']}`);
  check('限流归因为 rate 而非 quota', prState && prState.kind === 'rate', JSON.stringify(prState));
  check('限流熔断窗口 <= 90s', !!prState && prState.leftMs > 0 && prState.leftMs <= 90000, `leftMs=${prState && prState.leftMs}`);

  // 15 能力守卫：本地小模型只接纯聊天，不接工具调用 / 长上下文
  await resetCalls();
  const toolReq = [{ type: 'function', function: { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } } }];
  const r15a = await post(ask('case15a', 'capability', { tools: toolReq }));
  const c15a = await calls();
  check('带工具时跳过本地模型', r15a.status === 200 && r15a.headers['x-router-model'] === 'good-b', `status=${r15a.status} model=${r15a.headers['x-router-model']}`);
  check('本地模型完全未被请求', !c15a.some((c) => c.model === 'qwen3b'), JSON.stringify(c15a.map((c) => c.model)));
  check('日志标记能力跳过原因', /skip=incapable\(plocal:no-tools\(1\)\)/.test(log), log.slice(-600));

  await resetCalls();
  const r15b = await post(ask('case15b', 'capability'));
  check('纯聊天仍可用本地模型', r15b.status === 200 && r15b.headers['x-router-provider'] === 'plocal', `provider=${r15b.headers['x-router-provider']}`);

  await resetCalls();
  const r15c = await post(ask('case15c', 'capability', { messages: [{ role: 'user', content: 'x'.repeat(8000) }] }));
  check('长上下文跳过本地模型', r15c.headers['x-router-provider'] === 'pb', `provider=${r15c.headers['x-router-provider']}`);

  // 16 带工具的 simple 请求不再按「简单任务」处理
  await resetCalls();
  const r16 = await post(ask('case16', 'simple', { tools: toolReq }));
  check('带工具的 simple 升到 coding', r16.status === 200 && r16.headers['x-router-provider'] === 'pd', `status=${r16.status} provider=${r16.headers['x-router-provider']}`);
  for (let n = 0; n < 50 && !/upgrade=simple->coding/.test(log); n++) await new Promise((resolve) => setImmediate(resolve));
  check('升档有迹可循', /upgrade=simple->coding\(tools=1\)/.test(log), log.slice(-600));

  // 17 单个模型 5xx 不拖垮整家；连续两次才认定厂商级
  await resetCalls();
  const r17a = await post(ask('case17a', 'srvmodel'));
  const h17 = await (await fetch(`${base}/admin/health`)).json();
  check('单模型 5xx 换模型后成功', r17a.status === 200 && r17a.headers['x-router-model'] === 'good-a', `status=${r17a.status} model=${r17a.headers['x-router-model']}`);
  check('不因单模型 5xx 熔断厂商', h17.providers.find((p) => p.id === 'pn').open === false, JSON.stringify(h17.providers.find((p) => p.id === 'pn')));

  await resetCalls();
  const r17b = await post(ask('case17b', 'srvdead'));
  const h17b = await (await fetch(`${base}/admin/health`)).json();
  check('连续 5xx 才整家跳过', r17b.status === 200 && r17b.headers['x-router-provider'] === 'pb', `status=${r17b.status} provider=${r17b.headers['x-router-provider']}`);
  check('死掉的厂商被熔断', h17b.providers.find((p) => p.id === 'po').open === true, JSON.stringify(h17b.providers.find((p) => p.id === 'po')));

  // 18 观测接口
  const health = await (await fetch(`${base}/admin/health`)).json();
  check('health 暴露熔断状态', Array.isArray(health.providers) && health.providers.some((p) => p.open), JSON.stringify(health.providers.map((p) => [p.id, p.open])));
  check('失败记录带请求形状', Array.isArray(health.recentFails) && health.recentFails.some((f) => typeof f.shape === 'string'), JSON.stringify(health.recentFails.slice(-1)));
  const plan = await (await fetch(`${base}/admin/plan?route=simple&retry=2`)).json();
  check('plan 预览可用', plan.steps.length > 0, JSON.stringify(plan).slice(0, 200));
  const planCoding = await (await fetch(`${base}/admin/plan?route=coding`)).json();
  check('coding 计划不含本地模型', !planCoding.steps.some((s) => s.provider === 'plocal'), JSON.stringify(planCoding.steps));
  check('档位限制有日志', planCoding.notes.some((n) => n.includes('incapable(plocal:tier(coding))')), JSON.stringify(planCoding.notes));
  const planSimple = await (await fetch(`${base}/admin/plan?route=simple`)).json();
  check('simple 计划保留本地兜底', planSimple.steps.some((s) => s.provider === 'plocal'), JSON.stringify(planSimple.steps));
  // 15 所有状态文件跟随临时配置目录，不访问个人配置或付费上游。
  await fetch(`${base}/admin/breaker/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await resetCalls();
  const usage = await post(ask('stream-usage', 'streamusage'));
  check('usage 与 DONE 原样透传', usage.status === 200 && usage.text.includes('"total_tokens":4') && usage.text.includes('[DONE]'), usage.text);

  // HTTP 200/首包不能抢记成功，必须等完整结束。
  await resetCalls();
  let logAt = log.length;
  const pending = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask('stream-slow', 'streamslow')),
  });
  const pendingReader = pending.body.getReader();
  await pendingReader.read();
  check('首包到达时未记录成功', !/route=streamslow .* ok /.test(log.slice(logAt)), log.slice(logAt));
  for (;;) { if ((await pendingReader.read()).done) break; }
  await (await fetch(`${base}/admin/health`)).json();
  const slowLog = log.slice(logAt);
  const timing = slowLog.match(/dur=(\d+)ms e2e=(\d+)ms first=(\d+)ms state=completed/);
  check('完整结束后记录成功及首内容与端到端耗时', /route=streamslow .* ok /.test(slowLog) && timing && Number(timing[2]) >= Number(timing[3]) && Number(timing[1]) >= 400, slowLog);

  for (const route of ['streamcut', 'streamnodone']) {
    await resetCalls();
    logAt = log.length;
    let interrupted = false;
    try { await post(ask(`case-${route}`, route)); } catch { interrupted = true; }
    const streamHealth = await (await fetch(`${base}/admin/health`)).json();
    const streamCalls = await calls();
    check(`${route} 客户端可见断流`, interrupted, '响应被错误正常结束');
    check(`${route} 断流不记成功且不自动重放`, !/ ok /.test(log.slice(logAt)) && /state=upstream_interrupted/.test(log.slice(logAt)) && streamCalls.length === 1, log.slice(logAt));
    check(`${route} 保留终态失败记录`, streamHealth.recentFails.some((f) => f.route === route && f.kind === 'upstream_interrupted'), JSON.stringify(streamHealth.recentFails.slice(-1)));
  }

  await resetCalls();
  logAt = log.length;
  const cancelled = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask('stream-cancel', 'streamslow')),
  });
  const cancelReader = cancelled.body.getReader();
  await cancelReader.read();
  await cancelReader.cancel();
  // 让 mock 的原连接 close 成为同步屏障，避免依赖固定等待时间。
  for (let n = 0; n < 50; n++) {
    const c = await calls();
    if (c[0]?.closed && /state=client_cancelled/.test(log.slice(logAt))) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const cancelCalls = await calls();
  check('客户端取消归类 CANCEL 而非成功或上游故障', / CANCEL .*state=client_cancelled/.test(log.slice(logAt)) && !/ ok | FAIL /.test(log.slice(logAt)), log.slice(logAt));
  check('客户端取消中止上游且不自动重放', cancelCalls.length === 1 && cancelCalls[0].closed === true, JSON.stringify(cancelCalls));

  logAt = log.length;
  const tools = await post(ask('stream-tools', 'streamtools'));
  await (await fetch(`${base}/admin/health`)).json();
  const firstTool = log.slice(logAt).match(/first=(\d+)ms state=completed/);
  check('工具流与 usage 原样透传', tools.text.includes('"tool_calls"') && tools.text.includes('"total_tokens":4'), tools.text);
  check('首内容忽略 role 与心跳并识别工具调用', firstTool && Number(firstTool[1]) >= 50, log.slice(logAt));

  await resetCalls();
  logAt = log.length;
  const controller = new AbortController();
  const earlyCancel = fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask('early-cancel', 'streamdelayed')), signal: controller.signal,
  }).catch(() => null);
  for (let n = 0; n < 100; n++) {
    if ((await calls()).some((c) => c.model === 'delayed-headers')) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();
  await earlyCancel;
  for (let n = 0; n < 100; n++) {
    if (/state=client_cancelled/.test(log.slice(logAt))) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const earlyCalls = await calls();
  const earlyHealth = await (await fetch(`${base}/admin/health`)).json();
  check('首包前取消不换模型或厂商', earlyCalls.length === 1 && / CANCEL .*state=client_cancelled/.test(log.slice(logAt)), JSON.stringify(earlyCalls) + log.slice(logAt));
  check('首包前取消不熔断厂商', earlyHealth.providers.find((p) => p.id === 'pa').open === false, JSON.stringify(earlyHealth.providers.find((p) => p.id === 'pa')));

  // 19 能力死局：整条链只有本地小模型，却带着工具 → 立刻 400，不让客户端 30s×3 空转
  await resetCalls();
  const r19 = await post2(ask('case19', 'only', { tools: toolReq }));
  const c19 = await calls();
  check('无可用能力时立即 400', r19.status === 400, `status=${r19.status} ${r19.text.slice(0, 200)}`);
  check('标注 router_no_capable_model', /router_no_capable_model/.test(r19.text), r19.text.slice(0, 240));
  check('明确不可重试且无 Retry-After', /"retryable":false/.test(r19.text) && !r19.headers['retry-after'], JSON.stringify(r19.headers));
  check('不做任何上游尝试', c19.length === 0, JSON.stringify(c19.map((c) => c.model)));

  // 20 已知且持续的故障：熔断已存在一段时间 → 直接 400，不再让客户端等下一轮
  await resetCalls();
  await post2(ask('case20', 'dead'));
  await sleep(350);
  const t20 = Date.now();
  const r20 = await post2(ask('case20b', 'dead'));
  check('已知故障快速失败 400', r20.status === 400 && Date.now() - t20 < 600, `status=${r20.status} ${Date.now() - t20}ms`);
  check('归因为 router_cooling', /router_cooling/.test(r20.text), r20.text.slice(0, 240));
  check('冷却期不给 Retry-After', !r20.headers['retry-after'], JSON.stringify(r20.headers));

  // 21 路由策略来自配置：strategy=cost 时同一档内按成本重排
  const planCheap = await (await fetch(`${base}/admin/plan?route=cheap`)).json();
  check('strategy 回显为 cost', planCheap.strategy === 'cost', JSON.stringify(planCheap).slice(0, 200));
  check('低成本厂商排到最前', planCheap.steps[0] && planCheap.steps[0].provider === 'pc1', JSON.stringify(planCheap.steps));
  const planDefault = await (await fetch(`${base}/admin/plan?route=simple`)).json();
  check('未配置策略时保持配置顺序', planDefault.strategy === 'priority' && planDefault.steps[0].provider === 'pa', JSON.stringify(planDefault.steps));

  // 22 升级档位跟随配置，不因新增路由被改写
  const h22 = await (await fetch(`${base}/admin/health`)).json();
  check('tiers 严格来自配置', JSON.stringify(h22.policy.tiers) === JSON.stringify(['retryA', 'retryB', 'borrowSrc', 'borrowDst', 'allfail']), JSON.stringify(h22.policy.tiers));
  check('能力守卫参数可观测', h22.guard && h22.guard.fastFailStaleMs === 200, JSON.stringify(h22.guard));

  const testConfig = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  testConfig.upstreamTimeoutMs = 150;
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(testConfig));
  await fetch(`${base}/admin/reload`, { method: 'POST' });
  await resetCalls();
  logAt = log.length;
  let timedOut = false;
  try { await post(ask('stream-timeout', 'streamtimeout')); } catch { timedOut = true; }
  await (await fetch(`${base}/admin/health`)).json();
  const timeoutCalls = await calls();
  check('流中超时明确失败且不重放', timedOut && /state=upstream_timeout/.test(log.slice(logAt)) && timeoutCalls.length === 1, log.slice(logAt));
  check('无内容超时首内容计时为空', /first=- state=upstream_timeout/.test(log.slice(logAt)), log.slice(logAt));
  check('临时配置目录包含独立配置', fs.existsSync(path.join(tmp, 'config.json')) && !fs.existsSync(path.join(tmp, 'router.log')), tmp);
} catch (e) {
  check('测试执行', false, String((e && e.stack) || e));
} finally {
  router.kill('SIGKILL');
  router2.kill('SIGKILL');
  mock.kill('SIGKILL');
  try {
    if (process.env.ROUTER_TEST_VERBOSE) console.log(log);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  } catch { /* 忽略清理失败 */ }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n==== ${results.length - failed}/${results.length} 通过 ====`);
  process.exit(failed ? 1 : 0);
}
