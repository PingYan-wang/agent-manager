#!/usr/bin/env node
// 解密 WorkBuddy 连接器本地凭据（用户自己的数据，用于迁移到 MCPHub）
// 算法逆向自 WorkBuddy.app app.asar:
//   aesKey = HKDF-SHA256(ikm=masterKey||utf8(userId), salt, info="workbuddy-oauth-credentials-v1", L=32)
//   AES-256-GCM, AAD = `${userId}|${serverKey}|${fieldName}`
// 输出: ~/.workbuddy/../mcphub-import/wb-headers.json (chmod 600)，不打印明文
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const HOME = os.homedir();
// 找到 connectors/<userId>/ 目录
const connRoot = path.join(HOME, '.workbuddy', 'connectors');
const userId = fs.readdirSync(connRoot).find((d) => /^[0-9a-f-]{36}$/.test(d));
if (!userId) { console.error('未找到 connectors/<userId>'); process.exit(1); }
const dir = path.join(connRoot, userId);
const masterKey = fs.readFileSync(path.join(dir, '.master.key'));
if (masterKey.length !== 32) { console.error('master.key 长度异常'); process.exit(1); }

const INFO = Buffer.from('workbuddy-oauth-credentials-v1', 'utf8');
const check = (buf, salt) => crypto.createHash('sha256').update(buf).update(salt).digest().subarray(0, 16).toString('base64');

function makeCipher(header) {
  const salt = Buffer.from(header.salt, 'base64');
  if (salt.length !== 16) throw new Error('bad salt');
  if (check(Buffer.from(userId, 'utf8'), salt) !== header.userIdCheck) throw new Error('userId-mismatch');
  if (check(masterKey, salt) !== header.keyCheck) throw new Error('key-mismatch');
  const aesKey = crypto.hkdfSync('sha256', Buffer.concat([masterKey, Buffer.from(userId, 'utf8')]), salt, INFO, 32);
  return {
    decrypt(env, serverKey, fieldName) {
      const iv = Buffer.from(env.iv, 'base64');
      const tag = Buffer.from(env.tag, 'base64');
      const ct = Buffer.from(env.ct, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
      d.setAAD(Buffer.from(`${userId}|${serverKey}|${fieldName}`, 'utf8'));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    },
  };
}

function decryptFile(file, mapKind) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cipher = makeCipher(doc.encryption);
  const out = {};
  const prefix = mapKind === 'headerOverrides' ? 'connector-states:headerOverrides' : 'connector-states:envOverrides';
  for (const [name, fields] of Object.entries(doc[mapKind] || {})) {
    out[name] = {};
    for (const [field, val] of Object.entries(fields)) {
      if (typeof val === 'string') { out[name][field] = val; continue; }
      try {
        out[name][field] = cipher.decrypt(val, `${prefix}:${name}`, field);
      } catch (e) {
        out[name][field] = `__DECRYPT_FAIL__:${e.message}`;
      }
    }
  }
  return out;
}

// connector-states.v3.json → 各连接器的 Authorization 头 / env
const states = JSON.parse(fs.readFileSync(path.join(dir, 'connector-states.v3.json'), 'utf8'));
const headerOverrides = decryptFile(path.join(dir, 'connector-states.v3.json'), 'headerOverrides');
const envOverrides = decryptFile(path.join(dir, 'connector-states.v3.json'), 'envOverrides');

// .credentials.v3.json → mcpOAuth tokens（lighthouse-ops 等）
const credPath = path.join(dir, '.credentials.v3.json');
const oauth = {};
if (fs.existsSync(credPath)) {
  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const cipher = makeCipher(cred.encryption);
  for (const [slot, tok] of Object.entries(cred.mcpOAuth || {})) {
    const entry = { serverName: tok.serverName, serverUrl: tok.serverUrl };
    for (const f of ['accessToken', 'refreshToken', 'idToken']) {
      const v = tok[f];
      if (v === undefined) continue;
      try { entry[f] = typeof v === 'string' ? v : cipher.decrypt(v, slot, f); }
      catch (e) { entry[f] = `__DECRYPT_FAIL__:${e.message}`; }
    }
    entry.tokenType = tok.tokenType; entry.expiresAt = tok.expiresAt; entry.scope = tok.scope;
    oauth[slot] = entry;
  }
}

const result = {
  userId,
  exportedAt: new Date().toISOString(),
  headerOverrides,   // { connector: { Authorization: 'Bearer ...' } }
  envOverrides,      // { connector: { ENV: '...' } }
  mcpOAuth: oauth,   // { 'name|hash': { serverUrl, accessToken, refreshToken, ... } }
};

const outPath = path.join(process.env.MCPHUB_DATA_DIR || path.join(HOME, 'mcphub'), 'wb-headers.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), { mode: 0o600 });
fs.chmodSync(outPath, 0o600);

// 只打印结构，不打印密钥值
console.log('userId:', userId);
console.log('headerOverrides:', Object.entries(headerOverrides).map(([k, v]) => `${k}:[${Object.keys(v).join(',')}]`).join(' '));
console.log('envOverrides:', Object.keys(envOverrides).join(',') || '(none)');
console.log('mcpOAuth slots:', Object.entries(oauth).map(([k, v]) => `${v.serverName || k}(url=${v.serverUrl})`).join(' | ') || '(none)');
console.log('written:', outPath);
