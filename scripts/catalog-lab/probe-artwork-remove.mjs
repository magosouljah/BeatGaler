// Sonda LAB: «Remove» de portada = desvincular en PostgreSQL (decisión del propietario 2026-11-17). Chrome real + Cloud real + PostgreSQL
// efímero + gateway Telegram FAKE (Vite dev :1440). Requiere el Cloud con el servidor actual (`lab.cjs cloud-restart`).
//   node scripts/catalog-lab/probe-artwork-remove.mjs
// ADD: portada nueva por el Drawer (REPLACE ARTWORK). REMOVE: «Remove» → Drawer cerrado, tarjeta y Drawer sin portada, API artwork null.
// SQL: slot ARTWORK eliminado, versión RETIRED, objeto Telegram (media_objects/part_locations) intacto, sin borrado en el gateway.
// RELOAD: tras recargar sigue sin portada (también la copia local E66). CONFLICT: PATCH artwork:null con versión vieja → 409.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs, createRun } from './browser-common.mjs';
const require = createRequire(import.meta.url);
const { Client } = require('../../cloud-server/node_modules/pg');
const args = parseArgs();
const R = await createRun({ kind: 'artwork-remove', args });
if (!R) process.exit(0);
const { rec, ex, waitFor, login, browser, POSTGRES, cfg, sleep, finish, shot, L } = R;
const db = new Client({ connectionString: cfg.databaseUrl }); await db.connect();
const sql = async (q, p) => (await db.query(q, p)).rows;

