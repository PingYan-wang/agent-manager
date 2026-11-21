#!/usr/bin/env node
// Agent Manager — 统一管理 MCPHub (MCP) 与 asm (Skills) 的本地可视化前端
// 依赖: Node >= 18, 全局安装的 @samanhappy/mcphub 与 agent-skill-manager
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat, mkdir, symlink, realpath, lstat, writeFile } from 'node:fs/promises';
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
        await lstat(dest);
        skipped.push(`${s.name} → ${dir} (已存在)`);
        continue;
      } catch { /* 不存在，继续 */ }
      try {
        await symlink(s.path, dest, 'dir');
        created.push(`${s.name} → ${dir}`);
      } catch (e) {
        errors.push(`${s.name} → ${dir}: ${e.message}`);
      }
    }
  }
  return { sources: sources.length, targets: targets.length, created, skipped: skipped.length, errors };
}

// ---------- Agent 底层指令注入（AGENTS.md / 全局规则） ----------
// 在各 Agent 的持久指令文件中维护一段受管代码块，运行时始终生效；
// 详细用法仍走 agent-ecosystem skill 按需加载，控制 token 开销。
const ECOSYSTEM_BLOCK = `<!-- agent-ecosystem:begin -->
## 本机 Agent 生态系统
- MCP 统一网关 http://localhost:3000/mcp 已接入并含腾讯文档/ima/lighthouse 等 WorkBuddy MCP：工具直接可用（命名 mcp__mcphub__<服务名>__<工具>），勿重复安装同类 MCP；新装 MCP 会自动同步进网关。
- 网关现有服务清单（名称/状态/工具数）见 ${path.join(DATA_DIR, 'gateway-catalog.md')}，不确定有没有某能力时先读它。
- Skill 已全量同步到你的 skill 目录；缺失时提示用户在 Agent Manager (http://localhost:3100) 点「同步全部 skill」。
- 会话继承/跨 Agent 读取：用 MCP 工具 agent-bridge-agents_list / agent-bridge-conversations_list / agent-bridge-conversation_read，agent 参数填本 Agent 名即可读自己的历史对话。
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

const routes = [
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
    const entryId = id || String(name).toLowerCase().replace(/[^\w-]/g, '-');
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
    try {
      const u = new URL(`${MCP_REGISTRY}/v0.1/servers`);
      u.searchParams.set('limit', String(limit));
      if (q.length >= 3) u.searchParams.set('search', q); // 官方要求搜索词≥3字符
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) return json(res, 502, { error: `Registry HTTP ${r.status}`, results: [] });
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
      json(res, 200, { results, total: results.length });
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
    const { source, tool = 'all', scope = 'global' } = body || {};
    if (!source) return json(res, 400, { error: '缺少 source' });
    const args = ['install', String(source), '-s', scope, '-p', tool, '-y', '--json'];
    const r = await asmRun(args, 300000);
    const data = tryJson(r.stdout);
    json(res, r.code === 0 ? 200 : 500, { code: r.code, result: data, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
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
    json(res, r.code === 0 ? 200 : 500, { code: r.code, result: data, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);
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
    let fp = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!fp.startsWith(path.join(__dirname, 'public'))) return json(res, 403, { error: 'Forbidden' });
    try {
      const data = await readFile(fp);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
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
