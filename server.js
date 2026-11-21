#!/usr/bin/env node
// Agent Manager — 统一管理 MCPHub (MCP) 与 asm (Skills) 的本地可视化前端
// 依赖: Node >= 18, 全局安装的 @samanhappy/mcphub 与 agent-skill-manager
import http from 'node:http';
import https from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { readFile, readdir, stat, mkdir, symlink, realpath, lstat, writeFile, unlink, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { watch } from 'node:fs';
import { initOrchestrator, handleOrchestratorApi } from './orchestrator.js';
import { config, HOME, DATA_DIR } from './config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = config.port;
const HUB_URL = config.hubUrl;
const HUB_KEY = config.hubKey;
const ASM = config.asmBin;
const SKILLS_SH = 'https://skills.sh/api/search';
const MCP_REGISTRY = 'https://registry.modelcontextprotocol.io';

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });

async function hubFetch(method, apiPath, body) {
  const res = await fetch(`${HUB_URL}/api${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${HUB_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

function asmRun(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(ASM, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
        error: err && err.killed ? '命令超时' : err ? String(err.message || err) : null,
      });
    });
  });
}

function runCmd(bin, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

let balanceCache = null;

// 市场来源（skills.sh 等）生成的 github:owner/repo:skills/<id> 路径可能与仓库实际布局不符。
// 安装报 "No SKILL.md found" 时，按 GitHub API 定位真实 SKILL.md 所在目录后重试。
async function resolveGithubSkillPath(source) {
  const m = String(source || '').match(/^github:([^/:\s]+)\/([^/:\s]+)(?::(.+))?$/);
  if (!m || !m[3]) return null;
  const [, owner, repo] = m;
  try {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { 'User-Agent': 'agent-manager', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!repoRes.ok) return null;
    const { default_branch: branch = 'main' } = await repoRes.json();
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, {
      headers: { 'User-Agent': 'agent-manager', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!treeRes.ok) return null;
    const { tree = [], truncated } = await treeRes.json();
    if (truncated) return null;
    const skillMds = tree.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path)).map((t) => t.path);
    if (!skillMds.length) return null;
    const want = m[3].split('/').filter(Boolean).pop().toLowerCase();
    const dirOf = (p) => p.split('/').slice(0, -1).join('/');
    const pick = skillMds.find((p) => dirOf(p).split('/').pop().toLowerCase() === want)
      || skillMds.find((p) => dirOf(p).toLowerCase().includes(want))
      || (skillMds.length === 1 ? skillMds[0] : null);
    if (!pick) return null;
    const fixed = `github:${owner}/${repo}:${dirOf(pick)}`;
    return fixed === source ? null : fixed;
  } catch { return null; }
}

async function asmInstallWithPathFix(source, args) {
  let r = await asmRun(args, 300000);
  if (r.code !== 0 && /No SKILL\.md/i.test(`${r.stdout}\n${r.stderr}`)) {
    const fixed = await resolveGithubSkillPath(source);
    if (fixed) {
      r = await asmRun(args.map((a) => (a === source ? fixed : a)), 300000);
      if (r.code === 0) return { r, usedSource: fixed };
    }
  }
  return { r, usedSource: source };
}

const GH_HEADERS = { 'User-Agent': 'agent-manager', Accept: 'application/vnd.github+json' };

async function githubRepoInfo(owner, repo) {
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: GH_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const d = await r.json();
  return { branch: d.default_branch || 'main' };
}

async function findSkillDirs(root, maxDepth = 5) {
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > maxDepth || out.length > 50) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'skill.md')) { out.push(dir); return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(dir, e.name), depth + 1);
  };
  await walk(root, 0);
  return out;
}

// github.com 的 git/https 端点在部分网络下不可达（api.github.com 与 codeload 正常），
// asm 内部 git clone 会 60s 超时。此时改走 tarball 直装：下载压缩包 → 解压 →
// 复制 SKILL.md 目录到 ~/.agents/skills（asm global scope），再由 syncAllSkills 铺到所有 Agent。
async function installGithubSkillDirect(source) {
  const m = String(source || '').match(/^(?:github:|https?:\/\/github\.com\/)([^/:\s]+)\/([^/:\s]+?)(?:\.git)?(?::(.+))?$/);
  if (!m) return null;
  const [, owner, repo, rawPath] = m;
  const info = await githubRepoInfo(owner, repo);
  if (!info) return { error: 'GitHub API 访问失败' };
  const tmp = await mkdtemp(path.join(tmpdir(), 'ghskill-'));
  try {
    const tarPath = path.join(tmp, 'repo.tar.gz');
    const dl = await fetch(`https://api.github.com/repos/${owner}/${repo}/tarball/${encodeURIComponent(info.branch)}`, {
      headers: GH_HEADERS, signal: AbortSignal.timeout(180000), redirect: 'follow',
    });
    if (!dl.ok) return { error: `tarball 下载失败 HTTP ${dl.status}` };
    await writeFile(tarPath, Buffer.from(await dl.arrayBuffer()));
    await new Promise((res, rej) => execFile('tar', ['-xzf', tarPath, '-C', tmp], (e) => (e ? rej(e) : res())));
    const top = (await readdir(tmp)).find((d) => d !== 'repo.tar.gz');
    if (!top) return { error: 'tarball 解压为空' };
    const repoRoot = path.join(tmp, top);
    let candidates;
    if (rawPath) {
      const p = path.join(repoRoot, rawPath);
      candidates = await findSkillDirs(p, 2);
      if (!candidates.length) {
        try { await stat(path.join(p, 'SKILL.md')); candidates = [p]; } catch { /* 无 */ }
      }
    }
    // market 生成的路径经常与仓库实际布局不符（如 skills/x 实为 plugins/y/skills/x），
    // 路径落空时回退到全仓库搜索，再按目录名匹配
    if (!candidates || !candidates.length) candidates = await findSkillDirs(repoRoot);
    if (!candidates.length) return { error: `仓库中未找到 SKILL.md${rawPath ? `（路径 ${rawPath}）` : ''}` };
    const want = rawPath ? rawPath.split('/').filter(Boolean).pop().toLowerCase() : '';
    const pick = candidates.find((d) => path.basename(d).toLowerCase() === want)
      || (candidates.length === 1 ? candidates[0] : null);
    if (!pick) return { error: `找到 ${candidates.length} 个 skill，无法确定目标` };
    const name = path.basename(pick);
    const targetRoot = path.join(HOME, '.agents', 'skills');
    const dest = path.join(targetRoot, name);
    if (await exists(dest)) return { ok: true, name, path: dest, note: '已存在，跳过复制' };
    await mkdir(targetRoot, { recursive: true });
    await cp(pick, dest, { recursive: true });
    return { ok: true, name, path: dest };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

let githubGitOk = null; // github.com git 端点探测缓存；不可达时跳过 asm 的 60s clone 超时
function githubGitReachable() {
  if (githubGitOk !== null) return Promise.resolve(githubGitOk);
  githubGitOk = new Promise((resolve) => {
    execFile('git', ['ls-remote', 'https://github.com/git/git.git', 'HEAD'], { timeout: 12000 }, (e) => resolve(!e));
  });
  return githubGitOk;
}

const tryJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
};

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