const api = (method, path, body) => ex(async (m, p, b) => {
  const ctx = await (await fetch('/beatgaler-api/catalog/v1/context', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json();
  const r = await fetch(`/beatgaler-api${p}`, { method: m, credentials: 'include', headers: { 'X-BeatGaler-Client': 'web', 'Content-Type': 'application/json', 'X-BeatGaler-CSRF': sessionStorage.getItem('beatgaler:web-csrf:v1') || '', 'X-Catalog-Era': ctx.authority_era, 'X-Catalog-Epoch': ctx.authority_epoch, 'Idempotency-Key': crypto.randomUUID() }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}, method, path, body ?? null);
const getBeat = async (id) => (await api('GET', `/catalog/v1/beats/${encodeURIComponent(id)}`)).body;
const openEdit = async (id) => {
  await ex((i) => { const c = document.querySelector(`[data-card="${i}"] [data-beat-card-id]`) || document.querySelector(`[data-card="${i}"]`); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 })); }, id);
  await sleep(300);
  await ex(() => { [...document.querySelectorAll('button, div, span')].find((x) => (x.textContent || '').trim() === 'Edit metadata')?.click(); });
  return waitFor(async () => drawerOpen(), { timeout: 10000, msg: 'edit drawer' });
};
const drawerOpen = () => ex(() => document.body.innerText.includes('Files stay pending until Save Changes'));
const clickSave = () => ex(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('Save changes') && !x.disabled); b?.click(); return Boolean(b); });
const cardHasArtwork = (id) => ex((i) => { const c = document.querySelector(`[data-card="${i}"]`); if (!c) return null; return Boolean(c.querySelector('img[src^="blob:"]')) || [...c.querySelectorAll('*')].some((e) => getComputedStyle(e).backgroundImage.includes('blob:')); }, id);
const idbHasArtwork = (id) => ex(async (i) => new Promise((res) => { const q = indexedDB.open('beatgaler-catalog-first-block'); q.onerror = () => res('no-db'); q.onsuccess = () => { const d = q.result; if (!d.objectStoreNames.contains('entries')) { d.close(); res('no-store'); return; } const g = d.transaction('entries').objectStore('entries').getAll(); g.onsuccess = () => { d.close(); const items = g.result.flatMap((e) => e.page.items).filter((x) => x.id === i); res(items.length ? items.some((x) => x.artwork) : 'absent'); }; }; }), id);
const sqlState = async (uid, beatId, fileId) => ({
  slot: (await sql("SELECT file_id FROM catalog_current_files WHERE user_id = $1 AND beat_id = $2 AND slot_key = 'ARTWORK'", [uid, beatId])).map((r) => r.file_id),
  version: (await sql('SELECT status, retained_until IS NOT NULL AS retained FROM catalog_file_versions WHERE user_id = $1 AND file_id = $2', [uid, fileId]))[0] ?? null,
  objects: await sql(`SELECT m.object_id, m.status, m.chat_id::text, m.message_id::text FROM catalog_part_locations l JOIN catalog_media_objects m ON m.user_id = l.user_id AND m.object_id = l.object_id WHERE l.user_id = $1 AND l.file_id = $2 ORDER BY m.object_id`, [uid, fileId]),
  hasArtworkCol: (await sql('SELECT has_artwork FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [uid, beatId]))[0]?.has_artwork ?? null,
});

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await ex(() => document.querySelectorAll('[data-card]').length)) > 2, { timeout: 90000, msg: 'cards' });
  await sleep(600);
  const uid = (await api('GET', '/catalog/v1/context')).body.user_id;
  const id = await ex(() => document.querySelectorAll('[data-card]')[2].getAttribute('data-card'));

  // ADD
  await openEdit(id);
  await ex(() => (async () => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); const inp = document.querySelector('input[type=file][accept^="image"]'); const dt = new DataTransfer(); dt.items.add(new File([png], 'cover.png', { type: 'image/png' })); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); })());
  await waitFor(async () => ex(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Apply crop')), { timeout: 15000, msg: 'crop' });
  await sleep(400); await ex(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apply crop').click());
  await waitFor(async () => ex(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Remove')), { timeout: 15000, msg: 'cover set' });
  const b0 = await getBeat(id); await clickSave();
  await waitFor(async () => !(await drawerOpen()), { timeout: 30000, msg: 'drawer closes (add)' });
  const b1 = await getBeat(id);
  const fileId = b1.artwork?.fileId ?? null;
  const cardAfterAdd = await waitFor(async () => (await cardHasArtwork(id)) ? true : null, { timeout: 20000, msg: 'card shows cover' }).catch(() => false);
  const sql1 = fileId ? await sqlState(uid, id, fileId) : null;
  rec('ADD', Boolean(fileId) && b1.hasArtwork && Number(b1.version) === Number(b0.version) + 1 && cardAfterAdd && sql1?.slot[0] === fileId && sql1.version?.status === 'VERIFIED' && sql1.objects.length > 0 ? 'PASS' : 'FAIL', { beat: id, fileId, version: [b0.version, b1.version], cardAfterAdd, sql: sql1 });
  await sleep(800);

  // REMOVE (Drawer)
  await openEdit(id);
  await waitFor(async () => ex(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Remove')), { timeout: 20000, msg: 'cover visible in drawer' });
  await ex(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove').click()); await sleep(200);
  await clickSave();
  const closed = await waitFor(async () => !(await drawerOpen()), { timeout: 30000, msg: 'drawer closes (remove)' }).catch(() => false);
  const b2 = await getBeat(id);
  const cardGone = await waitFor(async () => (await cardHasArtwork(id)) === false ? true : null, { timeout: 15000, msg: 'card without cover' }).catch(() => false);
  await openEdit(id); await sleep(800);
  const drawerNoCover = await ex(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Add cover') && ![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Remove'));
  await browser.keys(['Escape']); await sleep(400);
  const sql2 = await sqlState(uid, id, fileId);
  await shot('after-remove');
  const sameObjects = JSON.stringify(sql2.objects) === JSON.stringify(sql1.objects.map((o) => o)) && sql2.objects.every((o) => o.status === 'PRESENT');
  rec('REMOVE', closed && b2.artwork === null && b2.hasArtwork === false && Number(b2.version) === Number(b1.version) + 1 && cardGone && drawerNoCover ? 'PASS' : 'FAIL', { closed, apiArtwork: b2.artwork, hasArtwork: b2.hasArtwork, version: [b1.version, b2.version], cardGone, drawerNoCover });
  rec('ORIGINAL-KEPT', sql2.slot.length === 0 && sql2.version?.status === 'RETIRED' && sameObjects ? 'PASS' : 'FAIL', { before: sql1, after: sql2 });
  const logPath = `${L.STATE_DIR}/cloud.log`; const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  rec('NO-PROVIDER-DELETE', !/deleteMessage|delete_message/i.test(log.split('cloud-restart').pop() || '') ? 'PASS' : 'FAIL', { logChecked: Boolean(log) });

  // RELOAD (Gallery + copia local E66)
  await browser.url(`${POSTGRES}/gallery`);
  await waitFor(async () => ex(() => !document.querySelector('[data-catalog-provisional="true"]') && document.querySelector('[data-store-status="ready"]') && document.querySelectorAll('[data-card]').length > 2), { timeout: 60000, msg: 'reloaded' });
  await sleep(2500);
  const b3 = await getBeat(id);
  rec('RELOAD', b3.artwork === null && (await cardHasArtwork(id)) === false && (await idbHasArtwork(id)) !== true ? 'PASS' : 'FAIL', { apiArtwork: b3.artwork, card: await cardHasArtwork(id), idb: await idbHasArtwork(id) });

  // CONFLICT: versión vieja → 409; no-op cuando ya no hay portada
  const stale = await api('PATCH', `/catalog/v1/beats/${encodeURIComponent(id)}`, { expectedVersion: b1.version, patch: { artwork: null } });
  const noop = await api('PATCH', `/catalog/v1/beats/${encodeURIComponent(id)}`, { expectedVersion: b3.version, patch: { artwork: null } });
  const bulk = await api('POST', '/catalog/v1/operations', { kind: 'BULK_PATCH', selectionId: 'x', selectionVersion: '1', patch: { artwork: null } });
  rec('CONFLICT-NOOP-BULK', stale.status === 409 && stale.body?.code === 'VERSION_CONFLICT' && noop.status === 200 && noop.body?.noop === true && bulk.status === 400 ? 'PASS' : 'FAIL', { stale: [stale.status, stale.body?.code], noop: [noop.status, noop.body?.noop], bulk: [bulk.status, bulk.body?.code] });
} catch (e) { rec('ERROR-RUN', 'FAIL', { message: String(e.message).slice(0, 400) }); await shot('error'); }
await db.end();
await finish();
