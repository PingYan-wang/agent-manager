import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(apiKey|api_key|accessToken|refreshToken|authorization|password|secret|writeToken)$/i.test(key)
      ? (item ? '***' : item) : redactSecrets(item),
  ]));
}

export function requestAllowed(req, port, writeToken) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  if (!hosts.has(req.headers.host)) return { status: 403, error: 'Invalid local Host' };
  const origin = req.headers.origin;
  if (origin) {
    let url;
    try { url = new URL(origin); } catch { return { status: 403, error: 'Invalid Origin' }; }
    if (url.protocol !== 'http:' || !hosts.has(url.host)) return { status: 403, error: 'Cross-origin access denied' };
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return { status: 403, error: 'Cross-site access denied' };
  if (writeToken) {
    const expected = Buffer.from(String(writeToken));
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('agent_manager_session='));
    const actual = Buffer.from(String(req.headers['x-agent-manager-token'] || cookie?.slice('agent_manager_session='.length) || ''));
    if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { status: 403, error: 'Missing or invalid management token' };
    }
  }
  return null;
}

export function proxyRequestAllowed(req, port, allowedOrigins = []) {
  const localError = requestAllowed({ ...req, headers: { ...req.headers, origin: undefined, 'sec-fetch-site': undefined } }, port, null);
  if (localError) return localError;
  const origin = req.headers.origin;
  if (!origin) return null;
  let url;
  try { url = new URL(origin); } catch { return { status: 403, error: 'Invalid proxy Origin' }; }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((loopback && ['http:', 'https:'].includes(url.protocol)) || allowedOrigins.includes(url.origin)) return null;
  return { status: 403, error: 'Proxy Origin not allowed' };
}

export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('JSON body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
}

export function containedPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
