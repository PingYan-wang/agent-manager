import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { containedPath, readJsonBody, redactSecrets, requestAllowed } from '../src/http/boundaries.js';

const request = (method = 'GET', headers = {}) => ({ method, headers: { host: '127.0.0.1:3100', ...headers } });
test('local management requires same-site Host/Origin and a write token', () => {
  assert.equal(requestAllowed(request(), 3100, 'secret').status, 403);
  assert.equal(requestAllowed(request('GET', { 'x-agent-manager-token': 'secret' }), 3100, 'secret'), null);
  assert.equal(requestAllowed(request('GET', { host: 'attacker.invalid:3100' }), 3100, 'secret').status, 403);
  assert.equal(requestAllowed(request('GET', { origin: 'https://attacker.invalid' }), 3100, 'secret').status, 403);
  assert.equal(requestAllowed(request('POST'), 3100, 'secret').status, 403);
  assert.equal(requestAllowed(request('POST', { 'x-agent-manager-token': 'secret' }), 3100, 'secret'), null);
  assert.equal(requestAllowed(request('POST', { cookie: 'a=b; agent_manager_session=secret' }), 3100, 'secret'), null);
  assert.equal(requestAllowed(request('POST', { 'sec-fetch-site': 'cross-site', 'x-agent-manager-token': 'secret' }), 3100, 'secret').status, 403);
  assert.equal(requestAllowed(request('POST'), 3100, null), null);
});
test('all nested configuration branches redact sentinel secrets', () => {
  const value = { providers: { a: { apiKey: 'sentinel' } }, routes: { coding: { chain: [{ apiKey: 'sentinel' }], fallbacks: [{ api_key: 'sentinel' }] } }, planner: { apiKey: 'sentinel' }, password: 'sentinel' };
  const result = redactSecrets(value);
  assert.equal(JSON.stringify(result).includes('sentinel'), false);
  assert.equal(value.planner.apiKey, 'sentinel');
});
test('path containment rejects sibling-prefix and parent traversal', () => {
  assert.equal(containedPath('/app/public', '/app/public/icons/a.png'), true);
  assert.equal(containedPath('/app/public', '/app/public-secret/a'), false);
  assert.equal(containedPath('/app/public', '/app/public/../secret'), false);
});
test('JSON parser bounds bytes and distinguishes malformed input', async () => {
  assert.deepEqual(await readJsonBody(Readable.from([Buffer.from('{"a":1}')])), { a: 1 });
  await assert.rejects(readJsonBody(Readable.from([Buffer.from('invalid')])), { statusCode: 400 });
  await assert.rejects(readJsonBody(Readable.from([Buffer.from('123456')]), 5), { statusCode: 413 });
});
