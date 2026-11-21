// Sonda LAB (§6.1-4): «Vaciar papelera» con la postura por defecto de una biblioteca nativa (`restore_hold` / `cleanup_enabled=false`).
// Crea un beat DESECHABLE propio (importación con bytes sintéticos), lo envía a la papelera y pide la purga SOLO de ese beat; observa el
// estado de la purga, del beat, de la papelera y de los contadores. Con hold/cleanup apagados el servidor no borra nada (gateway FAKE del LAB).
//   node scripts/catalog-lab/probe-purge-hold.mjs
import fs from 'node:fs'; import crypto from 'node:crypto'; import { execFileSync } from 'node:child_process';
const cfg = JSON.parse(fs.readFileSync(`${process.env.LAB_STATE_DIR || 'E:/777/app/BeatGaler/tmp/catalog-lab/state'}/lab.env.json`, 'utf8'));
const BASE = `http://127.0.0.1:${cfg.ports.webPostgres}/beatgaler-api`;
const jar = new Map(); let csrf = ''; let era = ''; let epoch = '';
const H = (extra = {}) => ({ 'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(csrf ? { 'X-BeatGaler-CSRF': csrf } : {}), ...(era ? { 'X-Catalog-Era': era, 'X-Catalog-Epoch': epoch } : {}), ...extra });
async function req(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, { method, headers: H(headers), body: body ? JSON.stringify(body) : undefined });
  for (const c of r.headers.getSetCookie?.() ?? []) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
const name = `Purge probe ${Date.now() % 100000}`;
execFileSync(process.execPath, ['scripts/catalog-lab/bump-revision.mjs'], { env: { ...process.env, NAME: name }, stdio: 'ignore' });
const login = await req('POST', '/auth/login', { email: cfg.account.email, password: cfg.account.password, mfaCode: '', beatgalerUserId: 'lab-probe-install' });
csrf = login.body?.csrf_token || '';
const ctx0 = (await req('GET', '/catalog/v1/context')).body; era = ctx0.authority_era; epoch = ctx0.authority_epoch;
const find = async (state) => ((await req('GET', `/catalog/v1/beats?state=${state}&sort=name&limit=240&q=${encodeURIComponent(name)}`)).body.items || []).find((b) => b.name === name) || null;
const beat = await find('ACTIVE'); if (!beat) { console.log(JSON.stringify({ error: 'probe beat not imported' })); process.exit(1); }
const trash = await req('POST', '/catalog/v1/beats/trash', { items: [{ beatId: beat.id, expectedVersion: beat.version }] }, { 'Idempotency-Key': crypto.randomUUID() });
const inTrashBefore = Boolean(await find('TRASH'));
const purge = await req('POST', '/catalog/v1/operations', { kind: 'PURGE', beatIds: [beat.id] }, { 'Idempotency-Key': crypto.randomUUID() });
let op = purge.body; const seen = [op.status];
for (let i = 0; i < 40 && !['PURGED', 'PARTIAL', 'BLOCKED', 'CANCELLED'].includes(op.status); i++) { await new Promise((r) => setTimeout(r, 750)); op = (await req('GET', `/catalog/v1/operations/${op.operationId}`)).body; if (seen[seen.length - 1] !== op.status) seen.push(op.status); }
const detail = await req('GET', `/catalog/v1/beats/${beat.id}`);
const ctx1 = (await req('GET', '/catalog/v1/context')).body;
const restore = await req('POST', '/catalog/v1/beats/restore', { items: [{ beatId: beat.id, expectedVersion: String(detail.body?.version ?? beat.version) }] }, { 'Idempotency-Key': crypto.randomUUID() });
console.log(JSON.stringify({
  library: { restore_hold: ctx0.restore_hold, cleanup_enabled: ctx0.cleanup_enabled },
  beat: { id: beat.id, name }, trashStatus: trash.status, inTrashBefore,
  purge: { status: purge.status, statusesSeen: seen, final: op.status, items: op.items ?? op.itemCounts ?? null, blockedItems: op.blockedItems ?? op.blocked_items ?? null, purgedItems: op.purgedItems ?? op.purged_items ?? null, blockReasons: op.blockReasons ?? null },
  afterPurge: { beatState: detail.body?.state ?? detail.status, inTrashList: Boolean(await find('TRASH')), counts: ctx1.counts, countsBefore: ctx0.counts },
  restoreAttempt: { status: restore.status, code: restore.body?.code ?? null },
}, null, 1));
