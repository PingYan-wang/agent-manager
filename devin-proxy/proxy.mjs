#!/usr/bin/env node
// devin-proxy — 将 Devin CLI（devin -p 无头模式）包装成 OpenAI 兼容接口。
// 用途：把 Devin 账户可用的前沿模型（Opus / GPT / Gemini 等）反代理为
// OpenAI 兼容上游，供 Hermes 智能路由在 Reverix 不可用时兜底。
//
// 环境变量：
//   PORT                 监听端口（默认 8790），仅绑定 127.0.0.1
//   DEVIN_PROXY_KEY      Bearer 鉴权 key（必填，路由器 config.json 的 apiKey 需一致）
//   DEVIN_BIN            devin CLI 路径（默认 Devin.app 内嵌 CLI）
//   DEVIN_MODEL_MAP      JSON：{"对外模型名":"devin --model 值"}，缺省原样透传
//   DEVIN_PROXY_WORKDIR  CLI 工作目录（默认 ~/.hermes/devin-proxy/work）
//   DEVIN_PROXY_TIMEOUT_MS 单次调用超时（默认 600000）
//   DEVIN_PROXY_CONCURRENCY 最大并发（默认 2，每个并发都是一个 Devin agent 会话，谨慎调大）

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const KEY = process.env.DEVIN_PROXY_KEY || '';
const DEVIN_BIN = process.env.DEVIN_BIN || '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin';
const WORK_DIR = process.env.DEVIN_PROXY_WORKDIR || path.join(os.homedir(), '.hermes', 'devin-proxy', 'work');
const TIMEOUT_MS = Number(process.env.DEVIN_PROXY_TIMEOUT_MS || 600000);
const CONCURRENCY = Math.max(1, Number(process.env.DEVIN_PROXY_CONCURRENCY || 2));

let MODEL_MAP = {};
try { MODEL_MAP = JSON.parse(process.env.DEVIN_MODEL_MAP || '{}'); } catch { /* 忽略非法 JSON，走透传 */ }

fs.mkdirSync(WORK_DIR, { recursive: true });

function log(...args) { console.log(new Date().toISOString(), ...args); }

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '');
}

function flattenMessages(messages) {
  const lines = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m?.role || 'user';
    let content = m?.content;
    if (Array.isArray(content)) content = content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n');
    if (content == null) continue;
    lines.push(`[${role}]\n${String(content).trim()}`);
  }
  return lines.join('\n\n');
}

function estimateTokens(s) { return Math.max(1, Math.ceil(String(s).length / 4)); }

// 并发闸：每个槽位一个 Devin agent 会话，默认 2
let active = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (active < CONCURRENCY) { active++; resolve(); }
      else queue.push(tryAcquire);
    };
    tryAcquire();
  });
}
function release() {
  active--;
  const next = queue.shift();
  if (next) next();
}

function runDevin(model, prompt) {
  return new Promise((resolve, reject) => {
    const devinModel = MODEL_MAP[model] || model;
    const args = ['-p', '--permission-mode', 'auto'];
    if (devinModel && devinModel !== 'default') args.push('--model', devinModel);
    args.push('--', prompt);
    const started = Date.now();
    const child = spawn(DEVIN_BIN, args, {
      cwd: WORK_DIR,
      env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      reject(Object.assign(new Error(`devin CLI 超时（${TIMEOUT_MS}ms）`), { statusCode: 504 }));
    }, TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`devin CLI 启动失败: ${e.message}`), { statusCode: 502 })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code !== 0) {
        log(`ERROR model=${model} code=${code} ms=${ms} err=${stripAnsi(err).slice(-300)}`);
        reject(Object.assign(new Error(`devin CLI 退出码 ${code}: ${stripAnsi(err).slice(-300)}`), { statusCode: 502 }));
        return;
      }
      const content = stripAnsi(out).trim();
      log(`OK model=${model} devinModel=${devinModel} ms=${ms} chars=${content.length}`);
      resolve(content);
    });
  });
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function authorized(req) {
  if (!KEY) return true; // 未配置 key 时仅本机可用（绑定 127.0.0.1）
  const h = req.headers.authorization || '';
  return h === `Bearer ${KEY}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, active, queued: queue.length, concurrency: CONCURRENCY, timeoutMs: TIMEOUT_MS });
  }

  if (!url.pathname.startsWith('/v1/')) return sendJson(res, 404, { error: { message: 'not found' } });
  if (!authorized(req)) return sendJson(res, 401, { error: { message: 'invalid api key' } });

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const ids = Object.keys(MODEL_MAP);
    return sendJson(res, 200, {
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'devin-cli' })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) return sendJson(res, 413, { error: { message: 'body too large' } });
    }
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { error: { message: 'invalid JSON' } }); }
    if (body.stream) return sendJson(res, 400, { error: { message: 'stream not supported; set stream=false', type: 'invalid_request_error' } });
    const model = String(body.model || 'default');
    const prompt = flattenMessages(body.messages);
    if (!prompt.trim()) return sendJson(res, 400, { error: { message: 'messages empty', type: 'invalid_request_error' } });

    try {
      await acquire();
      let content;
      try { content = await runDevin(model, prompt); }
      finally { release(); }
      return sendJson(res, 200, {
        id: `chatcmpl-devin-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: estimateTokens(prompt),
          completion_tokens: estimateTokens(content),
          total_tokens: estimateTokens(prompt) + estimateTokens(content),
        },
      });
    } catch (e) {
      const status = e.statusCode || 500;
      return sendJson(res, status, { error: { message: String(e.message || e), type: 'devin_cli_error' } });
    }
  }

  return sendJson(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, HOST, () => {
  log(`devin-proxy listening on http://${HOST}:${PORT} concurrency=${CONCURRENCY} timeout=${TIMEOUT_MS}ms bin=${DEVIN_BIN}`);
});
