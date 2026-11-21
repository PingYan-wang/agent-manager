// 把 Agent Manager 的能力入口写进每个已安装 Agent 的原生持久指令 / 记忆文件。
//
// 设计约束（都是踩过的坑）：
// 1) 只对「扫描判定已安装」的 Agent 写入——不能用 HOME 是否存在当安装证据，否则没装的
//    Agent 也会被凭空创建目录。
// 2) 受管块用纯文本分隔符，不用 HTML 注释：注释里只要出现 system/ignore/override 这类
//    字样，Hermes 的 html_comment_injection 扫描就会把整段替换成 [BLOCKED]，受管块等于白写。
// 3) 只写可核实的入口（面板地址、网关地址、检索方式），不声称「网关已接入 / skill 已同步」；
//    这些真实状态由各 Agent 自己核对，写死会误导。
// 4) 幂等：重复执行不产生重复段落、不覆盖用户自有内容；旧版注释块自动迁移。
// 5) 写盘用临时文件 + rename，避免半截文件。
import { readFile, writeFile, mkdir, rename, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

export const BLOCK_BEGIN = '[agent-manager:begin]';
export const BLOCK_END = '[agent-manager:end]';
export const LEGACY_BEGIN = '<!-- agent-ecosystem:begin -->';
export const LEGACY_END = '<!-- agent-ecosystem:end -->';
export const HERMES_MEMORY_PREFIX = '[agent-manager] ';
export const HERMES_MEMORY_LIMIT = 2200; // 与 Hermes 默认 memory_char_limit 一致

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function writeFileSafe(fp, content) {
  await mkdir(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, fp);
}

// 旧版 HTML 注释受管块：有尾标记则整段去掉，缺尾标记只去掉标记本身（保留用户正文）
export function stripLegacyBlock(text) {
  let out = text;
  for (;;) {
    const b = out.indexOf(LEGACY_BEGIN);
    if (b === -1) break;
    const e = out.indexOf(LEGACY_END, b);
    out = e === -1
      ? out.slice(0, b) + out.slice(b + LEGACY_BEGIN.length)
      : out.slice(0, b) + out.slice(e + LEGACY_END.length);
  }
  return out.replace(/\n{3,}/g, '\n\n');
}

// 读取 → 迁移旧块 → 替换或追加受管块。返回 installed / updated / unchanged。
export async function applyBootstrapToFile(fp, block) {
  let text = '';
  try { text = await readFile(fp, 'utf8'); } catch { /* 新文件 */ }
  const before = text;
  text = stripLegacyBlock(text);
  const bi = text.indexOf(BLOCK_BEGIN), ei = text.indexOf(BLOCK_END);
  let next;
  if (bi !== -1 && ei > bi) {
    next = text.slice(0, bi) + block + text.slice(ei + BLOCK_END.length);
  } else {
    const trimmed = text.replace(/\s+$/, '');
    next = (trimmed ? `${trimmed}\n\n` : '') + block + '\n';
  }
  if (next === before) return 'unchanged';
  await writeFileSafe(fp, next);
  return before.includes(BLOCK_BEGIN) || before.includes(LEGACY_BEGIN) ? 'updated' : 'installed';
}

// Hermes 原生记忆是「每轮注入」的 MEMORY.md，条目之间用 "\n§\n" 分隔。
// 这里只维护一条以 [agent-manager] 开头的受管条目，并严格避免撑爆或覆盖用户记忆。
export async function applyHermesMemoryEntry(file, entry, { limit = HERMES_MEMORY_LIMIT, root } = {}) {
  const dir = path.dirname(file);
  // Hermes 已安装（调用方已检测过）但 memories/ 还没建过时，补建这一层；
  // 如果连 HERMES_HOME 都不存在，说明不是真的装了，放弃写入。
  if (root && !(await exists(root))) return 'skipped-no-dir';
  await mkdir(dir, { recursive: true });
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { /* 新文件 */ }
  const entries = text.replace(/\n+$/, '').split('\n§\n').map((s) => s.trim()).filter(Boolean);
  // 非 § 格式（单条超过整库上限 = 外部随意写入）交给 memory 工具处理，这里不覆盖
  if (entries.some((e) => e.length > limit)) return 'skipped-drift';
  const idx = entries.findIndex((e) => e.startsWith(HERMES_MEMORY_PREFIX));
  if (idx !== -1) {
    if (entries[idx] === entry) return 'unchanged';
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  if (entries.join('\n§\n').length > limit) return 'skipped-budget';
  await writeFileSafe(file, `${entries.join('\n§\n')}\n`);
  return idx === -1 ? 'installed' : 'updated';
}

export function createBootstrap({ home, dataDir, port, hubUrl, hermesHome, scanAgents, intervalMs = 5 * 60 * 1000 }) {
  const hermesHomeDir = hermesHome || path.join(home, '.hermes');
  const hermesMemoryFile = path.join(hermesHomeDir, 'memories', 'MEMORY.md');

  // agentId -> 原生持久入口。root 必须存在（该 Agent 真的装过）才写入。
  // scope: global=每次会话加载 / project-only=只在含该文件的项目目录内生效 / memory=原生记忆
  const targets = [
    { agent: 'codex', file: `${home}/.codex/AGENTS.md`, root: `${home}/.codex`, scope: 'global' },
    { agent: 'devin', file: `${home}/.config/devin/AGENTS.md`, root: `${home}/.config/devin`, scope: 'global' },
    { agent: 'devin', file: `${home}/.config/devin/rules/agent-ecosystem.md`, root: `${home}/.config/devin`, scope: 'global' },
    { agent: 'claude', file: `${home}/.claude/CLAUDE.md`, root: `${home}/.claude`, scope: 'global' },
    { agent: 'gemini', file: `${home}/.gemini/GEMINI.md`, root: `${home}/.gemini`, scope: 'global' },
    { agent: 'windsurf', file: `${home}/.codeium/windsurf/memories/global_rules.md`, root: `${home}/.codeium/windsurf`, scope: 'global' },
    { agent: 'workbuddy', file: `${home}/.workbuddy/AGENTS.md`, root: `${home}/.workbuddy`, scope: 'global' },
    // Cursor 的用户级规则存在它自己的设置库里，~/.cursor/rules 只在项目目录内生效
    { agent: 'cursor', file: `${home}/.cursor/rules/agent-ecosystem.mdc`, root: `${home}/.cursor`, scope: 'project-only' },
  ];

  function ecosystemBlock() {
    const panel = `http://localhost:${port}`;
    return `${BLOCK_BEGIN}
## 本机 Agent 生态能力（Agent Manager 自动维护，请勿手改本段）
- 本机跑着 Agent Manager：${panel}（Agent 体检 / MCP 同步 / Skill 分发 / 任务编排 / LLM 路由）。
- MCP 统一网关：${hubUrl}/mcp 。是否已接入以你自己客户端的 MCP 列表为准；接入后工具名为 mcp__mcphub__<服务>__<工具>，用前先确认该服务在网关内 connected，不要重复安装同名 MCP。
- 网关服务清单（名称/状态/工具数）：${path.join(dataDir, 'gateway-catalog.md')}。不确定本机有没有某能力时先读它。
- 【先查后做·最重要】遇到故障、陌生项目、不确定怎么做，或用户提到其他 Agent / 其他项目 / 某目录来历 / 「之前是不是做过 X」：动手前先用 agent-bridge 的 reuse_lookup 一次搜遍「其他 Agent 会话 + 共享记忆 + 已装 skill + 过往编排任务」，看别人是否解决过、有没有现成 skill；拿到线索再 conversation_read / 加载 skill / 看任务详情续做，不要从零重做。MCP 工具 agent-bridge-reuse_lookup(query, agent=我是谁, scope=self/others/all)，self 复用你自己上次的路，others 看别人；没有 MCP 客户端时 curl "http://127.0.0.1:3199/reuse?q=关键词&agent=hermes&scope=all"。结论用 memory_save 沉淀供后续会话与其他 Agent 复用。完整用法见 skill agent-ecosystem。
- 长程/多步骤任务可交给编排器：POST ${panel}/api/orchestrator/tasks {"goal":"..."}；完整用法见 skill agent-ecosystem。
${BLOCK_END}`;
  }

  function hermesMemoryEntry() {
    return `${HERMES_MEMORY_PREFIX}本机装有 Agent Manager（面板 http://localhost:${port}，MCP 网关 ${hubUrl}/mcp，skill 由它分发到各 Agent）。动手前先查复用：遇到故障/陌生项目/找其他 Agent 做过的方案，先用 agent-bridge-reuse_lookup(query,agent=自己,scope=self/others/all)（MCP）或 curl "http://127.0.0.1:3199/reuse?q=关键词&agent=自己" 一次搜遍会话(含自己上次)/共享记忆/已装 skill/过往任务，别从文件系统猜或从零重做。完整用法见 skill agent-ecosystem。`;
  }

  function detectedIds(agents) {
    return new Set((agents || []).filter((a) => a.installed || a.running || a.mcphub).map((a) => a.id));
  }

  let lastAt = 0;

  async function bootstrapStatus(agents) {
    const list = agents || (scanAgents ? await scanAgents() : []);
    const detected = detectedIds(list);
    const out = [];
    for (const t of targets) {
      let text = '';
      try { text = await readFile(t.file, 'utf8'); } catch { /* 不存在 */ }
      const installed = text.includes(BLOCK_BEGIN);
      out.push({
        agent: t.agent, file: t.file, scope: t.scope,
        detected: detected.has(t.agent), exists: !!text, installed,
        stale: !installed && text.includes(LEGACY_BEGIN),
        effective: t.scope === 'global' && installed,
      });
    }
    let mem = '';
    try { mem = await readFile(hermesMemoryFile, 'utf8'); } catch { /* 不存在 */ }
    const memInstalled = mem.split('\n§\n').some((e) => e.trim().startsWith(HERMES_MEMORY_PREFIX));
    out.push({
      agent: 'hermes', file: hermesMemoryFile, scope: 'memory',
      detected: detected.has('hermes'), exists: !!mem, installed: memInstalled,
      stale: false, effective: memInstalled,
    });
    return out;
  }

  async function ensureAgentBootstrap(opts = {}) {
    const agents = opts.agents || (scanAgents ? await scanAgents() : []);
    const detected = opts.detected || detectedIds(agents);
    const block = ecosystemBlock();
    const results = [];
    for (const t of targets) {
      if (!detected.has(t.agent)) { results.push({ agent: t.agent, file: t.file, action: 'skipped-absent' }); continue; }
      if (!(await exists(t.root))) { results.push({ agent: t.agent, file: t.file, action: 'skipped-no-dir' }); continue; }
      try {
        results.push({ agent: t.agent, file: t.file, scope: t.scope, action: await applyBootstrapToFile(t.file, block) });
      } catch (e) {
        results.push({ agent: t.agent, file: t.file, action: 'error', error: e.message });
      }
    }
    if (detected.has('hermes')) {
      try {
        results.push({
          agent: 'hermes', file: hermesMemoryFile, scope: 'memory',
          action: await applyHermesMemoryEntry(hermesMemoryFile, hermesMemoryEntry(), { root: hermesHomeDir }),
        });
      } catch (e) {
        results.push({ agent: 'hermes', file: hermesMemoryFile, action: 'error', error: e.message });
      }
    }
    lastAt = Date.now();
    return results;
  }

  // 体检页扫描后顺带对账（限频，避免每次刷新都写盘）
  function scheduleBootstrap(agents, onChange) {
    if (Date.now() - lastAt < intervalMs) return;
    lastAt = Date.now();
    ensureAgentBootstrap({ agents })
      .then((rs) => {
        const changed = rs.filter((r) => r.action === 'installed' || r.action === 'updated');
        if (changed.length && onChange) onChange(changed);
      })
      .catch(() => { /* 自动对账失败不影响服务 */ });
  }

  return { targets, ecosystemBlock, hermesMemoryEntry, bootstrapStatus, ensureAgentBootstrap, scheduleBootstrap, hermesMemoryFile };
}

// 列出目录里是否存在某个 Agent 的痕迹（供测试和调用方快速判定）
export async function dirHasEntries(dir) {
  try { return (await readdir(dir)).length > 0; } catch { return false; }
}
