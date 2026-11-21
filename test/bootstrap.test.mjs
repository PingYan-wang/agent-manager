import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBootstrap, BLOCK_BEGIN, BLOCK_END, HERMES_MEMORY_PREFIX, stripLegacyBlock } from '../src/agents/bootstrap.js';

const clone = async (f) => JSON.parse(JSON.stringify(f));

async function sandbox({ agents = [], hermes = false, withRoots = [] } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'am-bootstrap-'));
  for (const r of withRoots) await mkdir(path.join(home, r), { recursive: true });
  if (hermes) await mkdir(path.join(home, '.hermes', 'memories'), { recursive: true });
  const b = createBootstrap({
    home, dataDir: path.join(home, '.agent-manager'), port: 3100, hubUrl: 'http://localhost:3000',
    scanAgents: async () => clone(agents),
  });
  return { home, b };
}

const existing = async (p) => { try { await stat(p); return true; } catch { return false; } };

test('只给已安装的 Agent 写入，未安装的连目录都不创建', async () => {
  const { home, b } = await sandbox({
    agents: [{ id: 'codex', installed: true }, { id: 'claude', installed: false }],
    withRoots: ['.codex'],                 // claude 装了没装都留空，模拟未安装
  });
  const res = await b.ensureAgentBootstrap();
  const byAgent = Object.fromEntries(res.map((r) => [`${r.agent}:${path.basename(r.file)}`, r.action]));

  assert.equal(byAgent['codex:AGENTS.md'], 'installed');
  assert.equal(byAgent['claude:CLAUDE.md'], 'skipped-absent');
  assert.ok(await existing(path.join(home, '.codex', 'AGENTS.md')));
  assert.equal(await existing(path.join(home, '.claude')), false);

  const text = await readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.ok(text.includes(BLOCK_BEGIN) && text.includes(BLOCK_END));
  assert.ok(text.includes('http://localhost:3100'));
});

test('重复执行幂等：第二次全部 unchanged，且不出现重复段落', async () => {
  const { home, b } = await sandbox({ agents: [{ id: 'codex', installed: true }], withRoots: ['.codex'] });
  await b.ensureAgentBootstrap();
  const first = await readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  const res = await b.ensureAgentBootstrap();
  const second = await readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8');

  assert.equal(res.find((r) => r.agent === 'codex').action, 'unchanged');
  assert.equal(first, second);
  assert.equal(second.split(BLOCK_BEGIN).length - 1, 1);
});

test('保留用户原有内容，受管块追加在后', async () => {
  const { home, b } = await sandbox({ agents: [{ id: 'codex', installed: true }], withRoots: ['.codex'] });
  const fp = path.join(home, '.codex', 'AGENTS.md');
  await writeFile(fp, '# 我自己的规则\n\n- 用 pnpm，不要用 npm\n');
  await b.ensureAgentBootstrap();
  const text = await readFile(fp, 'utf8');
  assert.ok(text.startsWith('# 我自己的规则'));
  assert.ok(text.includes('用 pnpm，不要用 npm'));
  assert.ok(text.indexOf(BLOCK_BEGIN) > text.indexOf('用 pnpm'));
});

test('旧版 HTML 注释块被迁移成纯文本块，用户内容不受影响', async () => {
  const { home, b } = await sandbox({ agents: [{ id: 'cursor', installed: true }], withRoots: ['.cursor'] });
  const fp = path.join(home, '.cursor', 'rules', 'agent-ecosystem.mdc');
  await mkdir(path.dirname(fp), { recursive: true });
  await writeFile(fp, [
    '---', 'description: 旧规则', '---', '',
    '<!-- agent-ecosystem:begin -->', '旧版受管内容（会被注入扫描器屏蔽）', '<!-- agent-ecosystem:end -->', '',
    '保留我这段',
  ].join('\n'));

  const res = await b.ensureAgentBootstrap();
  assert.equal(res.find((r) => r.file === fp).action, 'updated');
  const text = await readFile(fp, 'utf8');
  assert.ok(!text.includes('<!--'), '不应再残留 HTML 注释标记');
  assert.ok(!text.includes('旧版受管内容'));
  assert.ok(text.includes(BLOCK_BEGIN));
  assert.ok(text.includes('保留我这段'));
  assert.ok(text.startsWith('---\ndescription: 旧规则'));
});

test('受管块不含 HTML 注释（避免被 html_comment_injection 整段拦截）', async () => {
  const { b } = await sandbox();
  const block = b.ecosystemBlock();
  assert.ok(!block.includes('<!--'));
  assert.ok(block.startsWith(BLOCK_BEGIN));
  assert.ok(block.trimEnd().endsWith(BLOCK_END));
});

