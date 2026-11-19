'use strict';
// E77 — Experimento REAL (sandbox T11 autorizado): ¿puede continuarse una subida por partes con OTRA clave de autorización del mismo bot?
// Sube un archivo de prueba por partes (upload.saveBigFilePart) repartidas entre dos sesiones MTProto independientes del bot (claves de
// autorización distintas) y lo publica con messages.sendMedia. Variantes: CONTROL (todo con A), CROSS (mitad A, mitad B, envía B) y HANDOFF (todas
// las partes con A, envía B). Solo crea mensajes de prueba marcados `catalog:v1 op=e77-resume-… part=probe`; no borra ni rota nada.
// Alcance de la evidencia: claves PERMANENTES distintas del mismo bot (caso más estricto que dos claves temporales vinculadas a la misma permanente).
//   BEATGALER_T11_SANDBOX_APPROVAL=<id> node scripts/catalog-lab/real-resume-probe.cjs <descriptor.json>
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const S = require('../catalog-transport-sandbox.cjs');
const { createRealDeps } = require('../catalog-transport-sandbox-real.cjs');
const CLOUD = path.resolve(__dirname, '..', '..', 'cloud-server');
const { Api } = require(path.join(CLOUD, 'node_modules', 'telegram'));
const bigInt = require(path.join(CLOUD, 'node_modules', 'big-integer'));

const PART = 512 * 1024; const PARTS = 21; // 10,5 MiB: por encima del umbral de «archivo grande»
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const errCode = (e) => String((e && (e.errorMessage || e.code || e.message)) || e).replace(S.TOKEN_RE, '<redacted>').slice(0, 120);

(async () => {
  const d = S.loadDescriptor(process.argv[2], { env: process.env, execute: true });
  const out = path.resolve(__dirname, '..', '..', 'tmp', 't11b', 'resume-e77'); fs.mkdirSync(out, { recursive: true });
  const deps = await createRealDeps(d, { outDir: out, runId: 'resume' });
  const report = { scope: 'E77-RESUME', approvalId: d.approvalId, startedAt: new Date().toISOString(), evidence: 'PROVIDER_SANDBOX', partBytes: PART, parts: PARTS, variants: {} };
  try {
    report.preflight = await S.preflight(d, deps); // identidad y aislamiento ANTES de cualquier escritura
    const chatId = d.chats[0];
    const a = await deps.openBot(); const b = await deps.openBot(); // dos sesiones: claves de autorización distintas
    const peerOf = async (c) => (await deps.resolvePeer(c, chatId)).peer;
    const data = crypto.randomBytes(PART * PARTS); report.fileSha256 = sha(data);
    const savePart = (client, fileId, i) => client.invoke(new Api.upload.SaveBigFilePart({ fileId, filePart: i, fileTotalParts: PARTS, bytes: data.subarray(i * PART, (i + 1) * PART) }));
    const send = async (client, fileId, name) => {
      const res = await client.invoke(new Api.messages.SendMedia({ peer: await peerOf(client), media: new Api.InputMediaUploadedDocument({ file: new Api.InputFileBig({ id: fileId, parts: PARTS, name: `${name}.bin` }), mimeType: 'application/octet-stream', attributes: [new Api.DocumentAttributeFilename({ fileName: `${name}.bin` })], forceFile: true }), message: `catalog:v1 op=e77-resume-${name} part=probe`, randomId: bigInt(crypto.randomBytes(7).toString('hex'), 16), silent: true }));
      const upd = (res.updates || []).find((u) => u.message && u.message.media && u.message.media.document);
      return upd ? { messageId: Number(upd.message.id), size: Number(upd.message.media.document.size), media: upd.message.media } : { messageId: null };
    };
    const download = async (client, media) => { const h = crypto.createHash('sha256'); let n = 0; for await (const c of client.iterDownload({ file: media, requestSize: PART })) { h.update(c); n += c.length; } return { size: n, sha256: h.digest('hex') }; };
    async function variant(name, plan) {
      const v = { uploadedBy: Array.from({ length: PARTS }, (_, i) => plan(i)).join(''), sentBy: plan.sender }; const fileId = bigInt(crypto.randomBytes(7).toString('hex'), 16); const t0 = Date.now();
      try {
        for (let i = 0; i < PARTS; i++) { const who = plan(i); const ok = await savePart(who === 'A' ? a.client : b.client, fileId, i); if (ok !== true && !(ok && ok.className === 'BoolTrue')) { /* gramjs devuelve true */ } }
        v.uploadMs = Date.now() - t0;
        const sent = await send(plan.sender === 'A' ? a.client : b.client, fileId, name.toLowerCase());
        v.messageId = sent.messageId; v.size = sent.size ?? null;
        if (sent.media) { const got = await download(b.client, sent.media); v.downloaded = got.size; v.intact = got.size === data.length && got.sha256 === report.fileSha256; }
        v.result = sent.messageId && v.intact ? 'PUBLISHED_INTACT' : sent.messageId ? 'PUBLISHED_UNVERIFIED' : 'NO_MESSAGE';
      } catch (e) { v.result = 'REJECTED'; v.error = errCode(e); }
      report.variants[name] = v; console.log(name, JSON.stringify(v));
    }
    const mk = (fn, sender) => Object.assign(fn, { sender });
    await variant('CONTROL', mk(() => 'A', 'A'));
    await variant('CROSS', mk((i) => (i < Math.floor(PARTS / 2) ? 'A' : 'B'), 'B'));
    await variant('HANDOFF', mk(() => 'A', 'B'));
  } catch (e) { report.aborted = errCode(e); console.error('ABORTADO', report.aborted); }
  finally { await deps.close().catch(() => {}); }
  report.finishedAt = new Date().toISOString();
  const text = JSON.stringify(report, null, 2);
  for (const secret of deps.secrets()) if (secret && text.includes(secret)) throw new Error('STOP: el informe contiene un secreto');
  fs.writeFileSync(path.join(out, 'report.json'), text); console.log('informe=' + path.join(out, 'report.json'));
})().catch((e) => { console.error('FALLO', errCode(e)); process.exit(1); });
