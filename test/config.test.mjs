import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const configUrl = new URL('../config.js', import.meta.url).href;
const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const temp = await mkdtemp(path.join(tmpdir(), 'agent-config-test-'));
const cfg = path.join(temp, 'config.json');
function load(extra = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `const {config,DATA_DIR}=await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({port:config.port,dataDir:DATA_DIR,startupEffects:config.startupEffects}))`], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PORT: '3100', AGENT_MANAGER_CONFIG: cfg, AGENT_MANAGER_DATA_DIR: temp, AGENT_MANAGER_STARTUP_EFFECTS: '0', ...extra },
  });
}
test('explicit config and data directory isolate test state', async () => {
  await writeFile(cfg, '{}');
  const child = load();
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { port: 3100, dataDir: temp, startupEffects: false });
});
test('invalid JSON does not silently fall back', async () => {
  await writeFile(cfg, '{broken');
  const child = load();
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /无法加载配置/);
});
test('invalid ports and URL schemes are rejected', async () => {
  await writeFile(cfg, '{}');
  assert.notEqual(load({ PORT: '70000' }).status, 0);
  assert.notEqual(load({ MCPHUB_URL: 'file:///private' }).status, 0);
});
