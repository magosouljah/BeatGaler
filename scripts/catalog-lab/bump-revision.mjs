// Auxiliar LAB: importa un beat por HTTP con OTRA sesión (sube la revisión del catálogo sin que la página abierta lo sepa). NAME=... node scripts/catalog-lab/bump-revision.mjs
import fs from 'node:fs'; import crypto from 'node:crypto';
const cfg = JSON.parse(fs.readFileSync(`${process.env.LAB_STATE_DIR || 'E:/777/app/BeatGaler/tmp/catalog-lab/state'}/lab.env.json`, 'utf8'));
const BASE = process.env.BASE || `http://127.0.0.1:${cfg.ports.webPostgres}/beatgaler-api`;
const jar = new Map(); let csrf = '';
const H = (extra = {}) => ({ 'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-BeatGaler-CSRF': csrf } : {}), ...extra });
async function req(method, p, { body, raw, headers } = {}) {
  const r = await fetch(BASE + p, { method, headers: raw ? { ...H(), 'Content-Type': process.env.CT || 'application/octet-stream', ...headers } : H(headers), body: raw ?? (body ? JSON.stringify(body) : undefined) });
  for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const log = (...a) => console.log(...a);
const login = await req('POST', '/auth/login', { body: { email: cfg.account.email, password: cfg.account.password, mfaCode: '', beatgalerUserId: 'lab-probe-install' } });
log('login', login.status, Object.keys(login.body || {}));
csrf = login.body?.csrf_token || '';
const ctx = await req('GET', '/catalog/v1/context'); log('context', ctx.status, JSON.stringify(ctx.body).slice(0, 300));
const bytes = Buffer.concat(Array.from({ length: 800 }, () => { const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; return f; }));
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const name = process.env.NAME || 'Probe import 50 ' + 'x'.repeat(10);
const intent = { kind: 'IMPORT', parts: [{ partKey: 'MASTER:0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: bytes.length, sha256: sha, filename: 'probe.mp3', mime: 'audio/mpeg' }], metadata: { name, bpm: '', key: '', tags: [], rating: 0, color: '#7a7a7a', color2: '#a0a0a0' } };
globalThis.__e = { 'X-Catalog-Era': ctx.body.authority_era, 'X-Catalog-Epoch': ctx.body.authority_epoch };
const op = await req('POST', '/catalog/v1/operations', { body: intent, headers: { 'Idempotency-Key': crypto.randomUUID(), ...globalThis.__e } });
log('createOperation', op.status, JSON.stringify(op.body).slice(0, 400));
if (op.status >= 300) process.exit(1);
const opId = op.body.operationId;
const cap = await req('POST', `/catalog/v1/operations/${opId}/parts/${encodeURIComponent('MASTER:0')}/capability`, { headers: globalThis.__e }); log('capability', cap.status, JSON.stringify(cap.body).slice(0, 200));
const up = await req('PUT', cap.body.uploadPath, { raw: bytes, headers: { Authorization: `Bearer ${cap.body.token}`, ...globalThis.__e } }); log('upload', up.status, JSON.stringify(up.body).slice(0, 400));
for (let i = 0; i < 20; i++) {
  const c = await req('POST', `/catalog/v1/operations/${opId}/commit`, { headers: globalThis.__e }); log('commit', i, c.status, JSON.stringify(c.body).slice(0, 300));
  if (c.status < 300 && c.body?.status === 'COMMITTED') break; await new Promise((r) => setTimeout(r, 1500));
}
const list = await req('GET', '/catalog/v1/beats?limit=3&sort=created_desc'); log('beats', list.status, JSON.stringify(list.body).slice(0, 300));
