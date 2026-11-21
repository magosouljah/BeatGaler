// Sonda LAB: tiempo hasta la primera tarjeta de la Gallery POSTGRES (Cloud real + gateway FAKE + PostgreSQL efímero).
//   node scripts/catalog-lab/probe-first-card.mjs [--label X] [--reloads 8] [--base http://127.0.0.1:1442] [--modes idb,noidb] [--latency 0,150] [--api-delay 0]
// Mide, desde el inicio de navegación (performance.now() = 0): fin de /auth de sesión, /catalog/v1/context, primer /catalog/v1/beats,
// primera [data-card] pintada y momento en que la Gallery queda interactiva (sin `data-catalog-provisional` y store `ready`).
//   --modes     idb = IndexedDB disponible (copia local de arranque); noidb = IndexedDB oculto → ruta de arranque anterior exacta.
//               Los modos se INTERCALAN por recarga (comparación pareada bajo las mismas condiciones).
//   --latency   RTT EMULADO por CDP (Network.emulateNetworkConditions) para TODAS las peticiones; loopback no tiene RTT real.
//   --api-delay retardo EMULADO en el hilo principal antes de cada fetch a /beatgaler-api/ (pesimista: compite con el render).
//   --first-visit borra la base IndexedDB antes de cada recarga en modo idb (mide «primera visita»).
import { parseArgs, createRun } from './browser-common.mjs';

const args = parseArgs();
const opt = (k, d) => { const i = args.rest.indexOf(k); return i >= 0 ? args.rest[i + 1] : d; };
const reloads = Number(opt('--reloads', '8'));
const latencies = String(opt('--latency', '0')).split(',').map(Number);
const apiDelay = Number(opt('--api-delay', '0'));
const modes = String(opt('--modes', 'idb,noidb')).split(',');
const firstVisit = args.rest.includes('--first-visit');
const label = opt('--label', 'run');
const R = await createRun({ kind: `first-card-${label}`, args });
if (!R) process.exit(0);
const { rec, ex, waitFor, login, browser, POSTGRES, cfg, sleep, finish, cdp } = R;
const BASE = opt('--base', POSTGRES);

// Preload (antes de cualquier script): buffer de resource timing amplio, marcas de primera tarjeta / interactiva, IndexedDB oculto en modo
// noidb y retardo emulado opcional (ambos leídos de sessionStorage, persistente entre recargas de la pestaña).
await browser.scriptAddPreloadScript({ functionDeclaration: `() => {
  try { performance.setResourceTimingBufferSize(20000); } catch {}
  window.__fcRealIdb = window.indexedDB;
  if (sessionStorage.getItem('__fcNoIdb') === '1') { try { Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }); } catch {} }
  window.__fc = { firstCard: null, interactive: null, provisionalSeen: false };
  const check = () => {
    const card = document.querySelector('[data-card]');
    if (card && window.__fc.firstCard === null) window.__fc.firstCard = performance.now();
    if (document.querySelector('[data-catalog-provisional="true"]')) window.__fc.provisionalSeen = true;
    if (card && !document.querySelector('[data-catalog-provisional="true"]') && document.querySelector('[data-store-status="ready"]') && window.__fc.interactive === null) window.__fc.interactive = performance.now();
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-catalog-provisional', 'data-store-status'] });
  const delay = Number(sessionStorage.getItem('__fcApiDelay') || 0);
  if (delay > 0) { const of = window.fetch.bind(window); window.fetch = async (...a) => { const u = String(a[0]?.url ?? a[0]); if (u.includes('/beatgaler-api/')) await new Promise((r) => setTimeout(r, delay)); return of(...a); }; }
}` });

const sample = () => ex(() => {
  const res = performance.getEntriesByType('resource').filter((e) => e.name.includes('/beatgaler-api/'));
  const find = (re) => res.find((x) => re.test(x.name));
  const end = (re) => { const e = find(re); return e ? Math.round(e.responseEnd) : null; };
  const start = (re) => { const e = find(re); return e ? Math.round(e.startTime) : null; };
  return {
    auth: end(/\/auth\/(session|me|refresh)/), contextStart: start(/\/catalog\/v1\/context/), context: end(/\/catalog\/v1\/context/), beatsStart: start(/\/catalog\/v1\/beats\?/), beats: end(/\/catalog\/v1\/beats\?/),
    firstCard: window.__fc.firstCard === null ? null : Math.round(window.__fc.firstCard), interactive: window.__fc.interactive === null ? null : Math.round(window.__fc.interactive),
    provisionalSeen: window.__fc.provisionalSeen, cards: document.querySelectorAll('[data-card]').length, beatsCalls: res.filter((e) => /\/catalog\/v1\/beats\?/.test(e.name)).length,
  };
});
const med = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const p90 = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(0.9 * v.length))] : null; };
const summarize = (runs) => ({
  n: runs.length, provisionalRuns: runs.filter((r) => r.provisionalSeen).length, maxBeatsCalls: Math.max(...runs.map((r) => r.beatsCalls)),
  firstCard: { median: med(runs.map((r) => r.firstCard)), p90: p90(runs.map((r) => r.firstCard)) },
  interactive: { median: med(runs.map((r) => r.interactive)), p90: p90(runs.map((r) => r.interactive)) },
  firstCardAfterContext: med(runs.map((r) => r.firstCard - r.context)), interactiveAfterContext: med(runs.map((r) => r.interactive - r.context)),
  context: med(runs.map((r) => r.context)), beats: med(runs.map((r) => r.beats)),
});

try {
  await login(BASE, cfg.account);
  await waitFor(async () => (await ex(() => document.querySelectorAll('[data-card]').length)) > 0, { timeout: 90000, msg: 'cards after login' });
  await ex((d) => sessionStorage.setItem('__fcApiDelay', String(d)), apiDelay);
  for (const latency of latencies) {
    await cdp('Network.enable'); await cdp('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
    const runs = Object.fromEntries(modes.map((m) => [m, []]));
    for (let i = 0; i < reloads; i++) {
      for (const mode of modes) {
        await ex((m) => sessionStorage.setItem('__fcNoIdb', m === 'noidb' ? '1' : '0'), mode);
        // primera visita: se borra la base de la copia con el IndexedDB real (la página actual puede tenerlo oculto por el modo noidb)
        if (firstVisit && mode === 'idb') await ex(() => new Promise((r) => { const q = window.__fcRealIdb.deleteDatabase('beatgaler-catalog-first-block'); q.onsuccess = q.onerror = q.onblocked = () => r(null); }));
        await browser.url(`${BASE}/gallery`);
        await waitFor(async () => { const s = await sample(); return s.interactive !== null ? s : null; }, { timeout: 60000, msg: 'interactive gallery' });
        await sleep(300);
        const s = await sample(); runs[mode].push(s);
        rec(`RELOAD-L${latency}-${mode}-${i}`, 'INFO', s);
      }
    }
    for (const mode of modes) rec(`SUMMARY-L${latency}-${mode}`, 'INFO', { base: BASE, latencyMs: latency, emulatedLatency: latency > 0, apiDelayMs: apiDelay, firstVisit, mode, ...summarize(runs[mode]) });
  }
  await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
  await ex(() => { sessionStorage.removeItem('__fcApiDelay'); sessionStorage.removeItem('__fcNoIdb'); });
} catch (e) { rec('ERROR', 'FAIL', { message: String(e.message).slice(0, 300) }); }
await finish();
