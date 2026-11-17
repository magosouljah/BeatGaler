// LAB REAL: reemplazo de MASTER y fallos controlados con Telegram real de pruebas (API). SHA-256 de cada versión.
//   . /tmp/realenv.sh; node scripts/catalog-lab/real-faults.mjs
import crypto from 'node:crypto'; import http from 'node:http';
import { login, importBeat, find, req, E, downloadFile, sha, rec, results, part, BASE } from './real-api.mjs';
await login();
const S = String(Date.now() % 1e6);
const mp3 = (frames, tag) => { const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; return Buffer.concat([...Array.from({ length: frames }, () => f), Buffer.from(tag)]); };
const A = mp3(400, 'A' + S); const B = mp3(900, 'B' + S); const C = mp3(700, 'C' + S);
const name = `Faults ${S}`;
const filesOf = async (id) => (await req('GET', `/catalog/v1/beats/${id}/files`)).body;
const masterBytes = async (id) => { const m = ((await filesOf(id)).items || []).find((x) => x.role === 'MASTER' && x.current); const d = await downloadFile(m.fileId); return d.parts && Buffer.concat(d.parts.map((p) => p.buf)); };
const r0 = await importBeat(name, [{ role: 'MASTER', bytes: A, filename: 'a.mp3', mime: 'audio/mpeg' }]);
let beat = await find(name);
rec('F-0-IMPORT-A', r0.commit?.status === 200 && Boolean(beat), { commit: r0.commit?.status });
rec('F-0-DOWNLOAD-A-SHA', sha(await masterBytes(beat.id)) === sha(A), {});
const replaceOp = (bytes, filename, key = crypto.randomUUID()) => req('POST', '/catalog/v1/operations', { body: { kind: 'REPLACE', beatId: beat.id, expectedVersion: beat.version, parts: [part('MASTER', bytes, filename, 'audio/mpeg')], metadata: null }, headers: { 'Idempotency-Key': key, ...E() } });
const capFor = async (opId) => (await req('POST', `/catalog/v1/operations/${opId}/parts/${encodeURIComponent('MASTER:0')}/capability`, { headers: E() })).body;
const commitUntil = async (opId) => { for (let i = 0; i < 60; i++) { const c = await req('POST', `/catalog/v1/operations/${opId}/commit`, { headers: E() }); if (c.status >= 400 || c.body?.status === 'COMMITTED') return c; await new Promise((r) => setTimeout(r, 1000)); } return { status: 0 }; };

// 1) corte de red a mitad de subida: el beat anterior queda intacto
const op1 = await replaceOp(B, 'b.mp3'); const cap1 = await capFor(op1.body.operationId);
const u = new URL(BASE.replace('/beatgaler-api', '') + cap1.uploadPath);
await new Promise((resolve) => { const rq = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': B.length, Authorization: `Bearer ${cap1.token}`, ...E(), 'X-BeatGaler-Client': 'web' } }); rq.on('error', () => resolve()); rq.on('close', () => resolve()); rq.write(B.subarray(0, 100_000)); setTimeout(() => rq.destroy(), 400); });
await new Promise((r) => setTimeout(r, 2500));
beat = await find(name);
rec('F-1-ABORTED-UPLOAD-KEEPS-A', sha(await masterBytes(beat.id)) === sha(A), { version: beat.version });
// 2) reintento de la MISMA operación completa la subida (nueva capacidad) y se publica B
const cap1b = await capFor(op1.body.operationId);
const up1 = await req('PUT', cap1b.uploadPath, { raw: B, headers: { Authorization: `Bearer ${cap1b.token}`, ...E() } });
const c1 = await commitUntil(op1.body.operationId);
beat = await find(name);
rec('F-2-RETRY-COMPLETES-REPLACE-B', up1.status < 300 && c1.body?.status === 'COMMITTED' && sha(await masterBytes(beat.id)) === sha(B), { up: up1.status, commit: c1.status });
// 3) misma Idempotency-Key = misma operación (sin duplicar)
const key = crypto.randomUUID(); const o2a = await replaceOp(C, 'c.mp3', key); const o2b = await replaceOp(C, 'c.mp3', key);
rec('F-3-IDEMPOTENT-REPLACE', o2a.body?.operationId === o2b.body?.operationId, { a: o2a.status, b: o2b.status });
const cap2 = await capFor(o2a.body.operationId); const up2 = await req('PUT', cap2.uploadPath, { raw: C, headers: { Authorization: `Bearer ${cap2.token}`, ...E() } }); const c2 = await commitUntil(o2a.body.operationId);
beat = await find(name);
rec('F-3b-REPLACE-C-SHA', up2.status < 300 && c2.body?.status === 'COMMITTED' && sha(await masterBytes(beat.id)) === sha(C), { up: up2.status, commit: c2.status });
// 4) bytes con hash distinto del declarado: rechazado, vigente intacto
const o3 = await replaceOp(B, 'bad.mp3'); const cap3 = await capFor(o3.body.operationId); const evil = Buffer.from(B); evil[1000] ^= 0xff;
const up3 = await req('PUT', cap3.uploadPath, { raw: evil, headers: { Authorization: `Bearer ${cap3.token}`, ...E() } });
beat = await find(name);
rec('F-4-HASH-MISMATCH-REJECTED', up3.status >= 400 && sha(await masterBytes(beat.id)) === sha(C), { up: up3.status, code: up3.body?.code });
// 5) versión obsoleta: otra sesión ya cambió el beat
const stale = await req('POST', '/catalog/v1/operations', { body: { kind: 'REPLACE', beatId: beat.id, expectedVersion: '1', parts: [part('MASTER', A, 'a.mp3', 'audio/mpeg')], metadata: null }, headers: { 'Idempotency-Key': crypto.randomUUID(), ...E() } });
rec('F-5-STALE-VERSION-REJECTED', stale.status === 409, { status: stale.status, code: stale.body?.code });
console.log(`SUMMARY PASS=${results.filter(Boolean).length} FAIL=${results.filter((x) => !x).length}`);
