import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const proxy = fileURLToPath(new URL('./proxy.mjs', import.meta.url));

test('Devin gateway requires a key and rejects unsupported OpenAI requests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'devin-proxy-test-'));
  const bin = path.join(dir, 'devin');
  await writeFile(bin, '#!/bin/sh\nprintf "mock response\\n"\n');
  await chmod(bin, 0o700);

  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));

  const child = spawn(process.execPath, [proxy], {
    env: {
      ...process.env, PORT: String(port), DEVIN_PROXY_KEY: 'test-only-key',
      DEVIN_BIN: bin, DEVIN_MODEL_MAP: '{"devin-test":"swe"}', DEVIN_PROXY_WORKDIR: dir,
    },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const post = (body, key = 'test-only-key') => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const message = { model: 'devin-test', messages: [{ role: 'user', content: 'hello' }] };

  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        ready = r.ok;
        if (ready) break;
      } catch { /* wait for child listener */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'gateway started');
    assert.equal((await post(message, 'wrong-key')).status, 401);
    assert.equal((await post({ ...message, tools: [{ type: 'function', function: { name: 'run' } }] })).status, 400);
    assert.equal((await post({ ...message, stream: true })).status, 400);
    assert.equal((await post({ ...message, model: 'unlisted' })).status, 400);
    assert.equal((await post({ ...message, messages: [{ role: 'user', content: [{ type: 'image_url' }] }] })).status, 400);
    const response = await post(message);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'mock response');
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