test('Hermes 已安装但 memories 目录未建时，补建目录并写入', async () => {
  const { home, b } = await sandbox({ agents: [{ id: 'hermes', installed: true }] }); // 只建 home，不建 .hermes
  await mkdir(path.join(home, '.hermes'), { recursive: true }); // 模拟已安装 Hermes，但还没初始化记忆目录
  const fp = path.join(home, '.hermes', 'memories', 'MEMORY.md');
  const res = await b.ensureAgentBootstrap();
  assert.equal(res.find((r) => r.agent === 'hermes').action, 'installed');
  assert.ok(await existing(fp));
  assert.ok((await readFile(fp, 'utf8')).includes(HERMES_MEMORY_PREFIX));
});

test('Hermes 记忆：写入单条 § 条目并保留已有记忆', async () => {
  const { home, b } = await sandbox({ agents: [{ id: 'hermes', installed: true }], hermes: true });
  const fp = path.join(home, '.hermes', 'memories', 'MEMORY.md');
  await writeFile(fp, '用户偏好简洁回复\n§\n环境是 macOS\n');

  const res = await b.ensureAgentBootstrap();
  assert.equal(res.find((r) => r.agent === 'hermes').action, 'installed');
  const entries = (await readFile(fp, 'utf8')).trimEnd().split('\n§\n');
  assert.deepEqual(entries.slice(0, 2), ['用户偏好简洁回复', '环境是 macOS']);
  assert.equal(entries.length, 3);
  assert.ok(entries[2].startsWith(HERMES_MEMORY_PREFIX));

  const again = await b.ensureAgentBootstrap();
  assert.equal(again.find((r) => r.agent === 'hermes').action, 'unchanged');
  assert.equal((await readFile(fp, 'utf8')).trimEnd().split('\n§\n').length, 3);
});

test('Hermes 记忆：外部非 § 格式不覆盖，回调 skipped-drift', async () => {
  const { home, b } = await sandbox({ agents: [{ id: 'hermes', installed: true }], hermes: true });
  const fp = path.join(home, '.hermes', 'memories', 'MEMORY.md');
  const drift = 'x'.repeat(3000);           // 单条超过整库上限 = 外部随意写入
  await writeFile(fp, drift);
  const res = await b.ensureAgentBootstrap();
  assert.equal(res.find((r) => r.agent === 'hermes').action, 'skipped-drift');
  assert.equal(await readFile(fp, 'utf8'), drift);
});

test('Hermes 记忆：会撑爆预算时放弃写入而不是挤掉用户记忆', async () => {
  const { home, b } = await sandbox({ agents: [{ id: 'hermes', installed: true }], hermes: true });
  const fp = path.join(home, '.hermes', 'memories', 'MEMORY.md');
  const full = ['a'.repeat(1000), 'b'.repeat(1000)].join('\n§\n') + '\n';
  await writeFile(fp, full);
  const res = await b.ensureAgentBootstrap();
  assert.equal(res.find((r) => r.agent === 'hermes').action, 'skipped-budget');
  assert.equal(await readFile(fp, 'utf8'), full);
});

test('状态接口区分 detected / installed / stale / effective', async () => {
  const { home, b } = await sandbox({
    agents: [{ id: 'codex', installed: true }, { id: 'windsurf', installed: true }, { id: 'cursor', installed: true }],
    hermes: false,
    withRoots: ['.codex', '.codeium/windsurf', '.cursor'],
  });
  const fp = path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md');
  await mkdir(path.dirname(fp), { recursive: true });
  await writeFile(fp, '<!-- agent-ecosystem:begin -->\n旧块\n<!-- agent-ecosystem:end -->\n');

  const status = await b.bootstrapStatus();
  const find = (agent) => status.find((s) => s.agent === agent);
  assert.equal(find('codex').installed, false);
  assert.equal(find('codex').detected, true);
  assert.equal(find('windsurf').stale, true);
  assert.equal(find('cursor').effective, false, 'Cursor 的 rules 只是项目级，不算全局生效');

  await b.ensureAgentBootstrap();
  const after = await b.bootstrapStatus();
  assert.equal(after.find((s) => s.agent === 'codex').effective, true);
  assert.equal(after.find((s) => s.agent === 'windsurf').stale, false);
});

test('缺少尾标记时只清掉标记本身，不吞掉用户正文', () => {
  const text = 'A\n<!-- agent-ecosystem:begin -->\n用户正文\nB';
  const out = stripLegacyBlock(text);
  assert.ok(!out.includes('<!--'));
  assert.ok(out.includes('用户正文'));
  assert.ok(out.includes('A') && out.includes('B'));
});
