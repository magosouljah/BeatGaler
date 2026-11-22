// E80 — Sonda LAB (Chrome aislado; Cloud real + «Telegram» FAKE + PostgreSQL efímero): almacenamiento local en Settings y progreso real de subida.
//   A) Settings → Preferences → «Storage on this device»: uso por caché, «Clear all» sin ninguna petición de red; recarga = portadas en frío desde
//      «Telegram» (y se vuelven a guardar); segunda recarga = caliente (0 lecturas); la Gallery nunca queda vacía.
//   B) Progreso del aviso flotante con la subida ACOTADA por CDP (uploadThroughput): un archivo grande muestra porcentajes intermedios crecientes
//      (no 0 → 100); dos subidas simultáneas de tamaños distintos → total ponderado por bytes, sin retroceder.
//   LAB_STATE_DIR=... node scripts/catalog-lab/probe-e80.mjs [--out DIR] [--mb 12] [--kbps 4096]
import { reviewActions, parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const opt = (k, d) => { const i = args.rest.indexOf(k); return i >= 0 ? args.rest[i + 1] : d; };
const MB = Number(opt('--mb', '12')); const KBPS = Number(opt('--kbps', '4096'));
const R = await createRun({ kind: 'e80', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, browser, POSTGRES, cfg, sleep, finish, cdp } = R;

await browser.scriptAddPreloadScript({ functionDeclaration: `() => {
  window.__net = { access: 0, reads: 0, api: 0 }; const art = new Set(); const of = window.fetch.bind(window);
  window.fetch = async (...a) => { const u = String((a[0] && a[0].url) || a[0]); const m = String((a[1] && a[1].method) || 'GET').toUpperCase();
    if (u.includes('/beatgaler-api/')) window.__net.api++;
    if (m === 'POST' && u.includes('/catalog/v1/files/') && u.endsWith('/access')) { const r = await of(...a); try { const j = await r.clone().json(); if (j && j.role === 'ARTWORK') { window.__net.access++; for (const p of j.parts || []) if (p.direct) art.add(String(p.direct.messageId)); } } catch (e) {} return r; }
    if (u.includes('/lab-telegram/read') && art.has(new URL(u, location.href).searchParams.get('messageId'))) window.__net.reads++;
    return of(...a); };
}` });
const net = () => ex(() => ({ ...window.__net }));
const list = () => ex(async () => ((await (await fetch('/beatgaler-api/catalog/v1/beats?limit=240&sort=rating', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json()).items || []));
const mounted = () => ex(() => [...document.querySelectorAll('[data-card]')].map((c) => c.getAttribute('data-card')));
const mountedCovers = async () => { const withArt = new Set((await list()).filter((b) => b.artwork).map((b) => b.id)); return (await mounted()).filter((id) => withArt.has(id)); };
const coversShown = () => ex(() => [...document.querySelectorAll('[data-card]')].filter((c) => { const img = c.querySelector('img'); return img && (img.currentSrc || img.src || '').startsWith('blob:') && img.naturalWidth > 0; }).length);
const idbCovers = () => ex(async () => { if (!(await indexedDB.databases()).some((d) => d.name === 'beatgaler-catalog-artwork')) return 0; return new Promise((res) => { const q = indexedDB.open('beatgaler-catalog-artwork'); q.onerror = () => res(-1); q.onsuccess = () => { try { const g = q.result.transaction('meta', 'readonly').objectStore('meta').getAll(); g.onsuccess = () => { res(g.result.length); q.result.close(); }; } catch { res(-2); } }; }); });
const openGallery = async () => { await browser.url(POSTGRES + '/gallery'); await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.cards > 0 && g.storeStatus === 'ready' ? g : null; }, { timeout: 90000, msg: 'gallery' }); };
const clickText = (t, tag = 'button') => ex((text, tg) => { const b = [...document.querySelectorAll(tg)].find((x) => x.textContent.trim() === text && !x.disabled); if (b) b.click(); return Boolean(b); }, t, tag);
const storage = () => ex(() => Object.fromEntries([...document.querySelectorAll('[data-local-cache]')].map((r) => [r.getAttribute('data-local-cache'), Number(r.querySelector('[data-local-cache-used]').getAttribute('data-local-cache-used'))])));
const notice = () => ex(() => (document.querySelector('.bg-catalog-notice') || {}).textContent || '');
// MP3 sintético de `bytes` bytes construido EN la página (sin pasar el archivo por WebDriver) y soltado sobre la Gallery.
const dropMp3 = (name, bytes, salt) => ex((n, size, s) => {
  const frame = new Uint8Array(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; const out = new Uint8Array(size);
  for (let o = 0; o < size; o += 417) out.set(frame.subarray(0, Math.min(417, size - o)), o);
  out.set(new TextEncoder().encode('e80-' + s), Math.max(0, size - 16));
  const dt = new DataTransfer(); dt.items.add(new File([out], n, { type: 'audio/mpeg' }));
  const mk = (k) => new DragEvent(k, { bubbles: true, cancelable: true, dataTransfer: dt }); window.dispatchEvent(mk('dragenter')); window.dispatchEvent(mk('dragover')); setTimeout(() => window.dispatchEvent(mk('drop')), 150);
}, name, bytes, salt);
const reviewOpen = () => ex(() => /Review beat 1 of 1/.test(document.body.innerText));
const { setName, saveReview } = reviewActions(ex);
const startImport = async (name, bytes, salt) => { await dropMp3(name + '.mp3', bytes, salt); await waitFor(async () => (await reviewOpen()) || null, { timeout: 60000, msg: 'review ' + name }); await sleep(400); await setName(name); await sleep(250); await saveReview(); await waitFor(async () => !(await reviewOpen()) || null, { timeout: 60000, msg: 'review closed ' + name }); };
// Muestreo por fotograma del % del aviso flotante.
const startSampling = () => ex(() => { window.__pct = []; window.__pctStop = false; const tick = () => { const t = (document.querySelector('.bg-catalog-notice') || {}).textContent || ''; const m = /Subiendo (.+?)… (\d+) %/.exec(t); if (m) { const last = window.__pct[window.__pct.length - 1]; const v = { who: m[1], p: Number(m[2]) }; if (!last || last.p !== v.p || last.who !== v.who) window.__pct.push(v); } if (!window.__pctStop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
const stopSampling = () => ex(() => { window.__pctStop = true; return window.__pct; });
const monotonic = (xs) => xs.every((v, i) => i === 0 || v >= xs[i - 1]);

try {
  await login(POSTGRES, cfg.account);
  await openGallery(); await sleep(1500);

  // ---- A. Settings: uso y limpieza ----
  await ex(() => { document.querySelector('button[aria-label="Profile"]').click(); }); await sleep(500);
  await clickText('Settings', 'button,div,span'); await sleep(1500);
  await clickText('preferences'); await waitFor(async () => (await ex(() => Boolean(document.querySelector('[data-settings-local-storage]')))) || null, { timeout: 15000, msg: 'storage block' });
  await waitFor(async () => Object.keys(await storage()).length === 3 || null, { timeout: 15000, msg: 'usage rows' });
  const before = await storage(); await shot('a1-storage-before');
  const netBefore = await net();
  await clickText('Clear all'); await waitFor(async () => Object.values(await storage()).every((v) => v === 0) || null, { timeout: 15000, msg: 'cleared' });
  const after = await storage(); const netAfter = await net(); const idbAfter = await idbCovers(); await shot('a2-storage-cleared');
  const cardsWhileOpen = (await mounted()).length;
  rec('SETTINGS-STORAGE-CLEAR', before.artwork > 0 && before.metadata > 0 && Object.values(after).every((v) => v === 0) && netAfter.api === netBefore.api && idbAfter === 0 && cardsWhileOpen > 0 ? 'PASS' : 'FAIL',
    { before, after, apiRequestsDuringClear: netAfter.api - netBefore.api, artworkEntriesAfter: idbAfter, galleryCardsStillMounted: cardsWhileOpen });

  // recarga tras limpiar = frío real; segunda recarga = caliente
  await openGallery(); await sleep(400); const expCold = (await mountedCovers()).length;
  await waitFor(async () => (await coversShown()) >= expCold || null, { timeout: 30000, interval: 50, msg: 'cold covers' }); await sleep(1200);
  const cold = await net(); const coldIdb = await idbCovers();
  rec('COVERS-COLD-AFTER-CLEAR', expCold > 0 && cold.reads === expCold && cold.access === expCold && coldIdb === expCold ? 'PASS' : 'FAIL', { coversMounted: expCold, telegramReads: cold.reads, cloudAccessRequests: cold.access, persistedAgain: coldIdb });
  await openGallery(); await sleep(400);
  await waitFor(async () => (await coversShown()) >= expCold || null, { timeout: 30000, interval: 50, msg: 'warm covers' }); await sleep(800);
  const warm = await net();
  rec('COVERS-WARM', warm.reads === 0 && warm.access === 0 ? 'PASS' : 'FAIL', { coversMounted: expCold, telegramReads: warm.reads, cloudAccessRequests: warm.access });

  // ---- B. Progreso real con subida acotada ----
  await cdp('Network.enable'); await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: KBPS * 1024 });
  const stamp = Date.now() % 100000;
  await startSampling();
  await startImport(`E80 grande ${stamp}`, MB * 1024 * 1024, 'g');
  await waitFor(async () => (await ex(() => Number(document.querySelector('.bg-catalog-shell-status').getAttribute('data-uploads') || 0))) === 0 || null, { timeout: 180000, interval: 200, msg: 'big upload done' });
  const single = (await stopSampling()).map((x) => x.p);
  const inter = single.filter((p) => p > 0 && p < 100);
  const landed = (await list()).some((b) => b.name === `E80 grande ${stamp}`); await shot('b1-after-big');
  rec('PROGRESS-SINGLE-LARGE', landed && monotonic(single) && new Set(inter).size >= 5 ? 'PASS' : 'FAIL', { mb: MB, uploadKiBps: KBPS, distinctPercents: new Set(single).size, intermediate: inter.length, first: single.slice(0, 6), last: single.slice(-4), monotonic: monotonic(single), committed: landed });

  // E83: tarjetas estables durante varias subidas simultáneas (una por beat, ninguna copia, logo girando, nada que desaparezca y reaparezca).
  await ex(() => { window.__cf = []; window.__cfStop = false; const tick = () => { const tiles = [...document.querySelectorAll('.lab-beat-tile')]; const f = { pend: document.querySelectorAll('[data-pending-import]').length, spin: document.querySelectorAll('[data-pending-import] [aria-label="Updating beat in Galer Cloud"]').length }; for (const n of ['E80 multi grande', 'E80 multi chica']) f[n] = tiles.filter((c) => c.textContent.includes(n)).length; window.__cf.push(f); if (!window.__cfStop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  await startSampling();
  await startImport(`E80 multi grande ${stamp}`, Math.round(MB * 0.75 * 1024 * 1024), 'm1');
  await startImport(`E80 multi chica ${stamp}`, 256 * 1024, 'm2');
  await waitFor(async () => (await ex(() => Number(document.querySelector('.bg-catalog-shell-status').getAttribute('data-uploads') || 0))) === 0 || null, { timeout: 180000, interval: 200, msg: 'multi done' });
  await sleep(1500); const cf = await ex(() => { window.__cfStop = true; return window.__cf; });
  const multiAll = await stopSampling(); const multi = multiAll.filter((x) => /beats$/.test(x.who)).map((x) => x.p);
  const okMulti = (await list()).filter((b) => b.name.startsWith('E80 multi ') && b.name.endsWith(String(stamp))).length === 2;
  rec('PROGRESS-MULTI-WEIGHTED', okMulti && multi.length >= 3 && monotonic(multi) && multi.some((p) => p > 0 && p < 100) ? 'PASS' : 'FAIL', { aggregatePercents: multi.slice(0, 12), monotonic: monotonic(multi), samples: multiAll.length, committed: okMulti });
  const names = ['E80 multi grande', 'E80 multi chica']; const firstSeen = Object.fromEntries(names.map((n) => [n, cf.findIndex((f) => f[n] > 0)])); const lastSeen = Object.fromEntries(names.map((n) => [n, cf.length - 1 - [...cf].reverse().findIndex((f) => f[n] > 0)]));
  const holes = names.filter((n) => cf.slice(firstSeen[n], lastSeen[n] + 1).some((f) => f[n] === 0)); const dups = cf.filter((f) => names.some((n) => f[n] > 1)).length;
  rec('UPLOAD-MULTI-CARDS-STABLE', okMulti && Math.max(...cf.map((f) => f.pend)) === 2 && cf.some((f) => f.spin === 2) && dups === 0 && holes.length === 0 && cf[cf.length - 1].pend === 0 ? 'PASS' : 'FAIL', { frames: cf.length, maxPending: Math.max(...cf.map((f) => f.pend)), framesBothSpinning: cf.filter((f) => f.spin === 2).length, duplicateFrames: dups, namesWithHoles: holes, endPending: cf[cf.length - 1].pend });
  await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
} catch (e) { rec('ERROR', 'FAIL', { message: String(e.message).slice(0, 300) }); await shot('error').catch(() => {}); }
await finish();