// CLI 可执行文件探测：优先 PATH，再补常见安装目录；60s 缓存
const BIN_DIRS = [`${process.env.HOME}/.npm-global/bin`, '/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`, '/usr/bin', '/bin'];
const whichCache = new Map();
async function whichBin(bin) {
  const hit = whichCache.get(bin);
  if (hit && Date.now() - hit.at < 60000) return hit.path;
  let found = null;
  const w = await runCmd('/usr/bin/which', [bin], 5000);
  if (w.code === 0 && w.stdout.trim()) found = w.stdout.trim().split('\n')[0];
  if (!found) for (const d of BIN_DIRS) {
    const p = path.join(d, bin);
    if (await exists(p)) { found = p; break; }
  }
  whichCache.set(bin, { path: found, at: Date.now() });
  return found;
}

// 进程完整命令行快照（5s 缓存），用于按 procRe 正则判断 agent 是否在运行
let procSnap = { at: 0, lines: [] };
async function procLines() {
  if (Date.now() - procSnap.at < 5000) return procSnap.lines;
  const { stdout } = await runCmd('/bin/ps', ['-axo', 'command='], 5000);
  procSnap = { at: Date.now(), lines: (stdout || '').toLowerCase().split('\n').filter(Boolean) };
  return procSnap.lines;
}
function procRunning(lines, patterns) {
  const res = (patterns || []).map((p) => new RegExp(p, 'i'));
  return res.length > 0 && lines.some((l) => res.some((re) => re.test(l)));
}

// ---------- Agent 注册表 ----------
// mcpFiles: 候选 MCP 配置文件（JSON，含 mcpServers 键；codex 为 TOML 单独解析）
// skillDirs: 候选 skill 目录（每个子目录含 SKILL.md 视为一个 skill）
const AGENTS = [
  {
    id: 'workbuddy', name: 'WorkBuddy', app: '/Applications/WorkBuddy.app', procRe: ['workbuddy\\.app/'],
    mcpFiles: [{ path: `${HOME}/.workbuddy/mcp.json`, kind: 'json' }],
    skillDirs: [`${HOME}/.workbuddy/skills`, `${HOME}/.workbuddy/connectors/skills`],
  },
  {
    id: 'codex', name: 'Codex (ChatGPT)', app: '/Applications/ChatGPT.app', procRe: ['chatgpt\\.app/'], cli: 'codex',
    cliCandidates: ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'],
    mcpFiles: [{ path: `${HOME}/.codex/config.toml`, kind: 'toml' }],
    skillDirs: [`${HOME}/.codex/skills`, `${HOME}/.agents/skills`],
  },
  {
    id: 'devin', name: 'Devin', app: '/Applications/Devin.app', procRe: ['devin\\.app/'], cli: 'devin',
    cliCandidates: ['/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin'],
    mcpFiles: [{ path: `${HOME}/.config/devin/mcp_config.json`, kind: 'json' }],
    skillDirs: [`${HOME}/.config/devin/skills`],
    // Devin CLI 会原生导入这些目录的 skill（read-config-from 官方文档）
    importSkillDirs: [`${HOME}/.codex/skills`, `${HOME}/.copilot/skills`, `${HOME}/.kiro/skills`, `${HOME}/.codeium/windsurf/skills`],
  },
  {
    id: 'windsurf', name: 'Windsurf', app: '/Applications/Windsurf.app', procRe: ['windsurf\\.app/'],
    mcpFiles: [{ path: `${HOME}/.codeium/windsurf/mcp_config.json`, kind: 'json' }],
    skillDirs: [`${HOME}/.codeium/windsurf/skills`],
  },
  {
    id: 'claude', name: 'Claude', app: '/Applications/Claude.app', procRe: ['claude\\.app/', '\\bclaude\\b'], cli: 'claude',
    mcpFiles: [
      { path: `${HOME}/.claude.json`, kind: 'json' },
      { path: `${HOME}/Library/Application Support/Claude/claude_desktop_config.json`, kind: 'json' },
    ],
    skillDirs: [`${HOME}/.claude/skills`],
  },
  {
    id: 'cursor', name: 'Cursor', app: '/Applications/Cursor.app', procRe: ['cursor\\.app/'],
    mcpFiles: [{ path: `${HOME}/.cursor/mcp.json`, kind: 'json' }],
    skillDirs: [`${HOME}/.cursor/skills`],
  },
  {
    id: 'gemini', name: 'Gemini CLI', procRe: ['\\bgemini\\b'], cli: 'gemini',
    mcpFiles: [{ path: `${HOME}/.gemini/settings.json`, kind: 'json' }],
    skillDirs: [`${HOME}/.gemini/skills`],
  },
  {
    id: 'hermes', name: 'Hermes', app: '/Applications/Hermes.app', procRe: ['hermes\\.app/', 'hermes[-_]agent', 'hermes_cli'], cli: 'hermes',
    cliCandidates: [`${HOME}/.hermes/hermes-agent/hermes`],
    mcpFiles: [{ path: `${HOME}/.hermes/config.yaml`, kind: 'yaml' }],
    skillDirs: [`${HOME}/.hermes/skills`],
  },
];

// 解析 JSON 类 mcpServers 配置 → 归一化列表
function normMcpJson(obj) {
  const servers = obj?.mcpServers || obj?.servers || {};
  return Object.entries(servers).map(([name, c]) => {
    if (typeof c !== 'object' || c === null) return { name, raw: c };
    const type = String(c.type || c.transport || '').toLowerCase();
    const url = c.url || c.serverUrl;
    const isHttp = !!url || type.includes('http') || type.includes('sse');
    return {
      name,
      kind: isHttp ? 'http' : 'stdio',
      transport: !isHttp ? 'stdio' : type.includes('sse') && !type.includes('stream') && !type.includes('http') ? 'sse' : 'streamable-http',
      url,
      command: c.command,
      args: Array.isArray(c.args) ? c.args : c.args ? [c.args] : [],
      env: c.env || {},
      headers: c.headers || {},
      disabled: !!(c.disabled || c.enabled === false),
      raw: c,
    };
  });
}

// 极简 TOML: 解析 [mcp_servers.<name>] 及其 .env/.http_headers 子表（codex config.toml 用）
function normMcpToml(text) {
  const servers = new Map();
  let cur = null;      // 当前 server 对象
  let sub = null;      // 当前子表名: 'env' | 'http_headers' | 'env_http_headers' | null
  const get = (name) => {
    if (!servers.has(name)) servers.set(name, { name, kind: 'stdio', transport: 'stdio', args: [], env: {}, headers: {}, disabled: false });
    return servers.get(name);
  };
  for (const line of text.split('\n')) {
    const sec = line.match(/^\s*\[mcp_servers\.([^\]]+)\]/);
    if (sec) {
      const rest = sec[1].trim();
      const dot = rest.indexOf('.');
      if (dot === -1) { cur = get(rest.replace(/^"|"$/g, '')); sub = null; }
      else {
        // 子表: name.env / name.http_headers / name.env_http_headers
        const sname = rest.slice(0, dot).replace(/^"|"$/g, '');
        const subName = rest.slice(dot + 1);
        cur = get(sname);
        sub = ['env', 'http_headers', 'env_http_headers'].includes(subName) ? subName : null;
      }
      continue;
    }
    if (/^\s*\[/.test(line)) { cur = null; sub = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    const unquote = (x) => {
      x = x.trim();
      if (x.startsWith("'")) return x.slice(1, x.lastIndexOf("'"));
      if (x.startsWith('"')) {
        try { return JSON.parse(x); } catch { return x.slice(1, x.lastIndexOf('"')); }
      }
      return x;
    };
    if (sub === 'env') { cur.env[k] = unquote(v); continue; }
    if (sub === 'http_headers' || sub === 'env_http_headers') { cur.headers[k] = unquote(v); continue; }
    if (sub) continue;
    if (k === 'url') { cur.url = unquote(v); cur.kind = 'http'; cur.transport = 'streamable-http'; }
    else if (k === 'command') cur.command = unquote(v);
    else if (k === 'args') cur.args = [...v.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    else if (k === 'enabled' && v.trim() === 'false') cur.disabled = true;
  }
  return [...servers.values()].map((s) => ({
    ...s,
    kind: s.url ? 'http' : 'stdio',
    transport: s.url ? 'streamable-http' : 'stdio',
  }));
}

// 极简 YAML: 解析 config.yaml 的 mcp_servers: 段（hermes 等），支持 url/command/args/headers/enabled
function normMcpYaml(text) {
  const servers = [];
  let inSection = false, cur = null, sub = null;
  const unquote = (x) => {
    x = x.trim();
    if ((x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'"))) return x.slice(1, -1);
    return x;
  };
  for (const line of text.split('\n')) {
    if (/^\S/.test(line) && !/^\s/.test(line)) {
      // 顶层键：进入/离开 mcp_servers 段
      inSection = /^mcp_servers\s*:/.test(line);
      cur = null; sub = null;
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^(\s+)([\w.-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length, key = m[2], val = m[3];
    if (indent === 2 && val === '') { cur = { name: key, kind: 'stdio', transport: 'stdio', args: [], env: {}, headers: {}, disabled: false }; servers.push(cur); sub = null; continue; }
    if (!cur) continue;
    if (indent === 4 && sub === null) {
      if (key === 'url') { cur.url = unquote(val); cur.kind = 'http'; cur.transport = 'streamable-http'; }
      else if (key === 'command') cur.command = unquote(val);
      else if (key === 'type' && /sse/i.test(val)) { cur.transport = 'sse'; }
      else if (key === 'enabled' && /false/.test(val)) cur.disabled = true;
      else if (key === 'headers') sub = 'headers';
      else if (key === 'args') { try { cur.args = JSON.parse(val); } catch { cur.args = val ? [unquote(val)] : []; } }
      continue;
    }
    if (indent === 6 && sub === 'headers') { cur.headers[key] = unquote(val); continue; }
    if (indent <= 4) sub = null;
  }
  return servers.map((s) => ({ ...s, kind: s.url ? 'http' : 'stdio', transport: s.url ? (s.transport === 'sse' ? 'sse' : 'streamable-http') : 'stdio' }));
}

async function scanSkillsInDir(dir) {
  const skills = [];
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      for (const cand of ['SKILL.md', 'skill.md', 'Skill.md']) {
        if (await exists(path.join(p, cand))) { skills.push({ name: e.name, path: p }); break; }
      }
    }
  } catch { /* dir 不存在 */ }
  return skills;
}

// 递归查找目录下指定文件名（限深度），用于发现插件内的 mcp.json
async function findFiles(dir, filename, maxDepth = 6, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      await findFiles(p, filename, maxDepth, depth + 1, out);
    } else if (e.name === filename) out.push(p);
  }
  return out;
}

async function scanAgents() {
  const agents = [];
  const procs = await procLines();
  const hubMcp = `${HUB_URL}/mcp`;
  for (const a of AGENTS) {
    // workbuddy 等插件型 agent：额外扫描插件目录下的 mcp.json
    const extraMcpFiles = [];
    if (a.id === 'workbuddy') {
      // 只扫描已安装插件的 installPath，避免把插件市场目录里的数百个 catalog 条目当成已配置 MCP
      try {
        const inst = JSON.parse(await readFile(`${HOME}/.workbuddy/plugins/installed_plugins.json`, 'utf8'));
        const installPaths = new Set();
        for (const entries of Object.values(inst.plugins || {})) {
          for (const e of entries) if (e.installPath) installPaths.add(e.installPath);
        }
        for (const ip of installPaths) {
          for (const p of await findFiles(ip, 'mcp.json', 3)) {
            extraMcpFiles.push({ path: p, kind: 'json' });
          }
        }
      } catch {}
    }
    const allMcpFiles = [...a.mcpFiles, ...extraMcpFiles];
    let hasConfig = false, hasSkills = false;
    const mcpServers = [];
    for (const f of allMcpFiles) {
      if (!(await exists(f.path))) continue;
      hasConfig = true;
      if (f.kind === 'json') {
        const obj = await readJson(f.path);
        if (obj) mcpServers.push(...normMcpJson(obj));
      } else if (f.kind === 'yaml') {
        mcpServers.push(...normMcpYaml(await readFile(f.path, 'utf8').catch(() => '')));
      } else {
        mcpServers.push(...normMcpToml(await readFile(f.path, 'utf8').catch(() => '')));
      }
    }
    const skills = [];
    const seen = new Set();
    for (const d of a.skillDirs || []) {
      for (const s of await scanSkillsInDir(d)) {
        if (seen.has(s.name)) continue;
        seen.add(s.name); skills.push({ ...s, via: 'native' });
      }
    }
    for (const d of a.importSkillDirs || []) {
      for (const s of await scanSkillsInDir(d)) {
        if (seen.has(s.name)) continue;
        seen.add(s.name); skills.push({ ...s, via: 'import' });
      }
    }
    if (skills.length) hasSkills = true;
    const appExists = a.app ? await exists(a.app) : false;
    let cliPath = null;
    for (const c of a.cliCandidates || []) if (await exists(c)) { cliPath = c; break; }
    if (!cliPath && a.cli) cliPath = await whichBin(a.cli);
    const running = a.procRe ? procRunning(procs, a.procRe) : false;
    // 该 agent 是否已把 MCPHub 网关配进自己的 MCP 配置
    const mcphub = mcpServers.some((s) => !s.disabled && (/mcphub/i.test(s.name || '') || (s.url || '').includes(hubMcp)));
    agents.push({
      ...a,
      installed: appExists || hasConfig || hasSkills,
      mcpServers,
      skills,
      appExists,
      cliPath,
      running,
      mcphub,
    });
  }
  return agents;
}

// 在给定路径中定位包含 SKILL.md 的目录（兼容 skill 根目录 / 插件根 / skills 集合目录）
async function findSkillDir(p) {
  if (!p) return null;
  const hasSkill = async (d) => exists(path.join(d, 'SKILL.md'));
  try {
    const rp = await realpath(p);
    if (await hasSkill(rp)) return rp;
    // 常见嵌套: <root>/skills/<name>/SKILL.md 或 <root>/<name>/SKILL.md
    for (const sub of ['skills', '.']) {
      const base = sub === '.' ? rp : path.join(rp, 'skills');
      try {
        for (const e of await readdir(base, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const cand = path.join(base, e.name);
          if (await hasSkill(cand)) return cand;
        }
      } catch { /* 目录不存在 */ }
    }
  } catch { /* realpath 失败 */ }
  return null;
}

// 收集所有已知 skill 来源（asm 管理的 + 各 agent 目录扫描到的），按 realpath 去重
async function collectAllSkills() {
  const byReal = new Map(); // realPath -> {name, path}
  const add = async (p) => {
    const dir = await findSkillDir(p);
    if (!dir) return;
    const name = path.basename(dir);
    if (!byReal.has(dir)) byReal.set(dir, { name, path: dir });
  };
  const r = await asmRun(['list', '--json', '-s', 'both']);
  const list = tryJson(r.stdout);
  if (Array.isArray(list)) for (const s of list) await add(s.realPath || s.path || '');
  const agents = await scanAgents();
  for (const a of agents) {
    for (const s of a.skills) await add(s.path);
  }
  // 内置 skill（agent-manager 自带，默认装配到所有 agent）
  for (const s of await scanSkillsInDir(path.join(__dirname, 'skills'))) await add(s.path);
  return [...byReal.values()];
}

// 把所有已下载 skill 以 symlink 铺到每个 agent 的原生 skill 目录
async function syncAllSkills() {
  const sources = await collectAllSkills();
  const agents = await scanAgents();
  const targets = [...new Set(agents.flatMap((a) => a.skillDirs || []))];
  const created = [], skipped = [], errors = [];
  for (const dir of targets) {
    await mkdir(dir, { recursive: true });
    for (const s of sources) {
      const dest = path.join(dir, s.name);
      try {
        const st = await lstat(dest);
        // 失效软链（源被删/移动）视为不存在，删除后重建
        if (!(st.isSymbolicLink() && !(await exists(dest)))) {
          skipped.push(`${s.name} → ${dir} (已存在)`);
          continue;
        }
        await unlink(dest);
      } catch { /* 不存在，继续 */ }
      try {
        await symlink(s.path, dest, 'dir');
        created.push(`${s.name} → ${dir}`);
      } catch (e) {
        errors.push(`${s.name} → ${dir}: ${e.message}`);
      }
    }
  }
  // 清理目标目录里指向不存在源的死链接（卸载/源删除后的残留）
  let cleaned = 0;
  for (const dir of targets) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isSymbolicLink()) continue;
      const dest = path.join(dir, e.name);
      if (!(await exists(dest))) { await unlink(dest).catch(() => {}); cleaned++; }
    }
  }
  return { sources: sources.length, targets: targets.length, created, skipped: skipped.length, cleaned, errors };
}

// ---------- Agent 底层指令注入（AGENTS.md / 全局规则） ----------
// 在各 Agent 的持久指令文件中维护一段受管代码块，运行时始终生效；
// 详细用法仍走 agent-ecosystem skill 按需加载，控制 token 开销。
const ECOSYSTEM_BLOCK = `<!-- agent-ecosystem:begin -->
## 本机 Agent 生态系统
- MCP 统一网关 http://localhost:3000/mcp 已接入并含腾讯文档/ima/lighthouse 等 WorkBuddy MCP：工具直接可用（命名 mcp__mcphub__<服务名>__<工具>），勿重复安装同类 MCP；新装 MCP 会自动同步进网关。
- 网关现有服务清单（名称/状态/工具数）见 ${path.join(DATA_DIR, 'gateway-catalog.md')}，不确定有没有某能力时先读它。
- Skill 已全量同步到你的 skill 目录；缺失时提示用户在 Agent Manager (http://localhost:3100) 点「同步全部 skill」。
- 【重要·先查后做】用户提到其他 Agent、其他项目、某个目录/仓库的来历、之前的方案或结论时，先调 MCP 工具 agent-bridge-conversations_search 按关键词搜全部 Agent 会话，命中再 agent-bridge-conversation_read 细读——不要直接去文件系统猜或从零重做；搜不到再 agent-bridge-memory_search 查共享记忆库。有价值的结论用 agent-bridge-memory_save 沉淀。agent 参数填本 Agent 名即可读自己的历史。没有 MCP 客户端时可直接 curl http://127.0.0.1:3199/search?q=关键词（免鉴权仅本机）：同等接口 /agents /conversations /conversation /memory/search，POST /memory/save 写记忆。
- 长程任务/子 Agent 编排：详见 skill agent-ecosystem；REST API http://localhost:3100/api/orchestrator/*。
涉及其他 Agent 对话、MCP、skill、任务编排时，先查这些能力再动手。
<!-- agent-ecosystem:end -->`;

// agentId -> 持久指令文件候选（按序写入全部存在的；目录不存在则跳过）
const BOOTSTRAP_FILES = {
  codex: [`${HOME}/.codex/AGENTS.md`],
  devin: [`${HOME}/.config/devin/AGENTS.md`, `${HOME}/.config/devin/rules/agent-ecosystem.md`],
  claude: [`${HOME}/.claude/CLAUDE.md`],
  gemini: [`${HOME}/.gemini/GEMINI.md`],
  windsurf: [`${HOME}/.codeium/windsurf/memories/global_rules.md`],
  cursor: [`${HOME}/.cursor/rules/agent-ecosystem.mdc`],
  workbuddy: [`${HOME}/.workbuddy/AGENTS.md`],
  hermes: [`${HOME}/.hermes/AGENTS.md`],
};

async function applyBootstrapToFile(fp) {
  const BEGIN = '<!-- agent-ecosystem:begin -->';
  const END = '<!-- agent-ecosystem:end -->';
  let text = '';
  try { text = await readFile(fp, 'utf8'); } catch { /* 新文件 */ }
  const bi = text.indexOf(BEGIN), ei = text.indexOf(END);
  if (bi !== -1 && ei !== -1 && ei > bi) {
    const next = text.slice(0, bi) + ECOSYSTEM_BLOCK + text.slice(ei + END.length);
    if (next === text) return 'unchanged';
    await writeFileSafe(fp, next);
    return 'updated';
  }
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  const next = text + sep + (text ? '\n' : '') + ECOSYSTEM_BLOCK + '\n';
  await writeFileSafe(fp, next);
  return 'installed';
}

async function writeFileSafe(fp, content) {
  await mkdir(path.dirname(fp), { recursive: true });
  await writeFile(fp, content, 'utf8');
}

async function bootstrapStatus() {
  const out = [];
  for (const [agentId, files] of Object.entries(BOOTSTRAP_FILES)) {
    for (const fp of files) {
      let text = '';
      try { text = await readFile(fp, 'utf8'); } catch { /* 不存在 */ }
      const installed = text.includes('<!-- agent-ecosystem:begin -->');
      out.push({ agent: agentId, file: fp, exists: !!text, installed });
    }
  }
  return out;
}

async function ensureAgentBootstrap() {
  const results = [];
  for (const [agentId, files] of Object.entries(BOOTSTRAP_FILES)) {
    for (const fp of files) {
      // agent 根目录都不存在才跳过（允许创建 memories/ rules/ 等子目录）
      if (!(await exists(path.dirname(fp))) && !(await exists(path.dirname(path.dirname(fp))))) continue;
      try {
        const r = await applyBootstrapToFile(fp);
        if (r !== 'unchanged') results.push(`${agentId}: ${r} ${path.basename(fp)}`);
      } catch (e) { results.push(`${agentId}: FAIL ${path.basename(fp)} ${e.message}`); }
    }
  }
  return results;
}

// 归一化为 MCPHub server config
function toHubConfig(s) {
  if (s.kind === 'http') {
    const cfg = { type: s.transport === 'sse' ? 'sse' : 'streamable-http', url: s.url };
    if (s.headers && Object.keys(s.headers).length) cfg.headers = s.headers;
    return cfg;
  }
  const cfg = { type: 'stdio', command: s.command, args: s.args || [] };
  if (s.env && Object.keys(s.env).length) cfg.env = s.env;
  return cfg;
}

// 把所有 agent 中检测到的 MCP server 批量导入 MCPHub（去重：hub 自身、禁用、同配置）
async function syncAllMcp() {
  const agents = await scanAgents();
  const settings = await hubFetch('GET', '/settings');
  const existing = new Set(Object.keys(settings.data?.mcpServers || settings.data?.data?.mcpServers || {}));
  // 兼容 data 包裹
  const hubNames = new Set([...existing]);
  try {
    const list = await hubFetch('GET', '/servers');
    for (const s of list.data?.data || []) if (s.name) hubNames.add(s.name);
  } catch { /* 忽略 */ }

  const imported = [], skipped = [], failed = [];
  const seenSig = new Set();
  for (const a of agents) {
    for (const s of a.mcpServers || []) {
      const label = `${a.id}/${s.name}`;
      if (s.disabled) { skipped.push(`${label} (已禁用)`); continue; }
      if (/mcphub/i.test(s.name) || (s.url || '').includes(`${HUB_URL}/mcp`)) { skipped.push(`${label} (hub 自身)`); continue; }
      const sig = s.kind === 'http' ? `http:${s.url}` : `stdio:${s.command}|${(s.args || []).join(' ')}`;
      if (seenSig.has(sig)) { skipped.push(`${label} (重复配置)`); continue; }
      seenSig.add(sig);
      const name = `${a.id}-${s.name}`.replace(/[^\w.-]/g, '_');
      if (hubNames.has(name)) { skipped.push(`${label} (网关已存在)`); continue; }
      if (s.kind === 'stdio' && !s.command) { failed.push(`${label}: stdio 缺少 command`); continue; }
      const r = await hubFetch('POST', '/servers', { name, config: toHubConfig(s) });
      if (r.data?.success === false) failed.push(`${label}: ${r.data.message || JSON.stringify(r.data)}`);
      else { imported.push(`${label} → ${name}`); hubNames.add(name); }
    }
  }
  return { imported, skipped, failed };
}

// ---------- Agent 连接自修复 ----------
// 各 Agent 的 mcphub 条目格式（与其原生 MCP 配置 schema 对齐）
function hubEntryFor(a) {
  const url = `${HUB_URL}/mcp`;
  const auth = `Bearer ${HUB_KEY}`;
  switch (a.id) {
    case 'codex': return { kind: 'toml', text: `[mcp_servers.mcphub]\nurl = "${url}"\nhttp_headers = { "Authorization" = "${auth}" }\n` };
    case 'hermes': return { kind: 'yaml' };
    case 'devin': return { kind: 'json', value: { url, transport: 'http', headers: { Authorization: auth } } };
    case 'windsurf': return { kind: 'json', value: { serverUrl: url, headers: { Authorization: auth } } };
    case 'workbuddy': return { kind: 'json', value: { type: 'streamableHttp', url, timeout: 30000, disabled: false, headers: { Authorization: auth } } };
    case 'gemini': return { kind: 'json', value: { httpUrl: url, headers: { Authorization: auth } } };
    case 'cursor': return { kind: 'json', value: { url, headers: { Authorization: auth } } };
    default: return { kind: 'json', value: { type: 'http', url, headers: { Authorization: auth } } };
  }
}

async function repairAgentMcphub(a) {
  const e = hubEntryFor(a);
  const files = (a.mcpFiles || []).filter((f) => f.kind === e.kind || e.kind === 'json');
  if (e.kind === 'json') {
    const jsonFiles = (a.mcpFiles || []).filter((f) => f.kind === 'json');
    let target = null;
    for (const f of jsonFiles) if (await exists(f.path)) { target = f.path; break; }
    if (!target) target = jsonFiles[0]?.path;
    if (!target) return { ok: false, error: '该 Agent 无 JSON MCP 配置文件' };
    const obj = (await readJson(target)) || {};
    obj.mcpServers = obj.mcpServers || {};
    if (obj.mcpServers.mcphub) return { ok: true, note: '已存在 mcphub 配置', path: target };
    obj.mcpServers.mcphub = e.value;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(obj, null, 2) + '\n');
    return { ok: true, note: `已写入 ${target}`, path: target };
  }
  if (e.kind === 'toml') {
    const f = (a.mcpFiles || []).find((x) => x.kind === 'toml');
    if (!f) return { ok: false, error: '无 TOML MCP 配置' };
    const txt = await readFile(f.path, 'utf8').catch(() => '');
    if (/\[mcp_servers\.mcphub\]/.test(txt)) return { ok: true, note: '已存在 mcphub 配置', path: f.path };
    await writeFile(f.path, txt.replace(/\s*$/, '\n\n') + e.text);
    return { ok: true, note: `已追加 ${f.path}`, path: f.path };
  }
  return { ok: false, error: '该 Agent 的 MCP 配置格式暂不支持自动写入，请手动添加 mcphub（见 agent-ecosystem skill）' };
}

// what: 'mcphub' | 'launch'
async function repairAgent(agentId, what) {
  const a = AGENTS.find((x) => x.id === agentId);
  if (!a) return { ok: false, error: '未知 Agent' };
  if (what === 'mcphub') return repairAgentMcphub(a);
  if (what === 'launch') {
    if (!a.app) return { ok: false, error: '该 Agent 无桌面应用可启动' };
    if (!(await exists(a.app))) return { ok: false, error: '应用未安装' };
    const r = await runCmd('/usr/bin/open', [a.app], 10000);
    return r.code === 0 ? { ok: true, note: `已启动 ${a.name}` } : { ok: false, error: r.stderr || '启动失败' };
  }
  return { ok: false, error: '未知修复项' };
}

// ---------- 反向代理 ----------
// 统一入口 /px/<id>/... → 本地 Agent 服务；内置 /px/router → 自动路由器（LLM 统一入口）
const PROXY_FILE = path.join(DATA_DIR, 'proxy.json');

const PROXY_DEFAULTS = [
  { id: 'router', name: '自动路由器', prefix: '/px/router', target: 'http://127.0.0.1:8788', enabled: true, builtin: true, note: 'LLM 入口：Agent 的 OpenAI base URL 填 http://127.0.0.1:3100/px/router/v1 即走自动路由' },
  { id: 'hermes', name: 'Hermes Gateway', prefix: '/px/hermes', target: 'http://127.0.0.1:54900', enabled: true, llmRouter: true },
  { id: 'mcphub', name: 'MCPHub', prefix: '/px/mcphub', target: 'http://127.0.0.1:3000', enabled: true },
  { id: 'ollama', name: 'Ollama', prefix: '/px/ollama', target: 'http://127.0.0.1:11434', enabled: true },
  { id: 'wb-rl', name: 'WorkBuddy·RL项目', prefix: '/px/wb-rl', target: 'http://127.0.0.1:8787', enabled: true },
  { id: 'wb-app', name: 'WorkBuddy App', prefix: '/px/wb-app', target: 'http://127.0.0.1:61213', enabled: false },
];

let proxyEntries = [];
let proxyCache = { t: 0, list: [] };

async function loadProxy() {
  const saved = (await readJson(PROXY_FILE)) || [];
  const map = new Map(Array.isArray(saved) ? saved.filter((e) => e && e.id).map((e) => [e.id, e]) : []);
  for (const d of PROXY_DEFAULTS) if (!map.has(d.id)) map.set(d.id, { ...d });
  proxyEntries = [...map.values()]
    .map((e) => ({ enabled: true, ...e, target: String(e.target || '').replace(/\/$/, '') }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

async function saveProxy() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(PROXY_FILE, JSON.stringify(proxyEntries, null, 2));
  proxyCache.t = 0;
}

function matchProxy(pathname) {
  for (const e of proxyEntries) {
    if (!e.enabled) continue;
    if (pathname === e.prefix || pathname.startsWith(e.prefix + '/')) return e;
  }
  return null;
}

async function probeTarget(target) {
  try {
    await fetch(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(2500) });
    return true; // 拿到任意 HTTP 响应即视为可达
  } catch { return false; }
}

function proxyHttp(req, res, entry) {
  const u = new URL(entry.target);
  const sub = req.url.slice(entry.prefix.length) || '/';
  const mod = u.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: u.host };
  const pr = mod.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: sub, method: req.method, headers, timeout: 300000,
  }, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res); // SSE / chunked 流式透传
  });
  pr.on('timeout', () => pr.destroy(new Error('proxy timeout')));
  pr.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: `代理 ${entry.name} 失败: ${e.message}` });
    else res.destroy();
  });
  req.pipe(pr);
}


