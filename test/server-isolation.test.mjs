import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
test('isolated server protects management writes without integration startup', { timeout: 20000 }, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'agent-server-test-'));
  const configFile = path.join(temp, 'config.json');
  await writeFile(configFile, '{}');
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), AGENT_MANAGER_CONFIG: configFile, AGENT_MANAGER_DATA_DIR: temp, AGENT_MANAGER_STARTUP_EFFECTS: '0', AGENT_MANAGER_WRITE_TOKEN: 'test-local-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', (buffer) => { output += buffer.toString(); if (output.includes('isolated mode')) resolve(); });
    child.stderr.on('data', (buffer) => { output += buffer.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited ${code}: ${output}`)));
  });
  try {
    await started;
    const base = `http://127.0.0.1:${port}`;
    const index = await fetch(base);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const session = await (await fetch(`${base}/api/session`)).json();
    assert.equal(session.writeToken, 'test-local-token');
    assert.equal((await fetch(`${base}/api/nonexistent`)).status, 403);
    assert.equal((await fetch(`${base}/api/nonexistent`, { headers: { 'x-agent-manager-token': session.writeToken } })).status, 404);
    assert.equal((await fetch(`${base}/api/session`, { headers: { origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await fetch(`${base}/api/nonexistent`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/nonexistent`, { method: 'POST', headers: { 'x-agent-manager-token': session.writeToken }, body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/api/nonexistent`, { method: 'POST', headers: { 'x-agent-manager-token': session.writeToken }, body: 'broken' })).status, 400);
    assert.deepEqual(await readdir(temp), ['config.json']);
    assert.doesNotMatch(output, /\[builtin\]|\[watch\]/);
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
});
