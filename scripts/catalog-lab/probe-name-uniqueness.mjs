// Sonda LAB (PostgreSQL real + gateway FAKE): unicidad de nombres de beats ACTIVOS — duplicados, variantes (mayúsculas/espacios), concurrencia y restaurar.
//   node scripts/catalog-lab/probe-name-uniqueness.mjs
import fs from 'node:fs'; import crypto from 'node:crypto';
const cfg = JSON.parse(fs.readFileSync('E:/777/app/BeatGaler/tmp/catalog-lab/state/lab.env.json', 'utf8'));
const BASE = `http://127.0.0.1:${cfg.ports.webPostgres}/beatgaler-api`;
const jar = new Map(); let csrf = ''; let ctx;
const H = (extra = {}) => ({ 'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-BeatGaler-CSRF': csrf } : {}), ...extra });
async function req(method, p, { body, raw, headers } = {}) {
  const r = await fetch(BASE + p, { method, headers: raw ? { ...H(), 'Content-Type': 'application/octet-stream', ...headers } : H(headers), body: raw ?? (body ? JSON.stringify(body) : undefined) });
  for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
const results = []; const rec = (id, ok, extra) => { results.push(ok); console.log(JSON.stringify({ id, status: ok ? 'PASS' : 'FAIL', ...extra })); };
const login = await req('POST', '/auth/login', { body: { email: cfg.account.email, password: cfg.account.password, mfaCode: '', beatgalerUserId: 'lab-name-probe' } });
csrf = login.body?.csrf_token || '';
ctx = (await req('GET', '/catalog/v1/context')).body;
const E = () => ({ 'X-Catalog-Era': ctx.authority_era, 'X-Catalog-Epoch': ctx.authority_epoch });
const bytes = Buffer.concat(Array.from({ length: 300 }, () => { const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; return f; }));
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const intent = (name) => ({ kind: 'IMPORT', parts: [{ partKey: 'MASTER:0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: bytes.length, sha256: sha, filename: 'p.mp3', mime: 'audio/mpeg' }], metadata: { name, bpm: '', key: '', tags: [], rating: 0, color: '#7a7a7a', color2: '#a0a0a0' } });
const create = (name) => req('POST', '/catalog/v1/operations', { body: intent(name), headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
async function upload(opId) { const cap = await req('POST', `/catalog/v1/operations/${opId}/parts/${encodeURIComponent('MASTER:0')}/capability`, { headers: E() }); return req('PUT', cap.body.uploadPath, { raw: bytes, headers: { Authorization: `Bearer ${cap.body.token}`, ...E() } }); }
const commit = (opId) => req('POST', `/catalog/v1/operations/${opId}/commit`, { headers: E() });
async function commitUntilDone(opId) { for (let i = 0; i < 30; i++) { const c = await commit(opId); if (c.status >= 400) return c; if (c.body?.status === 'COMMITTED') return c; await new Promise((r) => setTimeout(r, 700)); } return { status: 0, body: 'timeout' }; }
const importOk = async (name) => { const o = await create(name); if (o.status >= 300) return o; await upload(o.body.operationId); const c = await commitUntilDone(o.body.operationId); return { status: c.status, body: c.body, opId: o.body.operationId, beatId: c.body?.result?.beatId ?? c.body?.beatId ?? o.body.beatId }; };
const list = async (q, state = 'ACTIVE') => (await req('GET', `/catalog/v1/beats?limit=200&state=${state}&q=${encodeURIComponent(q)}`)).body.items || [];
const find = async (name, state) => (await list(name, state)).find((x) => x.name === name);
const patch = (id, ver, name) => req('PATCH', `/catalog/v1/beats/${id}`, { body: { expectedVersion: ver, patch: { name } }, headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
const S = String(Date.now() % 1e6);

// 1) importación con nombre existente (y variantes): se rechaza ANTES de subir bytes
const base = `Unico ${S}`;
const first = await importOk(base); const f1 = await find(base);
rec('NAME-1-FIRST-IMPORT-OK', first.status < 300 && Boolean(f1), { status: first.status });
for (const [label, n] of [['exacto', base], ['mayusculas', base.toUpperCase()], ['espacios', `  ${base}  `]]) {
  const r = await create(n); rec(`NAME-2-DUPLICATE-${label}`, r.status === 409 && r.body?.code === 'NAME_TAKEN', { status: r.status, code: r.body?.code, name: r.body?.detail?.name });
}
// 3) concurrencia: dos importaciones simultáneas con el MISMO nombre nuevo → exactamente una gana
const race = `Carrera ${S}`;
const ops = await Promise.all([create(race), create(race)]);
const created = ops.filter((o) => o.status < 300);
await Promise.all(created.map((o) => upload(o.body.operationId)));
const commits = await Promise.all(created.map((o) => commitUntilDone(o.body.operationId)));
const winners = commits.filter((c) => c.status < 300 && c.body?.status === 'COMMITTED'); const losers = commits.filter((c) => c.status === 409 && c.body?.code === 'NAME_TAKEN');
const racers = (await list(race)).filter((x) => x.name === race);
rec('NAME-3-CONCURRENT-IMPORTS', racers.length === 1 && winners.length + losers.length === created.length && winners.length === 1 && (created.length === 1 || losers.length === 1), { created: created.length, winners: winners.length, losers: losers.length, inCatalog: racers.length, earlyRejected: ops.length - created.length });
// 4) renombrar a un nombre ocupado → 409; a una variante de mayúsculas de SÍ MISMO → permitido
const a = await find(base); const bName = `Otro ${S}`; await importOk(bName); const b = await find(bName);
const clash = await patch(b.id, b.version, base.toLowerCase());
rec('NAME-4-RENAME-TO-TAKEN', clash.status === 409 && clash.body?.code === 'NAME_TAKEN', { status: clash.status, code: clash.body?.code });
const self = await patch(a.id, a.version, base.toUpperCase());
rec('NAME-4b-RENAME-OWN-CASE-OK', self.status === 200, { status: self.status });
// 5) concurrencia en renombres: dos beats distintos al mismo nombre libre → una gana
const c1n = `Ren1 ${S}`; const c2n = `Ren2 ${S}`; await importOk(c1n); await importOk(c2n); const c1 = await find(c1n); const c2 = await find(c2n); const target = `Destino ${S}`;
const rs = await Promise.all([patch(c1.id, c1.version, target), patch(c2.id, c2.version, target)]);
rec('NAME-5-CONCURRENT-RENAMES', rs.filter((r) => r.status === 200).length === 1 && rs.filter((r) => r.status === 409 && r.body?.code === 'NAME_TAKEN').length === 1 && (await list(target)).filter((x) => x.name === target).length === 1, { statuses: rs.map((r) => r.status) });
// 6) papelera: el nombre de un beat en papelera NO se reserva; restaurar con el nombre ya ocupado se rechaza hasta renombrar
const tn = `Papelera ${S}`; await importOk(tn); const t1 = await find(tn);
const tr = await req('POST', '/catalog/v1/beats/trash', { body: { items: [{ beatId: t1.id, expectedVersion: t1.version }] }, headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
const reuse = await importOk(tn); const t2 = await find(tn);
const t1t = await find(tn, 'TRASH');
const rs1 = await req('POST', '/catalog/v1/beats/restore', { body: { items: [{ beatId: t1.id, expectedVersion: t1t.version }] }, headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
rec('NAME-6-TRASHED-NAME-NOT-RESERVED', tr.status < 300 && reuse.status < 300 && Boolean(t2), { trash: tr.status, reuse: reuse.status });
rec('NAME-6b-RESTORE-BLOCKED-WHILE-TAKEN', rs1.status === 409 && rs1.body?.code === 'NAME_TAKEN', { status: rs1.status, code: rs1.body?.code });
const ren = await patch(t2.id, t2.version, `${tn} (2)`); const t1t2 = await find(tn, 'TRASH');
const rs2 = await req('POST', '/catalog/v1/beats/restore', { body: { items: [{ beatId: t1.id, expectedVersion: t1t2.version }] }, headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
rec('NAME-6c-RESTORE-OK-AFTER-RENAME', ren.status === 200 && rs2.status < 300 && Boolean(await find(tn)), { rename: ren.status, restore: rs2.status });
console.log(`SUMMARY PASS=${results.filter(Boolean).length} FAIL=${results.filter((x) => !x).length}`);