// ===== 自动路由：配置管理 / 分类器 / 本地模型 / Agent 接入 =====
const ROUTER_DIR = path.join(HOME, '.hermes', 'router');
const ROUTER_CFG = path.join(ROUTER_DIR, 'config.json');
const APPLY_FILE = path.join(DATA_DIR, 'router-agent-apply.json');
const OLLAMA_BIN = '/opt/homebrew/bin/ollama';
const LOCAL_PULLS = new Map(); // model -> {status, log}

const readRouterConfig = async () => { try { return JSON.parse(await readFile(ROUTER_CFG, 'utf8')); } catch { return null; } };

function maskConfig(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  for (const r of Object.values(out.routes || {})) {
    r.apiKey = '***';
    for (const f of r.fallbacks || []) f.apiKey = '***';
  }
  if (out.classifier && out.classifier.apiKey) out.classifier.apiKey = '***';
  for (const p of Object.values(out.providers || {})) if (p.apiKey) p.apiKey = '***';
  return out;
}

function mergeConfigKeys(incoming, old) {
  for (const [name, r] of Object.entries(incoming.routes || {})) {
    const o = (old.routes || {})[name] || {};
    r.apiKey = (!r.apiKey || r.apiKey === '***') ? o.apiKey : r.apiKey;
    (r.fallbacks || []).forEach((f, i) => { f.apiKey = (!f.apiKey || f.apiKey === '***') ? ((o.fallbacks || [])[i] || {}).apiKey : f.apiKey; });
  }
  if (incoming.classifier && old.classifier) incoming.classifier.apiKey = (!incoming.classifier.apiKey || incoming.classifier.apiKey === '***') ? old.classifier.apiKey : incoming.classifier.apiKey;
  for (const [n, p] of Object.entries(incoming.providers || {})) {
    const o = (old.providers || {})[n];
    if (o) p.apiKey = (!p.apiKey || p.apiKey === '***') ? o.apiKey : p.apiKey;
  }
  return incoming;
}

