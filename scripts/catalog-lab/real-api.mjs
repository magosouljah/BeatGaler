// Utilidades API del LAB REAL (login por cookie, CSRF, era/epoch). Solo LAB (LAB_STATE_DIR) — nunca producción.
import fs from 'node:fs'; import crypto from 'node:crypto';
const stateDir = process.env.LAB_STATE_DIR || 'E:/777/app/BeatGaler/tmp/catalog-lab-real';
export const cfg = JSON.parse(fs.readFileSync(`${stateDir}/lab.env.json`, 'utf8'));
export const BASE = `http://127.0.0.1:${cfg.ports.webPostgres}/beatgaler-api`;
const jar = new Map(); let csrf = ''; export let ctx;
const H = (extra = {}) => ({ 'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-BeatGaler-CSRF': csrf } : {}), ...extra });
export async function req(method, p, { body, raw, headers, binary } = {}) {
  const r = await fetch(p.startsWith('http') ? p : BASE + p, { method, headers: raw ? { ...H(), 'Content-Type': 'application/octet-stream', ...headers } : H(headers), body: raw ?? (body ? JSON.stringify(body) : undefined) });
  for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  if (binary) return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
export async function login() {
  const l = await req('POST', '/auth/login', { body: { email: cfg.account.email, password: cfg.account.password, mfaCode: '', beatgalerUserId: 'lab-real-probe' } });
  csrf = l.body?.csrf_token || ''; ctx = (await req('GET', '/catalog/v1/context')).body; return ctx;
}
export const E = () => ({ 'X-Catalog-Era': ctx.authority_era, 'X-Catalog-Epoch': ctx.authority_epoch });
export const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const results = []; export const rec = (id, ok, extra) => { results.push(ok); const { status: http, ...rest } = extra || {}; console.log(JSON.stringify({ id, status: ok ? 'PASS' : 'FAIL', ...(http !== undefined ? { http } : {}), ...rest })); };
const GRAMMAR = { MASTER: ['MASTER:0', 'MASTER'], WAV: ['FILES:0:0', 'FILES:0'], ARTWORK: ['ARTWORK:0', 'ARTWORK'], PROJECT: ['PROJECT:0', 'PROJECT'] };
export const part = (role, bytes, filename, mime) => ({ partKey: GRAMMAR[role][0], slotKey: GRAMMAR[role][1], role, partIndex: 0, size: bytes.length, sha256: sha(bytes), filename, mime });
export async function importBeat(name, files, metadata = {}) { // files: [{role, bytes, filename, mime}]
  const parts = files.map((f) => part(f.role, f.bytes, f.filename, f.mime));
  const op = await req('POST', '/catalog/v1/operations', { body: { kind: 'IMPORT', parts, metadata: { name, bpm: '', key: '', tags: [], rating: 0, color: '#3a3a3a', color2: '#777777', ...metadata } }, headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
  if (op.status >= 300) return { op };
  for (const f of files) {
    const pk = encodeURIComponent(GRAMMAR[f.role][0]);
    if (f.role === 'PROJECT') { const up = await req('PUT', `/catalog/v1/operations/${op.body.operationId}/parts/${pk}/project`, { raw: f.bytes, headers: { 'X-Catalog-Filename': f.filename, ...E() } }); if (up.status >= 300) return { op, up }; continue; }
    const cap = await req('POST', `/catalog/v1/operations/${op.body.operationId}/parts/${pk}/capability`, { headers: E() });
    if (cap.status >= 300) return { op, cap };
    const up = await req('PUT', cap.body.uploadPath, { raw: f.bytes, headers: { Authorization: `Bearer ${cap.body.token}`, ...E() } });
    if (up.status >= 300) return { op, cap, up };
  }
  for (let i = 0; i < 60; i++) { const c = await req('POST', `/catalog/v1/operations/${op.body.operationId}/commit`, { headers: E() }); if (c.status >= 400 || c.body?.status === 'COMMITTED') return { op, commit: c }; await new Promise((r) => setTimeout(r, 1000)); }
  return { op, commit: { status: 0 } };
}
export const find = async (name, state = 'ACTIVE') => ((await req('GET', `/catalog/v1/beats?limit=200&state=${state}&q=${encodeURIComponent(name)}`)).body.items || []).find((x) => x.name === name);
export async function downloadFile(fileId, range) {
  const a = await req('POST', `/catalog/v1/files/${fileId}/access`, { headers: E() });
  if (a.status >= 300) return { access: a };
  const out = []; for (const p of a.body.parts) { const r = await req('GET', p.url, { binary: true, headers: range ? { Range: range } : {} }); out.push({ status: r.status, buf: r.buf, partSha: p.sha256, size: p.size }); }
  return { access: a, parts: out };
}
