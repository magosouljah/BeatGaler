// Sonda LAB (Chrome real, IndexedDB real): casos funcionales de la copia local del primer bloque (arranque rápido, opción A 2026-11-17).
//   node scripts/catalog-lab/probe-first-block-cases.mjs [--base http://127.0.0.1:1442]
// FIRST (primera visita), NEXT (visita posterior provisional + 1 sola carga), LOCKED (sin interacción hasta revalidar), STALE (datos
// cambiados fuera de la página → se muestran los de PostgreSQL), ERROR (revalidación fallida → se retira la copia), ACCOUNT (otra cuenta
// nunca ve la copia ajena), QUOTA (almacenamiento lleno → sin copia y Gallery normal). Gateway FAKE: no es evidencia de proveedor.
import { parseArgs, createRun } from './browser-common.mjs';

const args = parseArgs();
const opt = (k, d) => { const i = args.rest.indexOf(k); return i >= 0 ? args.rest[i + 1] : d; };
const R = await createRun({ kind: 'first-block-cases', args });
if (!R) process.exit(0);
const { rec, ex, waitFor, login, logout, browser, POSTGRES, cfg, sleep, finish, cdp, shot, typeSearch, audioState } = R;
const BASE = opt('--base', POSTGRES);
const ORIGIN = new URL(BASE).origin;
const DB = 'beatgaler-catalog-first-block';

await browser.scriptAddPreloadScript({ functionDeclaration: `() => {
  window.__fc = { provisionalSeen: false, firstCardIds: null, errors: [] };
  addEventListener('error', (e) => window.__fc.errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => window.__fc.errors.push(String(e.reason && e.reason.message || e.reason)));
  new MutationObserver(() => {
    if (document.querySelector('[data-catalog-provisional="true"]')) {
      window.__fc.provisionalSeen = true;
      if (!window.__fc.firstCardIds) window.__fc.firstCardIds = [...document.querySelectorAll('[data-card]')].slice(0, 12).map((c) => c.getAttribute('data-card'));
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-catalog-provisional'] });
  if (sessionStorage.getItem('__fcQuota') === '1') {
    // Almacenamiento lleno EMULADO a nivel de API (respaldo cuando la cuota CDP no se aplica): put() lanza QuotaExceededError.
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) { if (this.transaction.db.name === 'beatgaler-catalog-first-block') throw new DOMException('LAB: storage full', 'QuotaExceededError'); return put.apply(this, a); };
  }
  const mode = sessionStorage.getItem('__fcBeats') || '';
  const of = window.fetch.bind(window);
  window.__fc.beatsCalls = 0;
  window.fetch = async (...a) => {
    const u = String(a[0]?.url ?? a[0]);
    if (/\\/catalog\\/v1\\/beats\\?/.test(u)) {
      window.__fc.beatsCalls++;
      if (mode.startsWith('hold:') || mode.startsWith('holdfail:')) await new Promise((r) => setTimeout(r, Number(mode.split(':')[1])));
      if (mode === 'fail' || mode.startsWith('holdfail:')) throw new TypeError('Failed to fetch (LAB)');
    }
    return of(...a);
  };
}` });