async function reloadRouter() {
  try {
    const r = await fetch('http://127.0.0.1:8788/admin/reload', { method: 'POST', signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

async function probeModels(baseUrl, apiKey) {
  try {
    const r = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey || ''}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { baseUrl, models: [], error: `HTTP ${r.status}` };
    const j = await r.json();
    return { baseUrl, models: (j.data || []).map(m => m.id).slice(0, 80) };
  } catch (e) { return { baseUrl, models: [], error: String((e && e.message) || e).slice(0, 80) }; }
}

async function pullTail(model) {
  const s = LOCAL_PULLS.get(model);
  if (!s || !s.log) return '';
  try { const t = await readFile(s.log, 'utf8'); return t.slice(-300); } catch { return ''; }
}

const routerMgmtRoutes = [
  ['GET', /^\/api\/router\/config$/, async (req, res) => {
    const c = await readRouterConfig();
    if (!c) return json(res, 500, { error: 'router config not found' });
    return json(res, 200, { config: maskConfig(c) });
  }],
  ['PUT', /^\/api\/router\/config$/, async (req, res, body) => {
    let incoming = body;
    if (!incoming || typeof incoming.routes !== 'object' || !Object.keys(incoming.routes).length) return json(res, 400, { error: 'routes 不能为空' });
    for (const [n, r] of Object.entries(incoming.routes)) {
      if (!r || typeof r.model !== 'string' || !r.model.trim()) return json(res, 400, { error: `路由 ${n} 缺少 model` });
      r.fallbacks = Array.isArray(r.fallbacks) ? r.fallbacks.filter(f => f && f.model) : [];
    }
    const old = (await readRouterConfig()) || {};
    incoming = mergeConfigKeys(incoming, old);
    await mkdir(ROUTER_DIR, { recursive: true });
    await writeFile(ROUTER_CFG + '.bak-' + Date.now(), JSON.stringify(old, null, 2));
    await writeFile(ROUTER_CFG, JSON.stringify(incoming, null, 2));
    let reloaded = await reloadRouter();
    if (!reloaded) { try { execFile('/bin/launchctl', ['kickstart', '-k', 'gui/501/ai.hermes.router']); } catch {} }
    return json(res, 200, { ok: true, reloaded });
  }],
  ['GET', /^\/api\/router\/classifier\/models$/, async (req, res) => {
    const c = await readRouterConfig();
    if (!c) return json(res, 200, { providers: [] });
    const seen = new Map();
    const add = (u, k) => { if (u && !seen.has(u)) seen.set(u, k || ''); };
    for (const r of Object.values(c.routes || {})) { add(r.baseUrl, r.apiKey); for (const f of r.fallbacks || []) add(f.baseUrl, f.apiKey); }
    const cc = c.classifier || {}; add(cc.baseUrl, cc.apiKey);
    const providers = await Promise.all([...seen.entries()].slice(0, 8).map(([u, k]) => probeModels(u, k)));
    return json(res, 200, { providers });
  }],
  ['GET', /^\/api\/router\/local-models$/, async (req, res) => {
    const pulls = {};
    for (const [m] of LOCAL_PULLS) pulls[m] = { status: LOCAL_PULLS.get(m).status, tail: await pullTail(m) };
    try {
      const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      return json(res, 200, { models: (j.models || []).map(m => m.name), pulls });
    } catch { return json(res, 200, { models: [], pulls, error: 'ollama offline' }); }
  }],
  ['POST', /^\/api\/router\/local-models\/pull$/, async (req, res, body) => {
    body = body || {};
    const model = String(body.model || '').trim();
    if (!/^[a-zA-Z0-9._:-]{2,80}$/.test(model)) return json(res, 400, { error: 'invalid model name' });
    if (LOCAL_PULLS.has(model)) return json(res, 200, { ok: true, status: LOCAL_PULLS.get(model).status });
    const safe = model.replace(/[^a-zA-Z0-9._-]/g, '_');
    const log = path.join(DATA_DIR, `ollama-pull-${safe}.log`);
    LOCAL_PULLS.set(model, { status: 'pulling', log });
    const { openSync, closeSync, writeSync } = await import('node:fs');
    const fd = openSync(log, 'a');
    writeSync(fd, `\n=== pull ${model} @ ${new Date().toISOString()} ===\n`);
    const child = spawn(OLLAMA_BIN, ['pull', model], { stdio: ['ignore', fd, fd] });
    child.on('close', (code) => { const s = LOCAL_PULLS.get(model); if (s) { s.status = code === 0 ? 'done' : 'error'; s.code = code; } closeSync(fd); });
    child.on('error', (e) => { const s = LOCAL_PULLS.get(model); if (s) { s.status = 'error'; s.error = String(e.message); } closeSync(fd); });
    return json(res, 200, { ok: true, status: 'pulling' });
  }],
  ['GET', /^\/api\/router\/model-usage$/, async (req, res) => {
    try {
      const log = await readFile(path.join(ROUTER_DIR, 'router.log'), 'utf8');
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = Date.now() - 7 * 86400000;
      const agg = new Map();
      for (const line of log.split('\n')) {
        const m = line.match(/^\[router\] (\S+) route=(\S+) model=(\S+)(?: host=(\S+))?(?: stick=1)? (ok|FAIL)/);
        if (!m) continue;
        const t = Date.parse(m[1]);
        if (isNaN(t) || t < weekAgo) continue;
        const host = m[4] || '';
        const key = m[2] + '|' + m[3] + '|' + host;
        let a = agg.get(key);
        if (!a) { a = { route: m[2], model: m[3], host, count: 0, fails: 0, today: 0 }; agg.set(key, a); }
        a.count++;
        if (m[5] === 'FAIL') a.fails++;
        if (m[1].slice(0, 10) === today) a.today++;
      }
      const items = [...agg.values()].sort((a, b) => b.count - a.count);
      return json(res, 200, { items, today });
    } catch (e) {
      return json(res, 200, { items: [], today: '', error: String((e && e.message) || e).slice(0, 120) });
    }
  }],
  ['GET', /^\/api\/router\/agent-apply$/, async (req, res) => {
    const f = (await readJson(APPLY_FILE)) || { enabled: true };
    return json(res, 200, { enabled: !!f.enabled });
  }],
  ['PUT', /^\/api\/router\/agent-apply$/, async (req, res, body) => {
    body = body || {};
    const enabled = !!body.enabled;
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(APPLY_FILE, JSON.stringify({ enabled }));
    return json(res, 200, { ok: true, enabled });
  }],
  ['GET', /^\/api\/router\/agents$/, async (req, res) => {
    const agents = [];
    try {
      const y = await readFile(path.join(HOME, '.hermes', 'config.yaml'), 'utf8');
      const def = (y.match(/^\s*default:\s*(\S+)/m) || [])[1] || '';
      const prov = (y.match(/^\s*provider:\s*(\S+)/m) || [])[1] || '';
      const base = (y.match(/base_url:\s*(\S+)/) || [])[1] || '';
      agents.push({ id: 'hermes', name: 'Hermes 桌面端', applied: def === 'auto' && base.includes(':8788'), detail: `model=${def} provider=${prov} → ${base}` });
    } catch { agents.push({ id: 'hermes', name: 'Hermes 桌面端', applied: false, error: 'config.yaml 未找到' }); }
    for (const [id, name] of [['workbuddy', 'WorkBuddy'], ['devin', 'Devin CLI'], ['codex', 'Codex CLI']]) agents.push({ id, name, applied: false, manual: true, hint: '手动将其 LLM Base URL 指向自动路由入口' });
    return json(res, 200, { agents, proxyUrl: 'http://127.0.0.1:3100/px/router/v1', directUrl: 'http://127.0.0.1:8788/v1' });
  }],
  ['POST', /^\/api\/router\/agents\/apply$/, async (req, res, body) => {
    body = body || {};
    if (body.agent !== 'hermes') return json(res, 400, { error: '该 Agent 需手动接入' });
    const f = (await readJson(APPLY_FILE)) || { enabled: true };
    if (!f.enabled) return json(res, 403, { error: '一键接入开关已关闭' });
    const cfgPath = path.join(HOME, '.hermes', 'config.yaml');
    let y = '';
    try { y = await readFile(cfgPath, 'utf8'); } catch { return json(res, 500, { error: 'config.yaml 未找到' }); }
    const applied = /base_url:\s*http:\/\/127\.0\.0\.1:8788\/v1/.test(y) && /^\s*default:\s*auto$/m.test(y);
    if (applied) return json(res, 200, { ok: true, already: true });
    const ENTRY = '  - name: hermes-auto\n    base_url: http://127.0.0.1:8788/v1\n    api_key: hermes-local-router\n    model: auto\n    context_length: 131072\n    models:\n      auto: {}\n      simple: {}\n      coding: {}\n      complex: {}\n      expert: {}\n    models_discovered: true\n';
    let next = y;
    if (/custom_providers:/.test(next)) {
      if (!/hermes-auto/.test(next)) next = next.replace(/(custom_providers:\s*\n)/, '$1' + ENTRY);
    } else {
      next += '\ncustom_providers:\n' + ENTRY;
    }
    if (/^model:\n  default: \S+\n  provider: \S+/m.test(next)) next = next.replace(/^model:\n  default: \S+\n  provider: \S+/m, 'model:\n  default: auto\n  provider: hermes-auto');
    else if (/^model:\n  default: \S+/m.test(next)) next = next.replace(/^model:\n  default: \S+/m, 'model:\n  default: auto\n  provider: hermes-auto');
    else next = 'model:\n  default: auto\n  provider: hermes-auto\n' + next;
    await writeFile(cfgPath + '.bak-apply-' + Date.now(), y);
    await writeFile(cfgPath, next);
    return json(res, 200, { ok: true, note: '已写入 Hermes 配置，重启 Hermes 桌面端后生效' });
  }],
];

// ---------- Skill 市场：必备 + 按使用习惯推荐 ----------
const SH_CACHE = new Map(); // `${q}|${limit}` -> { at, skills }
const SH_TTL = 10 * 60 * 1000;
const normSkillKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');

async function shSearch(q, limit = 5) {
  const key = `${q}|${limit}`;
  const hit = SH_CACHE.get(key);
  if (hit && Date.now() - hit.at < SH_TTL) return hit.skills;
  try {
    const r = await fetch(`${SKILLS_SH}?q=${encodeURIComponent(q)}&limit=${limit}`, { signal: AbortSignal.timeout(15000) });
    const data = await r.json();
    const skills = (data.skills || []).map((s) => ({
      name: s.name || s.skillId,
      skillId: s.skillId,
      source: s.source || '',
      installs: s.installs ?? null,
      installCommand: `asm install github:${s.source}:skills/${s.skillId}`,
    }));
    SH_CACHE.set(key, { at: Date.now(), skills });
    return skills;
  } catch { return []; }
}

// 必备位：通用基础能力，固定查询各取热度最高者
const ESSENTIAL_QUERIES = [
  { q: 'code review', label: '代码评审' },
  { q: 'git commit', label: 'Git 提交规范' },
  { q: 'xlsx', label: 'Excel 表格处理' },
  { q: 'skill creator', label: '自制 Skill' },
  { q: 'agent browser', label: '浏览器自动化' },
  { q: 'webapp testing', label: '前端自动化测试' },
];

// 习惯信号（已装 skill 名 / 网关服务名 / 应用）→ 更贴切的社区查询词
const HABIT_QUERIES = [
  [/lark|feishu/i, 'lark doc', '你在用飞书/Lark'],
  [/obsidian/i, 'obsidian cli', '你在用 Obsidian'],
  [/ima/i, 'note taking', '你在用 ima 笔记'],
  [/excel|xlsx|sheet/i, 'xlsx', '你在用 Excel'],
  [/pdf|docx|document|office|pptx|presentation/i, 'docx', '你在处理 Office 文档'],
  [/mail|email|qq/i, 'email', '你在用邮箱'],
  [/light|cloud|server|devops|ops/i, 'devops', '你在管理云资源'],
  [/node|code|dev|program|git/i, 'tdd', '你在做软件开发'],
  [/blender|3d|design|frontend|ui/i, 'frontend design', '你在做设计/前端'],
];

async function collectInstalledSkillNames() {
  const names = new Set();
  try {
    const agents = await scanAgents();
    for (const a of agents) for (const s of a.skills || []) names.add(s.name);
  } catch { /* 扫描失败不阻塞市场 */ }
  const r = await asmRun(['list', '--json', '-s', 'both']);
  const list = tryJson(r.stdout);
  if (Array.isArray(list)) for (const s of list) names.add(s.name);
  return names;
}

async function skillMarket() {
  const installedNames = await collectInstalledSkillNames();
  const isInstalled = (s) => installedNames.has(s.name) || installedNames.has(s.skillId)
    || [...installedNames].some((n) => normSkillKey(n) === normSkillKey(s.name) || normSkillKey(n) === normSkillKey(s.skillId));

  // ---- 必备 ----
  const essentialHits = await Promise.all(ESSENTIAL_QUERIES.map(async (e) => ({ e, hits: await shSearch(e.q, 3) })));
  const essential = essentialHits.filter((x) => x.hits[0])
    .map((x) => ({ ...x.hits[0], reason: x.e.label, _score: Math.log10((x.hits[0].installs || 0) + 1) }));
  essential.sort((a, b) => b._score - a._score);

  // ---- 推荐：已装 skill + 网关服务名直接作为查询词，再叠加习惯映射 ----
  const queries = []; // {q, reason}
  const seenQ = new Set();
  const pushQ = (q, reason) => {
    const k = normSkillKey(q);
    if (k && !seenQ.has(k) && queries.length < 14) { seenQ.add(k); queries.push({ q, reason }); }
  };
  const agents = await scanAgents().catch(() => []);
  for (const a of agents) for (const s of (a.skills || []).slice(0, 40)) pushQ(s.name, `你已在用「${s.name}」`);
  let gwNames = [];
  try {
    const g = await hubFetch('GET', '/servers');
    const arr = Array.isArray(g.data) ? g.data : (g.data?.data || g.data?.servers || []);
    gwNames = arr.map((s) => s.name).filter(Boolean);
  } catch { /* 网关不可用时只按 skill 推荐 */ }
  for (const n of gwNames) {
    const clean = String(n).replace(/^workbuddy[-_]/i, '').replace(/[-_]+/g, ' ').trim();
    pushQ(clean, `网关已接入「${n}」`);
  }
  const hay = [...installedNames, ...gwNames].join(' ');
  for (const [re, q, reason] of HABIT_QUERIES) if (re.test(hay)) pushQ(q, reason);

  const fetched = await Promise.all(queries.map(async ({ q, reason }) =>
    (await shSearch(q, 4)).map((s) => ({ ...s, reason, _score: Math.log10((s.installs || 0) + 1) }))));
  const recMap = new Map();
  for (const arr of fetched) for (const s of arr) {
    const key = `${s.source}/${s.skillId}`;
    const cur = recMap.get(key);
    if (!cur) recMap.set(key, { ...s, reasons: [s.reason] });
    else { cur.reasons.push(s.reason); if (s._score > cur._score) { cur._score = s._score; Object.assign(cur, s, { reasons: cur.reasons }); } }
  }
  const essentialKeys = new Set(essential.map((s) => `${s.source}/${s.skillId}`));
  const recommended = [...recMap.values()]
    .filter((s) => !essentialKeys.has(`${s.source}/${s.skillId}`))
    .filter((s) => !isInstalled(s))
    .sort((a, b) => b._score - a._score)
    .slice(0, 10)
    .map((s) => ({ ...s, reason: s.reasons.join('、') }));

  const pub = (s) => ({ name: s.name, skillId: s.skillId, source: s.source, installs: s.installs, installCommand: s.installCommand, reason: s.reason, installed: isInstalled(s) });
  return { essential: essential.map(pub), recommended: recommended.map(pub), signals: { skills: installedNames.size, servers: gwNames.length } };
}

// 市场结果缓存：页面懒加载 + 服务启动预热，避免每次点进 tab 都重新拉社区数据
const MCP_MKT_TTL = 10 * 60 * 1000;
const MCP_MKT_CACHE = new Map(); // `${q}|${limit}` -> { at, data }
const SKILL_MKT_TTL = 10 * 60 * 1000;
let skillMktCache = { at: 0, data: null };

async function mcpMarketFetch(q, limit) {
  const u = new URL(`${MCP_REGISTRY}/v0.1/servers`);
  u.searchParams.set('limit', String(limit));
  if (q.length >= 3) u.searchParams.set('search', q); // 官方要求搜索词≥3字符
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Registry HTTP ${r.status}`);
  const data = await r.json();
  // 同名多版本去重，保留最新（_meta isLatest 优先，否则取版本号最大）
  const byName = new Map();
  const newer = (a, b) => String(a.version || '').localeCompare(String(b.version || ''), undefined, { numeric: true }) > 0;
  for (const item of data.servers || []) {
    const s = item.server || {};
    if (!s.name) continue;
    const cur = byName.get(s.name);
    const isLatest = item._meta?.['io.modelcontextprotocol.registry/official']?.isLatest;
    if (!cur || isLatest || (!cur._latest && newer(s, cur))) byName.set(s.name, { ...s, _latest: isLatest });
  }
  const results = [...byName.values()].map((s) => {
    const remote = (s.remotes || []).find((r) => r.type === 'streamable-http') || (s.remotes || [])[0];
    const pkg = (s.packages || [])[0];
    const envRequired = (pkg?.environmentVariables || []).filter((e) => e.isRequired).map((e) => e.name);
    return {
      name: s.name, title: s.title || s.name, description: s.description || '',
      version: s.version || '', homepage: s.websiteUrl || s.repository?.url || '',
      installable: !!(remote?.url || pkg),
      via: remote?.url ? 'remote' : pkg ? `${pkg.registryType || pkg.runtimeHint || 'stdio'}` : 'unknown',
      envRequired,
      _raw: { remotes: s.remotes || [], packages: (s.packages || []).slice(0, 2) },
    };
  });
  return { results, total: results.length };
}

async function skillMarketCached() {
  if (skillMktCache.data && Date.now() - skillMktCache.at < SKILL_MKT_TTL) return skillMktCache.data;
  const data = await skillMarket();
  skillMktCache = { at: Date.now(), data };
  return data;
}

const routes = [...routerMgmtRoutes,
  // ---- 本地服务代理（/px/<id>/ → target） ----
  ['GET', /^\/api\/proxy\/list$/, async (req, res) => {
    const base = `http://localhost:${PORT}`;
    const list = await Promise.all(proxyEntries.map(async (e) => ({
      id: e.id, name: e.name, prefix: e.prefix, target: e.target,
      url: `${base}${e.prefix}`, llmUrl: e.id === 'router' ? `${base}${e.prefix}/v1` : undefined,
      enabled: !!e.enabled, builtin: !!e.builtin, llmRouter: !!e.llmRouter, note: e.note || '',
      ok: e.enabled ? await probeTarget(e.target) : null,
    })));
    json(res, 200, { entries: list });
  }],
  ['GET', /^\/api\/proxy\/scan$/, async (req, res) => {
    // 扫描本机 TCP 监听端口（lsof），供一键添加为代理
    const { stdout } = await new Promise((resolve) => {
      execFile('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (e, so) => resolve({ stdout: so || '' }));
    });
    const seen = new Map();
    for (const line of stdout.split('\n')) {
      // 末列形如 "TCP *:49756 (LISTEN)" 或 "TCP 127.0.0.1:4709 (LISTEN)"
      const m = line.match(/^(.+?)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+TCP\s+\S+:(\d+)\s+\(LISTEN\)/);
      if (!m) continue;
      const [, proc, pid, port] = m;
      const p = Number(port);
      if (!p || p === PORT || seen.has(p)) continue;
      seen.set(p, { port: p, proc: proc.trim(), pid: Number(pid) });
    }
    json(res, 200, { ports: [...seen.values()].sort((a, b) => a.port - b.port) });
  }],
  ['POST', /^\/api\/proxy\/(add|update)$/, async (req, res, body, m) => {
    const { id, name, prefix, target, llmRouter, note, enabled } = body || {};
    if (!name || !prefix || !target) return json(res, 400, { error: '名称/前缀/目标必填' });
    const p = String(prefix).trim();
    if (!p.startsWith('/px/')) return json(res, 400, { error: '前缀必须以 /px/ 开头' });
    const tgt = String(target).trim().replace(/\/$/, '');
    const entryId = id || `${String(name).toLowerCase().replace(/[^\w-]/g, '-').replace(/^-+|-+$/g, '') || 'svc'}-${Date.now().toString(36)}`;
    const ex = proxyEntries.find((e) => e.id === entryId || e.prefix === p);
    if (m[1] === 'add' && ex) return json(res, 400, { error: `已存在: ${ex.id}` });
    const fields = { name: String(name).trim(), prefix: p, target: tgt, llmRouter: !!llmRouter, note: note || '', enabled: enabled !== false };
    if (ex) Object.assign(ex, fields);
    else proxyEntries.push({ id: entryId, ...fields });
    proxyEntries.sort((a, b) => b.prefix.length - a.prefix.length);
    await saveProxy();
    json(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/proxy\/toggle$/, async (req, res, body) => {
    const e = proxyEntries.find((x) => x.id === body?.id);
    if (!e) return json(res, 404, { error: 'not found' });
    e.enabled = body.enabled !== undefined ? !!body.enabled : !e.enabled;
    await saveProxy();
    json(res, 200, { ok: true, enabled: e.enabled });
  }],
  ['POST', /^\/api\/proxy\/delete$/, async (req, res, body) => {
    const i = proxyEntries.findIndex((x) => x.id === body?.id);
    if (i === -1) return json(res, 404, { error: 'not found' });
    if (proxyEntries[i].builtin) return json(res, 400, { error: '内置条目不可删除，可停用' });
    proxyEntries.splice(i, 1);
    await saveProxy();
    json(res, 200, { ok: true });
  }],

  ['POST', /^\/api\/mcp\/sync-all$/, async (req, res) => {
    json(res, 200, await syncAllMcp());
  }],
  // ---- 总览 ----
  ['GET', /^\/api\/overview$/, async (req, res) => {
    const [health, servers, skillsR] = await Promise.all([
      fetch(`${HUB_URL}/health`).then((r) => r.ok).catch(() => false),
      hubFetch('GET', '/servers'),
      asmRun(['list', '--json', '-s', 'both']),
    ]);
    const skills = tryJson(skillsR.stdout);
    json(res, 200, {
      hub: health,
      mcpServers: Array.isArray(servers.data?.data) ? servers.data.data.length : 0,
      skills: Array.isArray(skills) ? skills.length : 0,
    });
  }],

  // ---- Agent 扫描 ----
  ['GET', /^\/api\/agents$/, async (req, res) => {
    const agents = await scanAgents();
    // 网关健康 + 各 MCP 服务连接状态，供体检页展示
    let gateway = { ok: false, endpoint: `${HUB_URL}/mcp`, connected: 0, total: 0, servers: [] };
    try {
      const r = await hubFetch('GET', '/servers');
      const list = r.data?.data || r.data || [];
      const servers = (Array.isArray(list) ? list : []).map((s) => ({
        name: s.name, status: s.status || (s.enabled === false ? 'disabled' : 'unknown'),
      }));
      gateway = {
        ok: true,
        connected: servers.filter((s) => /connect|ready/i.test(s.status)).length,
        total: servers.length,
        servers,
      };
    } catch { /* hubFetch 不抛，但防御一下 */ }
    json(res, 200, { agents, gateway });
  }],
  ['POST', /^\/api\/agents\/import-mcp$/, async (req, res, body) => {
    const { agentId, serverName } = body || {};
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) return json(res, 400, { error: '未知 agent' });
    // 重新扫描该 agent 拿到目标 server
    const scanned = (await scanAgents()).find((a) => a.id === agentId);
    const srv = scanned?.mcpServers.find((s) => s.name === serverName);
    if (!srv) return json(res, 404, { error: `未找到 server: ${serverName}` });
    if (srv.kind === 'stdio' && !srv.command) return json(res, 400, { error: 'stdio 服务缺少 command' });
    const r = await hubFetch('POST', '/servers', { name: `${agentId}-${serverName}`.replace(/[^\w.-]/g, '_'), config: toHubConfig(srv) });
    json(res, r.status, r.data);
  }],
  ['POST', /^\/api\/agents\/([^/]+)\/repair$/, async (req, res, body, m) => {
    const r = await repairAgent(m[1], body?.what);
    json(res, r.ok ? 200 : 400, r);
  }],

  // ---- MCPHub 代理 ----
  ['GET', /^\/api\/mcp\/servers$/, async (req, res) => {
    const r = await hubFetch('GET', '/servers');
    json(res, r.status, r.data);
  }],
  ['POST', /^\/api\/mcp\/servers$/, async (req, res, body) => {
    const r = await hubFetch('POST', '/servers', body);
    json(res, r.status, r.data);
  }],
  ['PUT', /^\/api\/mcp\/servers\/([^/]+)$/, async (req, res, body, m) => {
    const r = await hubFetch('PUT', `/servers/${encodeURIComponent(m[1])}`, body);
    json(res, r.status, r.data);
  }],
  ['DELETE', /^\/api\/mcp\/servers\/([^/]+)$/, async (req, res, body, m) => {
    const r = await hubFetch('DELETE', `/servers/${encodeURIComponent(m[1])}`);
    json(res, r.status, r.data);
  }],
  ['POST', /^\/api\/mcp\/servers\/([^/]+)\/toggle$/, async (req, res, body, m) => {
    const r = await hubFetch('POST', `/servers/${encodeURIComponent(m[1])}/toggle`, body);
    json(res, r.status, r.data);
  }],
  ['POST', /^\/api\/mcp\/servers\/([^/]+)\/reload$/, async (req, res, body, m) => {
    const r = await hubFetch('POST', `/servers/${encodeURIComponent(m[1])}/reload`, {});
    json(res, r.status, r.data);
  }],
  ['GET', /^\/api\/mcp\/keys$/, async (req, res) => {
    const r = await hubFetch('GET', '/keys');
    json(res, r.status, r.data);
  }],
  ['GET', /^\/api\/mcp\/settings$/, async (req, res) => {
    const r = await hubFetch('GET', '/settings');
    json(res, r.status, r.data);
  }],
  ['GET', /^\/api\/mcp\/health$/, async (req, res) => {
    try {
      const r = await fetch(`${HUB_URL}/health`);
      json(res, 200, { ok: r.ok, status: r.status });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e) });
    }
  }],

  // ---- Hermes 自动路由（~/.hermes/router + watchdog 数据） ----
  ['GET', /^\/api\/router\/status$/, async (req, res) => {
    const dir = process.env.ROUTER_DIR || `${HOME}/.hermes/router`;
    const cfg = (await readJson(path.join(dir, 'config.json'))) || {};
    const [routerOk, ollamaOk] = await Promise.all([
      fetch(`${cfg.port ? `http://127.0.0.1:${cfg.port}` : 'http://127.0.0.1:8788'}/healthz`, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false),
      fetch(`${cfg.ollamaUrl || 'http://127.0.0.1:11434'}/api/tags`, { signal: AbortSignal.timeout(2500) }).then((r) => r.ok).catch(() => false),
    ]);
    const routes = {};
    for (const [name, r] of Object.entries(cfg.routes || {})) {
      const host = (() => { try { return new URL(r.baseUrl).host; } catch { return r.baseUrl || ''; } })();
      routes[name] = { model: r.model, fallbacks: (r.fallbacks || []).map((f) => f.model), host };
    }
    json(res, 200, { routerOk, ollamaOk, classifier: cfg.classifierModel || '', routes });
  }],
  ['GET', /^\/api\/router\/stats$/, async (req, res) => {
    const dir = process.env.ROUTER_DIR || `${HOME}/.hermes/router`;
    const logPath = path.join(dir, 'router.log');
    let lines = [];
    try { lines = (await readFile(logPath, 'utf8')).trim().split('\n'); } catch { /* 无日志 */ }
    const today = new Date().toISOString().slice(0, 10);
    const dayLines = lines.filter((l) => l.includes(today));
    const counts = {}, tail = dayLines.slice(-40);
    let fails = 0, stick = 0;
    for (const l of dayLines) {
      const m = l.match(/route=(\w+)/);
      if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
      if (/ FAIL /.test(l)) fails++;
      if (/ stick=1 /.test(l)) stick++;
    }
    json(res, 200, { date: today, total: dayLines.length, counts, fails, stick, tail });
  }],
  ['GET', /^\/api\/router\/trend$/, async (req, res) => {
    const dir = process.env.ROUTER_DIR || `${HOME}/.hermes/router`;
    const logPath = path.join(dir, 'router.log');
    let lines = [];
    try { lines = (await readFile(logPath, 'utf8')).trim().split('\n'); } catch { /* 无日志 */ }
    const days = {};
    for (const l of lines) {
      const dm = l.match(/\[router\] (\d{4}-\d{2}-\d{2})T/);
      if (!dm) continue;
      const d = dm[1];
      if (!days[d]) days[d] = { date: d, total: 0, fails: 0, counts: {} };
      const day = days[d];
      day.total++;
      const rm = l.match(/route=(\w+)/);
      if (rm) day.counts[rm[1]] = (day.counts[rm[1]] || 0) + 1;
      if (/ FAIL /.test(l)) day.fails++;
    }
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push(days[d] || { date: d, total: 0, fails: 0, counts: {} });
    }
    json(res, 200, { days: out, routes: ['simple', 'coding', 'complex', 'expert'] });
  }],
  ['GET', /^\/api\/router\/balance$/, async (req, res) => {
    const wd = process.env.WATCHDOG_DIR || `${HOME}/.hermes/watchdog`;
    const script = path.join(wd, 'balance_check.py');
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile('/usr/bin/python3', [script], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (e, so) => e ? reject(e) : resolve({ stdout: so }));
      });
      json(res, 200, JSON.parse(stdout));
    } catch (e) {
      json(res, 200, { error: `balance_check 失败: ${e.message}` });
    }
  }],
  ['GET', /^\/api\/router\/digests$/, async (req, res) => {
    const wd = process.env.WATCHDOG_DIR || `${HOME}/.hermes/watchdog`;
    try {
      const files = (await readdir(wd)).filter((f) => /^digest-\d{8}\.md$/.test(f)).sort().reverse();
      const digests = [];
      for (const f of files.slice(0, 14)) {
        const st = await stat(path.join(wd, f));
        digests.push({ name: f.replace(/^digest-|\.md$/g, ''), file: f, mtime: st.mtime.toISOString() });
      }
      json(res, 200, { digests });
    } catch { json(res, 200, { digests: [] }); }
  }],
  ['GET', /^\/api\/router\/digest$/, async (req, res, body, m, url) => {
    const name = String(url.searchParams.get('name') || '');
    if (!/^\d{8}$/.test(name)) return json(res, 400, { error: '非法 name' });
    const wd = process.env.WATCHDOG_DIR || `${HOME}/.hermes/watchdog`;
    try {
      const content = await readFile(path.join(wd, `digest-${name}.md`), 'utf8');
      json(res, 200, { name, content });
    } catch { json(res, 404, { error: '日报不存在' }); }
  }],
  ['POST', /^\/api\/router\/restart$/, async (req, res) => {
    // 路由器由 launchd 服务 ai.hermes.router 托管，kickstart 即可优雅重启
    execFile('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.hermes.router`], { timeout: 10000 }, (e) => {
      json(res, e ? 500 : 200, e ? { ok: false, error: String(e.message || e) } : { ok: true });
    });
  }],

  // ---- 生态系统底层注入状态 ----
  ['GET', /^\/api\/ecosystem\/bootstrap$/, async (req, res) => {
    json(res, 200, { entries: await bootstrapStatus() });
  }],
  ['POST', /^\/api\/ecosystem\/bootstrap$/, async (req, res) => {
    json(res, 200, { results: await ensureAgentBootstrap(), entries: await bootstrapStatus() });
  }],

  // ---- MCP 市场（官方 Registry） ----
  ['GET', /^\/api\/mcp-market$/, async (req, res, body, m, url) => {
    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
    const key = `${q}|${limit}`;
    const hit = MCP_MKT_CACHE.get(key);
    if (hit && Date.now() - hit.at < MCP_MKT_TTL) return json(res, 200, hit.data);
    try {
      const data = await mcpMarketFetch(q, limit);
      MCP_MKT_CACHE.set(key, { at: Date.now(), data });
      if (MCP_MKT_CACHE.size > 50) MCP_MKT_CACHE.delete(MCP_MKT_CACHE.keys().next().value);
      json(res, 200, data);
    } catch (e) {
      json(res, 502, { error: String(e), results: [] });
    }
  }],
  ['POST', /^\/api\/mcp-market\/install$/, async (req, res, body) => {
    const { raw, name } = body || {};
    const remotes = raw?.remotes || [];
    const packages = raw?.packages || [];
    let config = null;
    const remote = remotes.find((r) => r.type === 'streamable-http') || remotes.find((r) => /sse|http/i.test(r.type || ''));
    if (remote?.url) {
      config = { type: remote.type === 'sse' ? 'sse' : 'streamable-http', url: remote.url };
    } else {
      const pkg = packages.find((p) => ['npm', 'pypi'].includes(p.registryType)) || packages[0];
      if (pkg) {
        const hint = String(pkg.runtimeHint || (pkg.registryType === 'pypi' ? 'uvx' : 'npx')).toLowerCase();
        const cmd = hint.includes('uvx') || hint.includes('pip') || hint === 'python' ? 'uvx' : 'npx';
        const args = [...(pkg.runtimeArguments || []).map((a) => a.value), `${pkg.identifier || name}${pkg.version ? '@' + pkg.version : ''}`];
        config = { type: 'stdio', command: cmd, args };
      }
    }
    if (!config) return json(res, 400, { error: '该条目没有可安装的 remote/package 信息' });
    const safeName = String(name || 'mcp-market').replace(/[^\w.-]/g, '_').slice(0, 60);
    const r = await hubFetch('POST', '/servers', { name: safeName, config });
    json(res, r.status, r.data);
  }],

  // ---- Skills (asm) ----
  ['GET', /^\/api\/skills$/, async (req, res) => {
    const r = await asmRun(['list', '--json', '-s', 'both']);
    const data = tryJson(r.stdout);
    if (data) return json(res, 200, { skills: data });
    json(res, 500, { error: 'asm list 解析失败', stdout: r.stdout, stderr: r.stderr });
  }],
  ['GET', /^\/api\/skills\/local$/, async (req, res) => {
    // 本机各 agent 目录下的 skill（含 asm 未接管的，如 WorkBuddy）
    const agents = await scanAgents();
    const out = [];
    for (const a of agents) for (const s of a.skills) out.push({ ...s, agent: a.id, agentName: a.name });
    json(res, 200, { skills: out });
  }],
  ['GET', /^\/api\/skills\/search$/, async (req, res, body, m, url) => {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return json(res, 200, { results: [] });
    const r = await asmRun(['search', q, '--json'], 90000);
    const data = tryJson(r.stdout);
    if (Array.isArray(data)) return json(res, 200, { results: data });
    json(res, 200, { results: [], raw: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 500) });
  }],
  ['GET', /^\/api\/skills\/market$/, async (req, res) => {
    try { json(res, 200, await skillMarketCached()); }
    catch (e) { json(res, 500, { error: String(e), essential: [], recommended: [] }); }
  }],
  ['GET', /^\/api\/skills\/search-sh$/, async (req, res, body, m, url) => {
    const q = url.searchParams.get('q') || '';
    if (!q.trim()) return json(res, 200, { results: [] });
    try {
      const r = await fetch(`${SKILLS_SH}?q=${encodeURIComponent(q)}&limit=20`, { signal: AbortSignal.timeout(20000) });
      const data = await r.json();
      json(res, 200, { results: (data.skills || []).map((s) => ({
        name: s.name || s.skillId,
        description: s.description || '',
        version: '',
        repo: s.source || '',
        installs: s.installs ?? null,
        status: 'available',
        installCommand: `asm install github:${s.source}:skills/${s.skillId}`,
        shId: s.id,
      })) });
    } catch (e) {
      json(res, 502, { error: String(e), results: [] });
    }
  }],
  ['GET', /^\/api\/skills\/inspect$/, async (req, res, body, m, url) => {
    const name = url.searchParams.get('name') || '';
    if (!name) return json(res, 400, { error: '缺少 name' });
    const r = await asmRun(['inspect', name, '--json']);
    const data = tryJson(r.stdout);
    json(res, data ? 200 : 500, data || { error: 'inspect 失败', stdout: r.stdout, stderr: r.stderr });
  }],
  ['POST', /^\/api\/skills\/install$/, async (req, res, body) => {
    let { source, tool = 'all', scope = 'global' } = body || {};
    if (!source) return json(res, 400, { error: '缺少 source' });
    source = String(source).trim().replace(/^asm\s+install\s+/i, '');
    const args = ['install', source, '-s', scope, '-p', tool, '-y', '--json'];
    const { r } = await asmInstallWithPathFix(source, args);
    const data = tryJson(r.stdout);
    // 安装成功后自动同步到所有 Agent skill 目录
    const synced = r.code === 0 ? await syncAllSkills() : null;
    json(res, r.code === 0 ? 200 : 500, { code: r.code, result: data, synced, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
  }],
  ['POST', /^\/api\/skills\/quick-install$/, async (req, res, body) => {
    // 市场一键安装：global scope + 全部 provider + 自动同步；
    // github.com git 端点不可达时跳过 asm 的 60s clone 超时，直接 tarball 直装。
    let { source } = body || {};
    if (!source) return json(res, 400, { error: '缺少 source' });
    source = String(source).trim().replace(/^asm\s+install\s+/i, '');
    const isGithub = /^(?:github:|https?:\/\/github\.com\/)/.test(source);
    let r = null, usedSource = source, via = 'asm';
    if (isGithub && !(await githubGitReachable())) {
      const direct = await installGithubSkillDirect(source);
      if (direct && direct.ok) {
        const synced = await syncAllSkills();
        return json(res, 200, { code: 0, via: 'github-tarball', installed: direct.name, synced });
      }
      via = direct && direct.error ? `直装失败: ${direct.error}` : '直装不可用';
    }
    if (!r) {
      const args = ['install', source, '-s', 'global', '-p', 'all', '-y', '--json'];
      ({ r, usedSource } = await asmInstallWithPathFix(source, args));
    }
    if (r.code !== 0 && isGithub) {
      const direct = await installGithubSkillDirect(usedSource);
      if (direct && direct.ok) {
        const synced = await syncAllSkills();
        return json(res, 200, { code: 0, via: 'github-tarball', installed: direct.name, synced });
      }
      if (direct && direct.error && via === 'asm') via = `asm失败+直装失败: ${direct.error}`;
    }
    const data = tryJson(r.stdout);
    const synced = r.code === 0 ? await syncAllSkills() : null;
    json(res, r.code === 0 ? 200 : 500, { code: r.code, via, resolvedSource: usedSource !== source ? usedSource : undefined, result: data, synced, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
  }],
  ['POST', /^\/api\/skills\/import-path$/, async (req, res, body) => {
    // 从本地路径安装/链接 skill（已安装在其他 agent 的 skill）
    const { path: p, tool = 'all', scope = 'global', link = false } = body || {};
    if (!p) return json(res, 400, { error: '缺少 path' });
    const args = link
      ? ['link', String(p), '-p', tool, '--json']
      : ['install', String(p), '-s', scope, '-p', tool, '-y', '--json'];
    const r = await asmRun(args, 120000);
    const data = tryJson(r.stdout);
    const synced = r.code === 0 ? await syncAllSkills() : null;
    json(res, r.code === 0 ? 200 : 500, { code: r.code, result: data, synced, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
  }],
  ['POST', /^\/api\/skills\/sync-all$/, async (req, res) => {
    json(res, 200, await syncAllSkills());
  }],
  ['POST', /^\/api\/skills\/uninstall$/, async (req, res, body) => {
    const { name } = body || {};
    if (!name) return json(res, 400, { error: '缺少 name' });
    const r = await asmRun(['uninstall', String(name), '-y'], 120000);
    json(res, r.code === 0 ? 200 : 500, { code: r.code, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
  }],
  ['POST', /^\/api\/skills\/(disable|enable)$/, async (req, res, body, m) => {
    const { name } = body || {};
    if (!name) return json(res, 400, { error: '缺少 name' });
    const r = await asmRun([m[1], String(name), '-y', '--json'], 120000);
    const data = tryJson(r.stdout);
    json(res, r.code === 0 ? 200 : 500, { code: r.code, result: data, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
  }],
  // ---- 自动路由（Hermes 本地模型路由器 ~/.hermes/router）----
  ['GET', /^\/api\/router\/status$/, async (req, res) => {
    const [router, ollama] = await Promise.all([
      fetch('http://127.0.0.1:8788/healthz', { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null),
      fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(4000) }).then((r) => r.json()).catch(() => null),
    ]);
    let cfg = null;
    try { cfg = JSON.parse(await readFile(path.join(HOME, '.hermes', 'router', 'config.json'), 'utf8')); } catch { /* 无配置 */ }
    const routesView = {};
    if (cfg && cfg.routes) {
      for (const [name, r] of Object.entries(cfg.routes)) {
        const chain = [r, ...(r.fallbacks || (r.fallback ? [r.fallback] : []))];
        routesView[name] = {
          model: r.model,
          host: String(r.baseUrl || '').replace(/^https?:\/\//, '').split('/')[0],
          fallbacks: chain.slice(1).map((f) => f.model),
        };
      }
    }
    json(res, 200, {
      routerOk: !!(router && router.ok),
      routerInfo: router || null,
      ollamaOk: !!ollama,
      classifier: cfg && cfg.classifierModel,
      routes: routesView,
    });
  }],
  ['GET', /^\/api\/router\/stats$/, async (req, res) => {
    try {
      const text = await readFile(path.join(HOME, '.hermes', 'router', 'router.log'), 'utf8').catch(() => '');
      const lines = text.trim() ? text.trim().split('\n') : [];
      const today = new Date().toISOString().slice(0, 10);
      const counts = {};
      let fails = 0, stick = 0, total = 0;
      for (const l of lines) {
        if (!l.includes(today)) continue;
        total++;
        const m = l.match(/route=(\w+)/);
        if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
        if (l.includes(' FAIL ')) fails++;
        if (l.includes('stick=1')) stick++;
      }
      json(res, 200, { date: today, total, counts, fails, stick, tail: lines.slice(-20) });
    } catch (e) { json(res, 500, { error: String(e) }); }
  }],
  ['GET', /^\/api\/router\/balance$/, async (req, res) => {
    if (balanceCache && Date.now() - balanceCache.ts < 60000) return json(res, 200, balanceCache.data);
    const r = await runCmd('/usr/bin/python3', [path.join(HOME, '.hermes', 'watchdog', 'balance_check.py')], 90000);
    if (r.code === 0) {
      const data = tryJson(r.stdout);
      if (data) {
        balanceCache = { ts: Date.now(), data };
        return json(res, 200, data);
      }
    }
    json(res, 200, { error: (r.stderr || r.stdout || 'balance check failed').slice(-300) });
  }],
  ['POST', /^\/api\/router\/restart$/, async (req, res) => {
    const r = await runCmd('launchctl', ['kickstart', '-k', 'gui/501/ai.hermes.router'], 15000);
    json(res, r.code === 0 ? 200 : 500, { ok: r.code === 0, stderr: r.stderr.slice(-200) });
  }],
  ['GET', /^\/api\/router\/digests$/, async (req, res) => {
    const dir = path.join(HOME, '.hermes', 'watchdog');
    try {
      const files = (await readdir(dir)).filter((f) => /^digest-\d{8}\.md$/.test(f)).sort().reverse();
      const list = [];
      for (const f of files.slice(0, 30)) {
        const st = await stat(path.join(dir, f));
        list.push({ name: f, mtime: st.mtime.toISOString(), size: st.size });
      }
      json(res, 200, { digests: list });
    } catch (e) { json(res, 500, { error: String(e) }); }
  }],
  ['GET', /^\/api\/router\/digest$/, async (req, res) => {
    const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
    if (!/^digest-\d{8}\.md$/.test(name)) return json(res, 400, { error: 'bad name' });
    try {
      const content = await readFile(path.join(HOME, '.hermes', 'watchdog', name), 'utf8');
      json(res, 200, { name, content });
    } catch (e) { json(res, 404, { error: String(e) }); }
  }],
  // ---------- 反向代理管理 ----------
  ['GET', /^\/api\/proxy\/list$/, async (req, res) => {
    await loadProxy();
    if (Date.now() - proxyCache.t > 10000 || !proxyCache.list.length) {
      const base = config.agentManagerUrl.replace(/\/$/, '');
      proxyCache.list = await Promise.all(proxyEntries.map(async (e) => ({
        ...e,
        ok: await probeTarget(e.target),
        url: `${base}${e.prefix}/`,
        llmUrl: e.id === 'router' ? `${base}${e.prefix}/v1` : null,
      })));
      proxyCache.t = Date.now();
    }
    json(res, 200, { entries: proxyCache.list });
  }],
  ['POST', /^\/api\/proxy\/add$/, async (req, res, body) => {
    const { name, prefix, target, llmRouter, note } = body || {};
    const p = String(prefix || '').trim();
    if (!name || !String(name).trim()) return json(res, 400, { error: '缺少名称' });
    if (!/^\/px\/[a-z0-9][a-z0-9-]{0,30}$/.test(p)) return json(res, 400, { error: '前缀须形如 /px/my-agent（小写字母/数字/中划线）' });
    let u;
    try { u = new URL(String(target || '').trim()); } catch { return json(res, 400, { error: '目标地址无效' }); }
    if (!/^https?:$/.test(u.protocol)) return json(res, 400, { error: '仅支持 http/https' });
    await loadProxy();
    if (proxyEntries.some((e) => e.prefix === p)) return json(res, 409, { error: '前缀已被占用' });
    proxyEntries.push({
      id: p.slice(4), name: String(name).trim(), prefix: p,
      target: String(target).trim().replace(/\/$/, ''), enabled: true,
      llmRouter: !!llmRouter, note: String(note || ''),
    });
    proxyEntries.sort((a, b) => b.prefix.length - a.prefix.length);
    await saveProxy();
    json(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/proxy\/update$/, async (req, res, body) => {
    const { id } = body || {};
    await loadProxy();
    const e = proxyEntries.find((x) => x.id === id);
    if (!e) return json(res, 404, { error: '条目不存在' });
    if (body.name !== undefined) e.name = String(body.name).trim() || e.name;
    if (body.target !== undefined) {
      try { new URL(String(body.target).trim()); } catch { return json(res, 400, { error: '目标地址无效' }); }
      e.target = String(body.target).trim().replace(/\/$/, '');
    }
    if (body.prefix !== undefined) {
      const p = String(body.prefix).trim();
      if (!/^\/px\/[a-z0-9][a-z0-9-]{0,30}$/.test(p)) return json(res, 400, { error: '前缀格式无效' });
      if (proxyEntries.some((x) => x !== e && x.prefix === p)) return json(res, 409, { error: '前缀已被占用' });
      e.prefix = p;
    }
    if (body.note !== undefined) e.note = String(body.note || '');
    if (body.llmRouter !== undefined) e.llmRouter = !!body.llmRouter;
    proxyEntries.sort((a, b) => b.prefix.length - a.prefix.length);
    await saveProxy();
    json(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/proxy\/delete$/, async (req, res, body) => {
    const { id } = body || {};
    await loadProxy();
    const e = proxyEntries.find((x) => x.id === id);
    if (!e) return json(res, 404, { error: '条目不存在' });
    if (e.builtin) return json(res, 400, { error: '内置条目不可删除，可停用' });
    proxyEntries = proxyEntries.filter((x) => x.id !== id);
    await saveProxy();
    json(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/proxy\/toggle$/, async (req, res, body) => {
    const { id, enabled } = body || {};
    await loadProxy();
    const e = proxyEntries.find((x) => x.id === id);
    if (!e) return json(res, 404, { error: '条目不存在' });
    e.enabled = !!enabled;
    await saveProxy();
    json(res, 200, { ok: true });
  }],
  ['GET', /^\/api\/proxy\/scan$/, async (req, res) => {
    const r = await runCmd('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    const out = [];
    for (const line of (r.stdout || '').split('\n').slice(1)) {
      const m = line.match(/^(\S+)\s+(\d+)\s.*TCP\s+(?:\*|(?:\d+\.){3}\d+|\[::\]):(\d+)\s+\(LISTEN\)/);
      if (!m) continue;
      const [, proc, pid, port] = m;
      out.push({ proc, pid: Number(pid), port: Number(port) });
    }
    json(res, 200, { ports: out });
  }],
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// ===== GET 响应短缓存 =====
// 读多写少的接口缓存 30s：启动预热 + 页内轮询/切 tab 不再重复跑 ps/lsof/Hub 请求；
// 任何 POST/PUT/DELETE 经本服务时整体失效，保证写后读一致。
const GET_CACHE = new Map(); // url -> { at, data }
const GET_CACHE_TTL = 30 * 1000;
const CACHEABLE_GET = /^\/api\/(overview|agents|mcp\/(servers|health|keys|settings)|skills|skills\/local|router\/(status|stats|trend|balance|config|classifier\/models|local-models|model-usage|agent-apply|agents|digests)|proxy\/list|ecosystem\/bootstrap)/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') GET_CACHE.clear();
    if (url.pathname.startsWith('/api/')) {
      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);
      if (req.method === 'GET' && CACHEABLE_GET.test(url.pathname)) {
        const ck = url.pathname + url.search;
        const hit = GET_CACHE.get(ck);
        if (hit && Date.now() - hit.at < GET_CACHE_TTL) return json(res, 200, hit.data);
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);
        const chunks = [];
        res.write = (c, ...a) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return origWrite(c, ...a); };
        res.end = (c, ...a) => {
          if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
          try {
            const text = Buffer.concat(chunks.filter((b) => typeof b === 'object')).toString();
            const data = JSON.parse(text);
            if (data && typeof data === 'object' && !data.error) GET_CACHE.set(ck, { at: Date.now(), data });
          } catch { /* 非 JSON 响应不缓存 */ }
          return origEnd(c, ...a);
        };
      }
      if (url.pathname.startsWith('/api/orchestrator/')) {
        const r = await handleOrchestratorApi(url, req.method, body);
        if (r === null) return json(res, 404, { error: 'Not found' });
        return json(res, r.error ? 400 : 200, r);
      }
      for (const [method, pattern, handler] of routes) {
        const m = url.pathname.match(pattern);
        if (m && method === req.method) {
          await handler(req, res, body, m, url);
          return;
        }
      }
      return json(res, 404, { error: 'Not found' });
    }
    // /px/<id>/ 本地服务代理（SSE/流式透传）
    const px = matchProxy(url.pathname);
    if (px) return proxyHttp(req, res, px);
    let fp = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname === '/favicon.ico' ? '/icons/logo.png' : decodeURIComponent(url.pathname));
    if (!fp.startsWith(path.join(__dirname, 'public'))) return json(res, 403, { error: 'Forbidden' });
    try {
      const data = await readFile(fp);
      const headers = { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' };
      if (path.extname(fp) === '.html') headers['Cache-Control'] = 'no-store'; // 面板单页应用，避免浏览器缓存旧 UI
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      json(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    json(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

// 生成网关服务目录，供各 Agent 常驻指令引用（解决"不知道网关里有什么"）
async function refreshGatewayCatalog() {
  const fp = path.join(DATA_DIR, 'gateway-catalog.md');
  try {
    const r = await hubFetch('GET', '/servers');
    const list = r.data?.data || [];
    const lines = [
      '# MCPHub 网关服务目录',
      '',
      `> 自动生成于 ${new Date().toISOString()} · 端点 ${HUB_URL}/mcp · 共 ${list.length} 个服务`,
      '',
      '| 服务名 | 状态 | 工具数 |',
      '|---|---|---|',
      ...list.map((s) => `| ${s.name || ''} | ${s.status || ''} | ${Array.isArray(s.tools) ? s.tools.length : (s.toolCount ?? '—')} |`),
      '',
      '工具命名规则：`mcp__mcphub__<服务名转下划线>__<工具名>`。需要某类能力但不确定是否已接入时，先查本表。',
    ];
    await writeFileSafe(fp, lines.join('\n') + '\n');
    return list.length;
  } catch (e) {
    console.log('[catalog] refresh failed:', e.message);
    return 0;
  }
}

// 默认装配：确保 agent-bridge MCP 在网关中、内置 skill 铺到所有 agent、网关目录生成、底层指令注入
async function ensureBuiltinInfra() {
  try {
    const servers = await hubFetch('GET', '/servers');
    const list = servers.data?.data || [];
    if (!list.some((s) => s.name === 'agent-bridge')) {
      const r = await hubFetch('POST', '/servers', {
        name: 'agent-bridge',
        config: {
          type: 'stdio',
          command: 'python3',
          args: [path.join(__dirname, 'tools', 'agent-bridge', 'bridge.py')],
        },
      });
      console.log('[builtin] agent-bridge 注册:', r.data?.success === false ? r.data.message : 'ok');
    }
  } catch (e) { console.log('[builtin] agent-bridge check failed:', e.message); }
  try {
    const r = await syncAllSkills();
    console.log(`[builtin] skills sync: ${r.created.length} created, ${r.skipped} skipped`);
  } catch (e) { console.log('[builtin] skills sync failed:', e.message); }
  try {
    await refreshGatewayCatalog();
  } catch (e) { console.log('[builtin] catalog failed:', e.message); }
  try {
    const r = await ensureAgentBootstrap();
    if (r.length) console.log('[builtin] bootstrap:', r.join('; '));
  } catch (e) { console.log('[builtin] bootstrap failed:', e.message); }
}

// WebSocket 升级走反代（MCP/Agent 实时通道）
server.on('upgrade', (req, socket, head) => {
  const entry = matchProxy(new URL(req.url, `http://localhost:${PORT}`).pathname);
  if (!entry) { socket.destroy(); return; }
  let u;
  try { u = new URL(entry.target); } catch { socket.destroy(); return; }
  const isHttps = u.protocol === 'https:';
  const mod = isHttps ? https : http;
  const up = mod.request({
    hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
    path: req.url.slice(entry.prefix.length) || '/', method: 'GET',
    headers: { ...req.headers, host: u.host }, timeout: 300000,
  });
  up.on('upgrade', (ures, us, uhead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [k, v] of Object.entries(ures.headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (uhead && uhead.length) socket.write(uhead);
    us.pipe(socket); socket.pipe(us);
    socket.on('error', () => us.destroy());
    us.on('error', () => socket.destroy());
  });
  up.on('response', (pres) => {
    pres.resume(); // 目标不支持 WebSocket 升级
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Type: application/json\r\n\r\n{"error":"proxy upgrade refused"}');
  });
  up.on('timeout', () => { up.destroy(); socket.destroy(); });
  up.on('error', () => socket.destroy());
  up.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Manager running at http://localhost:${PORT}`);
  console.log(`MCPHub: ${HUB_URL}  asm: ${ASM}`);
  initOrchestrator().catch((e) => console.log('[orch] init failed:', e.message));
  loadProxy().then(() => console.log(`[proxy] ${proxyEntries.filter((e) => e.enabled).length} 条代理已加载`)).catch((e) => console.log('[proxy] load failed:', e.message));
  ensureBuiltinInfra().catch((e) => console.log('[builtin] failed:', e.message));
  // 市场预热：错峰 3s 拉取，点进 tab 时直接命中缓存
  setTimeout(() => {
    mcpMarketFetch('', 50).then((d) => MCP_MKT_CACHE.set('|50', { at: Date.now(), data: d })).catch(() => {});
    skillMarketCached().catch(() => {});
  }, 3000);
  // 全接口预热：异步打自己的 GET 接口，填充 30s 响应缓存，首屏/切 tab 秒开
  setTimeout(() => {
    const base = `http://127.0.0.1:${PORT}`;
    const warm = [
      '/api/overview', '/api/agents', '/api/mcp/servers', '/api/mcp/health',
      '/api/skills', '/api/skills/local', '/api/proxy/list',
      '/api/router/status', '/api/router/stats', '/api/router/balance',
      '/api/ecosystem/bootstrap', '/api/orchestrator/tasks', '/api/orchestrator/config',
    ];
    // 错峰 300ms 一个，避免启动期并发打满 Hub/asm/ps
    warm.forEach((p, i) => setTimeout(() => fetch(base + p).catch(() => {}), i * 300));
  }, 3500);
});

// ===== 事件驱动自动同步 =====
// 监听各 agent 的 MCP/skill 配置与 WorkBuddy 连接器凭据，变更后防抖触发同步，替代轮询
const debounce = (fn, ms = 3000) => {
  let t = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      Promise.resolve(fn()).catch((e) => console.log('[watch] error:', e.message));
    }, ms);
  };
};

const onMcpChange = debounce(async () => {
  const r = await syncAllMcp();
  if (r.imported.length) console.log('[watch] MCP imported:', r.imported.join(', '));
  if (r.failed.length) console.log('[watch] MCP failed:', r.failed.join(', '));
  refreshGatewayCatalog().catch(() => {});
  // WorkBuddy 连接器凭据可能同时变化，顺带重注 auth
  execFile(process.execPath, [path.join(__dirname, 'tools', 'wb-cred-sync.js')], { timeout: 120000 }, () => {});
}, 3000);

const onSkillChange = debounce(async () => {
  const r = await syncAllSkills();
  console.log(`[watch] skills sync: ${r.sources} sources, ${r.created.length} created, ${r.skipped} skipped`);
}, 3000);

const watchPaths = (p, fn) => {
  try {
    const w = watch(p, { persistent: true }, fn);
    w.on('error', () => {});
    return w;
  } catch { return null; }
};

// MCP 配置文件 + WorkBuddy 插件清单 + 连接器凭据目录
const mcpWatch = new Set();
for (const a of AGENTS) for (const f of a.mcpFiles || []) mcpWatch.add(f.path);
mcpWatch.add(`${HOME}/.workbuddy/plugins/installed_plugins.json`);
mcpWatch.add(`${HOME}/.workbuddy/plugins/configured-plugins.json`);
// MCPHub 自身的服务清单：在 Dashboard/直接调 API 加 MCP 时也能触发目录刷新
mcpWatch.add(path.join(config.hubDataDir || `${HOME}/mcphub`, 'mcp_settings.json'));
try {
  for (const d of await readdir(`${HOME}/.workbuddy/connectors`, { withFileTypes: true })) {
    if (d.isDirectory()) mcpWatch.add(path.join(HOME, '.workbuddy', 'connectors', d.name));
  }
} catch { /* 无 connectors 目录 */ }
for (const p of mcpWatch) watchPaths(p, onMcpChange);

// skill 目录（含 importSkillDirs 源目录 + 内置 skill）；不存在的监听父目录以捕获后续创建
const skillWatch = new Set([path.join(__dirname, 'skills')]);
for (const a of AGENTS) {
  for (const d of [...(a.skillDirs || []), ...(a.importSkillDirs || [])]) skillWatch.add(d);
}
for (const s of await scanSkillsInDir(path.join(__dirname, 'skills'))) skillWatch.add(s.path);
for (const d of skillWatch) {
  if (!watchPaths(d, onSkillChange)) watchPaths(path.dirname(d), onSkillChange);
}
console.log(`[watch] watching ${mcpWatch.size} MCP paths, ${skillWatch.size} skill dirs`);