const setBeats = (m) => ex((v) => sessionStorage.setItem('__fcBeats', v), m);
const idbEntries = () => ex(async (db) => new Promise((res) => {
  const q = indexedDB.open(db); q.onerror = () => res({ error: String(q.error) });
  q.onsuccess = () => { const d = q.result; if (!d.objectStoreNames.contains('entries')) { d.close(); res([]); return; } const g = d.transaction('entries').objectStore('entries').getAll(); g.onsuccess = () => { d.close(); res(g.result.map((e) => ({ accountId: e.accountId, epoch: e.epoch, queryKey: e.queryKey, revision: e.revision, n: e.page.items.length, firstIds: e.page.items.slice(0, 12).map((i) => i.id), firstNames: e.page.items.slice(0, 3).map((i) => i.name) }))); }; g.onerror = () => { d.close(); res({ error: String(g.error) }); }; };
}), DB);
const dropIdb = () => ex(async (db) => new Promise((r) => { const q = indexedDB.deleteDatabase(db); q.onsuccess = q.onerror = q.onblocked = () => r(null); }), DB);
const state = () => ex(() => ({
  provisionalNow: Boolean(document.querySelector('[data-catalog-provisional="true"]')), inert: Boolean(document.querySelector('[data-catalog-mode="postgres"][inert]')),
  provisionalSeen: window.__fc.provisionalSeen, provisionalIds: window.__fc.firstCardIds, beatsCalls: window.__fc.beatsCalls, errors: window.__fc.errors,
  storeStatus: document.querySelector('[data-store-status]')?.getAttribute('data-store-status') ?? null, composition: document.querySelector('[data-library-composition]')?.getAttribute('data-library-composition') ?? null,
  ids: [...document.querySelectorAll('[data-card]')].slice(0, 12).map((c) => c.getAttribute('data-card')), names: [...document.querySelectorAll('[data-card] [data-beat-card-id]')].slice(0, 3).map((c) => c.textContent.slice(0, 60)),
  account: document.querySelector('[data-account]')?.getAttribute('data-account') ?? null,
}));
const reload = async ({ until = 'ready' } = {}) => {
  await browser.url(`${BASE}/gallery`);
  return waitFor(async () => { const s = await state(); if (until === 'ready') return !s.provisionalNow && s.storeStatus === 'ready' && s.ids.length ? s : null; if (until === 'provisional') return s.provisionalNow && s.ids.length ? s : null; return s.storeStatus && s.storeStatus !== 'ready' && !s.provisionalNow ? s : null; }, { timeout: 60000, msg: `gallery ${until}` });
};
// Primer bloque vigente según PostgreSQL (misma consulta por defecto), leído desde la página con su sesión.
const serverFirst = () => ex(async () => { const r = await fetch('/beatgaler-api/catalog/v1/beats?state=ACTIVE&sort=rating&limit=240&includeTotal=true', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); const j = await r.json(); return { status: r.status, ids: (j.items || []).slice(0, 12).map((i) => i.id), first: j.items?.[0] ? { id: j.items[0].id, name: j.items[0].name, version: j.items[0].version } : null, revision: j.revision }; });

try {
  await login(BASE, cfg.account);
  await waitFor(async () => (await state()).ids.length > 0, { timeout: 90000, msg: 'cards after login' });
  await setBeats('');

  // FIRST: sin copia → carga normal (nunca provisional) y al terminar queda exactamente 1 copia de esta cuenta.
  await dropIdb();
  const f = await reload(); await sleep(500); const e1 = await idbEntries();
  rec('FIRST', !f.provisionalSeen && f.beatsCalls === 1 && Array.isArray(e1) && e1.length === 1 && e1[0].n > 0 && e1[0].accountId === f.account ? 'PASS' : 'FAIL', { provisionalSeen: f.provisionalSeen, beatsCalls: f.beatsCalls, entries: e1 });
  const accountA = f.account;

  // NEXT: visita posterior → provisional con los mismos IDs de la copia, 1 sola carga de /beats y estado final vigente.
  const n = await reload();
  rec('NEXT', n.provisionalSeen && n.beatsCalls === 1 && JSON.stringify(n.provisionalIds) === JSON.stringify(e1[0].firstIds) && JSON.stringify(n.ids) === JSON.stringify((await serverFirst()).ids) && n.errors.length === 0 ? 'PASS' : 'FAIL', { provisionalIds: n.provisionalIds?.length, beatsCalls: n.beatsCalls, errors: n.errors });

  // LOCKED: /beats retenido 4 s → shell inerte: un clic real (CDP, sin esperas de WebDriver) sobre la portada no reproduce ni abre nada y
  // los botones no reciben foco; al revalidar se libera y el foco vuelve a funcionar.
  await setBeats('hold:4000');
  const l0 = await reload({ until: 'provisional' });
  const pt = await ex(() => { const el = document.querySelector('[data-card] [data-beat-artwork-id]') || document.querySelector('[data-card]'); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, hit: hit ? `${hit.tagName}#${hit.id}.${String(hit.className).slice(0, 60)}` : null, hitInsideInert: Boolean(hit && hit.closest('[inert]')) }; });
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  const focusTry = await ex(() => { const b = document.querySelector('[data-card] button'); if (!b) return null; b.focus(); return document.activeElement === b; });
  await sleep(500);
  const l1 = await ex(() => ({ drawer: Boolean(document.querySelector('.bg-drawer, [data-drawer]')), provisional: Boolean(document.querySelector('[data-catalog-provisional="true"]')), playback: document.querySelector('[data-playback-status]')?.getAttribute('data-playback-status') ?? null }));
  const audio1 = await audioState();
  await shot('locked-provisional');
  const l2 = await waitFor(async () => { const s = await state(); return !s.provisionalNow && s.storeStatus === 'ready' ? s : null; }, { timeout: 20000, msg: 'released' });
  const focusAfter = await ex(() => { const b = document.querySelector('[data-card] button'); if (!b) return null; b.focus(); const ok = document.activeElement === b; b.blur(); return ok; });
  rec('LOCKED', l0.inert && l1.provisional && !l1.drawer && !(audio1[0] && !audio1[0].paused) && focusTry === false && !l2.inert && focusAfter === true ? 'PASS' : 'FAIL', { inertDuringProvisional: l0.inert, point: pt, afterClick: l1, audio: audio1, focusDuringProvisional: focusTry, inertAfter: l2.inert, focusAfter });
  await setBeats('');

  // STALE: se renombra el primer beat FUERA de la Gallery (fetch directo, la copia no se entera) → la copia se ve un instante y luego el dato de PostgreSQL.
  await reload(); const before = await idbEntries(); const sf = await serverFirst();
  const newName = `Stale probe ${Date.now() % 100000}`;
  const patched = await ex(async (beat, name) => {
    const ctx = await (await fetch('/beatgaler-api/catalog/v1/context', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json();
    const r = await fetch(`/beatgaler-api/catalog/v1/beats/${encodeURIComponent(beat.id)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web', 'X-BeatGaler-CSRF': sessionStorage.getItem('beatgaler:web-csrf:v1') || '', 'X-Catalog-Era': ctx.authority_era, 'X-Catalog-Epoch': ctx.authority_epoch, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: beat.version, patch: { name } }) });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  }, sf.first, newName);
  const s1 = await reload(); await sleep(500); const after = await idbEntries();
  const cardName = await ex((id) => document.querySelector(`[data-card="${id}"]`)?.textContent ?? '', sf.first.id);
  rec('STALE', patched.status < 300 && s1.provisionalSeen && cardName.includes(newName) && before[0].revision !== after[0].revision && after[0].firstNames.includes(newName) ? 'PASS' : 'FAIL', { patched, provisionalSeen: s1.provisionalSeen, cardShowsNewName: cardName.includes(newName), cacheRevision: [before[0]?.revision, after[0]?.revision] });
  // restaurar el nombre (beat de prueba del LAB)
  const restored = await ex(async (beat) => { const cur = await (await fetch(`/beatgaler-api/catalog/v1/beats/${encodeURIComponent(beat.id)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json(); const ctx = await (await fetch('/beatgaler-api/catalog/v1/context', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json(); const r = await fetch(`/beatgaler-api/catalog/v1/beats/${encodeURIComponent(beat.id)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web', 'X-BeatGaler-CSRF': sessionStorage.getItem('beatgaler:web-csrf:v1') || '', 'X-Catalog-Era': ctx.authority_era, 'X-Catalog-Epoch': ctx.authority_epoch, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: cur.version, patch: { name: beat.name } }) }); return r.status; }, sf.first);
  rec('STALE-RESTORE', restored < 300 ? 'INFO' : 'FAIL', { restored });

  // ERROR: la revalidación falla (red) → se retira la copia; estado normal de error, sin tarjetas no confirmadas ni excepciones.
  // a) fallo inmediato: la revalidación (lanzada al sembrar) falla antes del primer render → la copia ni siquiera se muestra.
  await setBeats('fail');
  const ei = await reload({ until: 'error' });
  rec('ERROR-IMMEDIATE', !ei.provisionalNow && ei.ids.length === 0 && ['offline', 'error'].includes(ei.storeStatus) && ei.errors.length === 0 ? 'PASS' : 'FAIL', { provisionalSeen: ei.provisionalSeen, storeStatus: ei.storeStatus, cards: ei.ids.length, errors: ei.errors });
  // b) fallo tras 1,5 s: la copia se ve (inerte) y después se retira.
  await setBeats('holdfail:1500');
  const er = await reload({ until: 'error' }); await shot('revalidation-error');
  rec('ERROR', er.provisionalSeen && !er.provisionalNow && er.ids.length === 0 && ['offline', 'error'].includes(er.storeStatus) && er.errors.length === 0 ? 'PASS' : 'FAIL', { storeStatus: er.storeStatus, cards: er.ids.length, errors: er.errors });
  await setBeats('');
  await reload();

  // ACCOUNT: la cuenta B (mismo navegador, misma IndexedDB con la copia de A) nunca ve la copia de A; luego A vuelve a usar la suya.
  const idsA = (await idbEntries()).find((e) => e.accountId === accountA)?.firstIds ?? [];
  await logout(); await login(BASE, cfg.accountB);
  const b = await waitFor(async () => { const s = await state(); return s.account && s.account !== accountA && s.storeStatus && !s.provisionalNow ? s : null; }, { timeout: 60000, msg: 'account B gallery' });
  const bReload = await reload({ until: b.ids.length ? 'ready' : 'any' }).catch(async () => state());
  const entriesAB = await idbEntries();
  rec('ACCOUNT-B', !b.provisionalSeen && !(b.provisionalIds || []).some((id) => idsA.includes(id)) && !b.ids.some((id) => idsA.includes(id)) && entriesAB.some((e) => e.accountId === accountA) ? 'PASS' : 'FAIL', { accountB: b.account, provisionalSeenB: b.provisionalSeen, cardsB: b.ids.length, overlapWithA: b.ids.filter((id) => idsA.includes(id)).length, secondVisitB: { provisionalSeen: bReload.provisionalSeen }, accounts: entriesAB.map((e) => e.accountId) });
  await logout(); await login(BASE, cfg.account);
  const a2 = await reload();
  rec('ACCOUNT-A-AGAIN', a2.account === accountA && a2.provisionalSeen && JSON.stringify(a2.provisionalIds) === JSON.stringify(idsA) ? 'PASS' : 'FAIL', { provisionalSeen: a2.provisionalSeen });

  // QUOTA: 1º cuota CDP (sin recargar: Chrome la descarta al navegar) con escritura de control; si no se aplica, respaldo EMULADO por API
  // (put() → QuotaExceededError) con recargas. Esperado: error tratado, sin copia nueva, Gallery normal y sin excepciones.
  const eBefore = await idbEntries();
  await cdp('Storage.overrideQuotaForOrigin', { origin: ORIGIN, quotaSize: 1024 });
  const canary = await ex(async () => new Promise((res) => { const q = indexedDB.open('fc-quota-probe', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => { const t = q.result.transaction('s', 'readwrite'); t.objectStore('s').put('x'.repeat(200000), 'k'); t.oncomplete = () => { q.result.close(); res('ok'); }; t.onabort = () => { q.result.close(); res(`abort ${t.error && t.error.name}`); }; }; q.onerror = () => res('openerr'); }));
  const cdpQuota = canary.startsWith('abort QuotaExceeded');
  if (cdpQuota) {
    await typeSearch('Beat'); await sleep(2500);
    const qs = await state(); const eq = await idbEntries();
    rec('QUOTA', Array.isArray(eq) && !eq.some((e) => e.queryKey.includes('"q":"beat"')) && qs.ids.length > 0 && qs.errors.length === 0 && qs.storeStatus === 'ready' ? 'PASS' : 'FAIL', { method: 'CDP Storage.overrideQuotaForOrigin', canary, entriesBefore: eBefore.length, entriesAfter: Array.isArray(eq) ? eq.map((e) => e.queryKey) : eq, cards: qs.ids.length, errors: qs.errors });
  }
  await cdp('Storage.overrideQuotaForOrigin', { origin: ORIGIN });
  await ex(() => new Promise((r) => { const q = indexedDB.deleteDatabase('fc-quota-probe'); q.onsuccess = q.onerror = q.onblocked = () => r(null); }));
  if (!cdpQuota) {
    await dropIdb(); await ex(() => sessionStorage.setItem('__fcQuota', '1'));
    const q1 = await reload(); await sleep(600); const eq1 = await idbEntries(); const q2 = await reload(); await sleep(300);
    rec('QUOTA', !q1.provisionalSeen && !q2.provisionalSeen && q2.ids.length > 0 && q1.errors.length === 0 && q2.errors.length === 0 && Array.isArray(eq1) && eq1.length === 0 ? 'PASS' : 'FAIL', { method: 'EMULADO: IDBObjectStore.put → QuotaExceededError (cuota CDP no aplicada)', canary, entries: eq1, provisionalSeen: [q1.provisionalSeen, q2.provisionalSeen], errors: [...q1.errors, ...q2.errors], cards: q2.ids.length });
    await ex(() => sessionStorage.removeItem('__fcQuota'));
  }
  // Recuperación: sin cuota emulada, la primera visita vuelve a guardar y la siguiente vuelve a ser provisional.
  const q3 = await reload(); await sleep(500); const q4 = await reload(); const er2 = await idbEntries();
  rec('QUOTA-RECOVER', Array.isArray(er2) && er2.length >= 1 && q4.provisionalSeen ? 'PASS' : 'FAIL', { entries: Array.isArray(er2) ? er2.length : er2, firstAfter: q3.provisionalSeen, secondAfter: q4.provisionalSeen });
} catch (e) { rec('ERROR-RUN', 'FAIL', { message: String(e.message).slice(0, 400) }); }
await ex(() => sessionStorage.removeItem('__fcBeats')).catch(() => {});
await finish();
