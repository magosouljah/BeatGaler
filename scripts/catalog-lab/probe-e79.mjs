// E79 — Sonda LAB (Chrome aislado; Cloud real + «Telegram» FAKE + PostgreSQL efímero): caché persistente de portadas (frío/caliente, reemplazo,
// desvinculación), estado único de la Gallery con subidas simultáneas y otro orden, estrellas de BeatCard (normal/hover/reproducción) y regresión
// de reproducción + MAIN. Mide peticiones de portadas: concesiones al Cloud (POST /files/:id/access) y lecturas del «Telegram» del LAB.
//   LAB_STATE_DIR=... node scripts/catalog-lab/probe-e79.mjs [--out DIR]
import { buttonActions, reviewActions, parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'e79', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, installAudioCapture, audioState, browser, POSTGRES, cfg, sleep } = R;
const { pressEnabled: press } = buttonActions(ex);

// Contadores por carga de página: concesiones (Cloud, metadatos) y lecturas/envíos al «Telegram» del LAB (bytes). Retraso opcional de los envíos.
await browser.scriptAddPreloadScript({ functionDeclaration: `() => {
  window.__net = { access: 0, reads: 0, otherReads: 0, sends: 0 }; const art = new Set(); const of = window.fetch.bind(window); // access/reads = SOLO portadas; otherReads = audio, MAIN…
  window.fetch = async (...a) => { const u = String((a[0] && a[0].url) || a[0]); const m = String((a[1] && a[1].method) || 'GET').toUpperCase();
    if (m === 'POST' && u.includes('/catalog/v1/files/') && u.endsWith('/access')) { const r = await of(...a); try { const j = await r.clone().json(); if (j && j.role === 'ARTWORK') { window.__net.access++; for (const p of j.parts || []) if (p.direct) art.add(String(p.direct.messageId)); } } catch (e) {} return r; }
    if (u.includes('/lab-telegram/read')) { if (art.has(new URL(u, location.href).searchParams.get('messageId'))) window.__net.reads++; else window.__net.otherReads++; }
    if (m === 'POST' && u.includes('/lab-telegram/send')) { window.__net.sends++; if (window.__uploadDelay) await new Promise((r) => setTimeout(r, window.__uploadDelay)); }
    return of(...a); };
  // E80: el doble Direct B envía con XMLHttpRequest (eventos de bytes enviados): mismo contador y retraso para ese camino.
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__labSend = String(m).toUpperCase() === 'POST' && String(u).includes('/lab-telegram/send'); return xo.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (...a) { if (!this.__labSend) return xs.apply(this, a); window.__net.sends++; const d = window.__uploadDelay || 0; if (d) setTimeout(() => xs.apply(this, a), d); else xs.apply(this, a); };
}` });

const silentMp3 = (salt) => { const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; return Buffer.concat([...Array.from({ length: 1500 }, () => frame), Buffer.from('e79-' + salt)]).toString('base64'); };
const net = () => ex(() => ({ ...window.__net }));
const notice = () => ex(() => (document.querySelector('.bg-catalog-notice') || {}).textContent || '');
const ctx = () => ex(async () => (await (await fetch('/beatgaler-api/catalog/v1/context', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json()));
const list = (sort = 'rating') => ex(async (s) => ((await (await fetch('/beatgaler-api/catalog/v1/beats?limit=240&sort=' + s, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json()).items || []), sort);
const patch = (beat, body) => ex(async (id, version, p) => { const c = await (await fetch('/beatgaler-api/catalog/v1/context', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json(); const r = await fetch('/beatgaler-api/catalog/v1/beats/' + encodeURIComponent(id), { method: 'PATCH', credentials: 'include', headers: { 'X-BeatGaler-Client': 'web', 'Content-Type': 'application/json', 'X-BeatGaler-CSRF': sessionStorage.getItem('beatgaler:web-csrf:v1') || '', 'X-Catalog-Era': c.authority_era, 'X-Catalog-Epoch': c.authority_epoch, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: version, patch: p }) }); return { status: r.status, body: await r.json().catch(() => null) }; }, beat.id, beat.version, body);
const idbCovers = () => ex(async () => { if (!(await indexedDB.databases()).some((d) => d.name === 'beatgaler-catalog-artwork')) return { entries: 0, bytes: 0 }; return new Promise((res) => { const q = indexedDB.open('beatgaler-catalog-artwork'); q.onerror = () => res({ entries: -1, bytes: 0 }); q.onsuccess = () => { try { const g = q.result.transaction('meta', 'readonly').objectStore('meta').getAll(); g.onsuccess = () => res({ entries: g.result.length, bytes: g.result.reduce((n, m) => n + m.size, 0), beats: g.result.map((m) => m.beatId) }); g.onerror = () => res({ entries: -2, bytes: 0 }); } catch (e) { res({ entries: -3, bytes: 0 }); } }; }); });
// Tarjetas a la vista: cuáles tienen portada pintada (imagen cargada desde blob:).
const coversShown = () => ex(() => [...document.querySelectorAll('[data-card]')].map((c) => { const img = c.querySelector('.lab-artwork img, img'); return { id: c.getAttribute('data-card'), shown: Boolean(img && (img.currentSrc || img.src || '').startsWith('blob:') && img.naturalWidth > 0), w: img ? img.naturalWidth : 0, src: img ? (img.currentSrc || img.src || '') : '' }; }));
// Virtualización: solo las tarjetas MONTADAS piden portada; lo esperado se calcula sobre ellas, no sobre toda la biblioteca.
const mounted = () => ex(() => [...document.querySelectorAll('[data-card]')].map((c) => c.getAttribute('data-card')));
const mountedCovers = async () => { const withArt = new Set((await list()).filter((b) => b.artwork).map((b) => b.id)); return (await mounted()).filter((id) => withArt.has(id)); };
const openGallery = async (query = '') => { await browser.url(POSTGRES + '/gallery' + query); await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.cards > 0 && g.storeStatus === 'ready' ? g : null; }, { timeout: 90000, msg: 'gallery' }); };
const waitCovers = async (expected, timeout = 30000) => { const t0 = Date.now(); const ok = await waitFor(async () => (await coversShown()).filter((c) => c.shown).length >= expected || null, { timeout, interval: 50, msg: 'covers' }).catch(() => false); return { ok: Boolean(ok), ms: Date.now() - t0 }; };
const dropFile = async (name, base64, type, targetSel = null) => {
  await ex((n, data, t, sel) => { const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], n, { type: t })); window.__dt = dt; window.__tgt = sel; const el = sel ? document.querySelector(sel) : window; const mk = (k) => new DragEvent(k, { bubbles: true, cancelable: true, dataTransfer: dt }); el.dispatchEvent(mk('dragenter')); el.dispatchEvent(mk('dragover')); }, name, base64, type, targetSel);
  await sleep(150);
  await ex(() => { const el = window.__tgt ? document.querySelector(window.__tgt) : window; el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); });
};
const png = (color, size = 256) => ex((c, s) => new Promise((res) => { const cv = Object.assign(document.createElement('canvas'), { width: s, height: s }); const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, s, s); g.fillStyle = '#ffffff'; g.fillRect(s / 4, s / 4, s / 2, s / 2); res(cv.toDataURL('image/png').split(',')[1]); }), color, size);
const { setName, saveReview } = reviewActions(ex);
const reviewOpen = () => ex(() => /Review beat 1 of 1/.test(document.body.innerText));
const startImport = async (name, salt) => { await dropFile(name + '.mp3', silentMp3(salt), 'audio/mpeg'); await waitFor(async () => (await reviewOpen()) || null, { timeout: 30000, msg: 'review ' + name }); await sleep(500); await setName(name); await sleep(300); await saveReview(); await waitFor(async () => !(await reviewOpen()) || null, { timeout: 15000, msg: 'review closed ' + name }); };
const domOrder = () => ex(() => [...document.querySelectorAll('[data-card]')].sort((a, b) => Number(a.getAttribute('data-ordinal')) - Number(b.getAttribute('data-ordinal'))).map((c) => c.getAttribute('data-card')));
const starInfo = (id) => ex((beatId) => { const card = document.querySelector('[data-card="' + beatId + '"]'); const s = card && card.querySelector('.lab-beat-tile__stars'); if (!s) return null; const cs = getComputedStyle(s); const r = s.getBoundingClientRect(); const cr = card.getBoundingClientRect(); return { x: Math.round(r.x - cr.x), y: Math.round(r.y - cr.y), w: Math.round(r.width), h: Math.round(r.height), fontSize: cs.fontSize, opacity: cs.opacity, visibility: cs.visibility, display: cs.display, stars: [...s.children].map((k) => getComputedStyle(k).color), count: s.children.length, playing: card.getAttribute('data-playing') }; }, id);
const contrast = (rgb, bg = [12, 12, 12]) => { const v = rgb.match(/\d+/g).slice(0, 3).map(Number); const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; const a = lum(v), b = lum(bg); return Number(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2)); };

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.cards > 0 ? g : null; }, { timeout: 90000, msg: 'gallery' });
  const beats0 = await list(); const withArt = beats0.filter((b) => b.artwork);
  rec('E79-CONTEXT', withArt.length > 0 ? 'PASS' : 'FAIL', { beats: beats0.length, withArtwork: withArt.length, capabilities: (await ctx()).capabilities });

  // ---- A. Portadas: caché fría (perfil nuevo) → caliente (recarga) ----
  // La primera carga tras iniciar sesión (perfil nuevo, sin nada en disco) ES la carga fría: no se navega antes de medirla.
  await sleep(600); const expCold = (await mountedCovers()).length; const cold = await waitCovers(expCold); await sleep(1200);
  const coldNet = await net(); const coldIdb = await idbCovers(); await shot('a1-cold');
  rec('COVERS-COLD', cold.ok && expCold > 0 && coldNet.reads === expCold && coldNet.access === expCold && coldIdb.entries === expCold ? 'PASS' : 'FAIL', { coversInLibrary: withArt.length, coversMounted: expCold, cardsMounted: (await mounted()).length, beatsInLibrary: beats0.length, msToAllCovers: cold.ms, cloudAccessRequests: coldNet.access, telegramReads: coldNet.reads, persisted: coldIdb });
  await openGallery(); await sleep(300); const expWarm = (await mountedCovers()).length; const warm = await waitCovers(expWarm); await sleep(800);
  const warmNet = await net(); await shot('a2-warm');
  rec('COVERS-WARM-RELOAD', warm.ok && expWarm === expCold && warmNet.access === 0 && warmNet.reads === 0 ? 'PASS' : 'FAIL', { coversMounted: expWarm, msToAllCovers: warm.ms, cloudAccessRequests: warmNet.access, telegramReads: warmNet.reads, before: { cloudAccessRequests: coldNet.access, telegramReads: coldNet.reads } });

  // ---- A. Reemplazo: otra portada sobre un beat que ya tenía → se lee UNA vez la nueva, sustituye a la anterior en disco; recarga sin red ----
  const firstMounted = (await mountedCovers())[0]; const target = withArt.find((b) => b.id === firstMounted); const sel = '[data-card="' + target.id + '"]';
  const n0 = await net(); const oldSrc = ((await coversShown()).find((x) => x.id === target.id) || {}).src || '';
  // E80: color único por ejecución (el LAB es persistente) y se espera la imagen NUEVA: antes valía la anterior, aún pintada hasta el refresco en el sitio.
  await dropFile('nueva.png', await png('#' + (Date.now() % 0xffffff).toString(16).padStart(6, '0')), 'image/png', sel); await sleep(1200); await press('Apply crop'); await sleep(400); await press('Replace');
  const replaced = await waitFor(async () => { const b = (await list()).find((x) => x.id === target.id); return b && b.artwork && b.artwork.fileId !== target.artwork.fileId ? b : null; }, { timeout: 60000, msg: 'artwork replaced' }).catch(() => null);
  const shownNew = await waitFor(async () => { const c = (await coversShown()).find((x) => x.id === target.id); return c && c.shown && c.w > 1 && c.src !== oldSrc ? c : null; }, { timeout: 30000, interval: 100, msg: 'new cover shown' }).catch(() => null);
  await sleep(800); const n1 = await net(); const idb1 = await idbCovers();
  rec('COVER-REPLACE', replaced && shownNew && n1.reads - n0.reads === 1 && idb1.entries === expCold && idb1.beats.filter((b) => b === target.id).length === 1 ? 'PASS' : 'FAIL', { newFile: Boolean(replaced), shown: shownNew, telegramReadsForNewCover: n1.reads - n0.reads, persisted: { entries: idb1.entries, forThisBeat: idb1.beats.filter((b) => b === target.id).length } });
  await openGallery(); await sleep(300); const warm2 = await waitCovers((await mountedCovers()).length); await sleep(600); const n2 = await net();
  const afterReload = (await coversShown()).find((x) => x.id === target.id);
  rec('COVER-REPLACE-RELOAD', warm2.ok && n2.reads === 0 && n2.access === 0 && afterReload && afterReload.w > 1 ? 'PASS' : 'FAIL', { cloudAccessRequests: n2.access, telegramReads: n2.reads, newCoverWidth: afterReload && afterReload.w });

  // ---- A. Desvinculada (confirmado por PostgreSQL): tras recargar no se muestra ninguna portada anterior ----
  const victimId = (await mountedCovers()).find((id) => id !== target.id); const victim = (await list()).find((b) => b.id === victimId);
  const un = await patch(victim, { artwork: null });
  await openGallery(); await sleep(300); await waitCovers((await mountedCovers()).length); await sleep(600);
  const gone = (await coversShown()).find((x) => x.id === victim.id);
  rec('COVER-UNLINKED', un.status === 200 && gone && !gone.shown && (await net()).reads === 0 ? 'PASS' : 'FAIL', { patchStatus: un.status, cardStillShowsCover: gone ? gone.shown : null, telegramReads: (await net()).reads });

  // ---- C. Estrellas: siempre visibles; normal, hover y reproducción ----
  const rated = (await list())[3]; const pr = await patch(rated, { rating: 3 });
  await openGallery(); await installAudioCapture(); await sleep(800);
  const normal = await starInfo(rated.id);
  await (await browser.$('[data-card="' + rated.id + '"] [data-beat-artwork-id]')).moveTo(); await sleep(400);
  const hover = await starInfo(rated.id); await (await browser.$('[data-card="' + rated.id + '"]')).saveScreenshot(R.OUT + '/c2-card-hover.png').catch(() => {});
  await (await browser.$('[data-card="' + rated.id + '"] [data-beat-artwork-id]')).click();
  const playing = await waitFor(async () => { const a = (await audioState())[0]; return a && !a.paused && a.t > 0.1 && !a.error ? a : null; }, { timeout: 30000, msg: 'play' }).catch(() => null);
  await sleep(300); const play = await starInfo(rated.id); await (await browser.$('[data-card="' + rated.id + '"]')).saveScreenshot(R.OUT + '/c3-card-playing.png').catch(() => {});
  const unrated = (await list()).find((b) => b.rating === 0); const zero = await starInfo(unrated.id);
  await (await browser.$('.lab-gallery-main')).moveTo({ xOffset: 0, yOffset: 300 }).catch(() => {}); await shot('c1-stars');
  const okState = (s, filled) => s && s.count === 5 && s.opacity === '1' && s.visibility === 'visible' && s.display !== 'none' && s.w > 20 && s.fontSize === '11px' && s.stars.filter((c) => c === 'rgb(242, 242, 242)').length === filled && s.stars.every((c) => contrast(c) >= 3);
  const sameBox = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  rec('STARS-ALWAYS-VISIBLE', pr.status === 200 && okState(normal, 3) && okState(hover, 3) && okState(play, 3) && okState(zero, 0) && sameBox(normal, hover) && sameBox(normal, play) && play.playing === 'true' ? 'PASS' : 'FAIL', {
    normal, hover, playing: play, unrated: zero, contrastEmpty: zero ? contrast(zero.stars[0]) : null, contrastFilled: normal ? contrast(normal.stars[0]) : null, contrastEmptyBefore: contrast('rgb(69, 69, 69)'), audio: playing });
  rec('REGRESSION-PLAYBACK', playing ? 'PASS' : 'FAIL', { audio: playing });
  await ex(() => { if (window.__v09Audio) window.__v09Audio.pause(); });

  // ---- B. Estado único con subidas simultáneas y orden por nombre ----
  await openGallery('?bgSort=name'); await sleep(800);
  const stamp = Date.now() % 100000; const names = ['Aaa primero ' + stamp, 'Mmm medio ' + stamp, 'Zzz final ' + stamp];
  const cardsBefore = await ex(() => document.querySelectorAll('[data-card]').length);
  await ex((list0) => { window.__uploadDelay = 3500; window.__frames = []; window.__framesStop = false; const tick = () => { const cards = [...document.querySelectorAll('[data-card]')]; const st = document.querySelector('[data-catalog-state]'); const f = { t: Math.round(performance.now()), cards: cards.length, pending: document.querySelectorAll('[data-pending-import]').length, status: st ? st.getAttribute('data-catalog-state') : null, uploads: Number(document.querySelector('.bg-catalog-shell-status').getAttribute('data-uploads') || 0), named: {}, ord: {} }; for (const n of list0) { const tiles = [...document.querySelectorAll('.lab-beat-tile')].filter((c) => c.textContent.includes(n)); f.named[n] = tiles.length; const own = cards.find((c) => c.textContent.includes(n)); f.ord[n] = own ? Number(own.getAttribute('data-ordinal')) : null; } window.__frames.push(f); if (!window.__framesStop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }, names);
  for (let i = 0; i < names.length; i++) await startImport(names[i], String(i)); // tres subidas a la vez (cada envío tarda 3,5 s)
  const during = await ex(() => ({ uploads: Number(document.querySelector('.bg-catalog-shell-status').getAttribute('data-uploads') || 0), notice: (document.querySelector('.bg-catalog-notice') || {}).textContent || '' }));
  await shot('b1-uploading');
  await waitFor(async () => { const l = await list('name'); return names.every((n) => l.some((b) => b.name === n)) || null; }, { timeout: 90000, msg: 'three imports committed' });
  await waitFor(async () => (await ex(() => Number(document.querySelector('.bg-catalog-shell-status').getAttribute('data-uploads') || 0))) === 0 || null, { timeout: 30000, msg: 'uploads done' });
  await sleep(1500); const frames = await ex(() => { window.__framesStop = true; window.__uploadDelay = 0; return window.__frames; });
  const serverOrder = (await list('name')).map((b) => b.id); const dom = await domOrder(); await shot('b2-after');
  const maxNamed = Math.max(...frames.flatMap((f) => Object.values(f.named))); const ordChanges = names.map((n) => { const seen = frames.filter((f) => f.ord[n] !== null).map((f) => f.ord[n]); return { name: n.slice(0, 3), firstOrdinal: seen[0] ?? null, lastOrdinal: seen[seen.length - 1] ?? null, shownFrames: seen.length }; });
  const finalByName = await ex((list0) => Object.fromEntries(list0.map((n) => { const c = [...document.querySelectorAll('[data-card]')].find((x) => x.textContent.includes(n)); return [n, c ? Number(c.getAttribute('data-ordinal')) : null]; })), names);
  const srv = await list('name'); const srvOrd = Object.fromEntries(names.map((n) => [n, srv.findIndex((b) => b.name === n)]));
  rec('UPLOAD-SINGLE-STATE-MULTI', maxNamed === 1 && frames.some((f) => f.pending > 0 && f.uploads > 0) && !frames.some((f) => f.status) && Math.min(...frames.map((f) => f.cards)) >= cardsBefore && during.uploads >= 2 && during.notice.includes('Subiendo') && JSON.stringify(dom) === JSON.stringify(serverOrder.slice(0, dom.length)) && names.every((n) => finalByName[n] === null || finalByName[n] === srvOrd[n]) && names.filter((n) => finalByName[n] !== null).length >= 2 ? 'PASS' : 'FAIL', { // null = fuera de la ventana virtual (no montada)
    frames: frames.length, during, maxCardsPerBeat: maxNamed, provisionalCardsEver: frames.some((f) => f.pending > 0), emptyOrLoadingEver: frames.some((f) => Boolean(f.status)), cardsBefore, minCards: Math.min(...frames.map((f) => f.cards)), maxCards: Math.max(...frames.map((f) => f.cards)),
    ordinals: ordChanges, finalOrdinalDom: finalByName, finalOrdinalPostgres: srvOrd, domOrderMatchesPostgres: JSON.stringify(dom) === JSON.stringify(serverOrder.slice(0, dom.length)), notice: await notice() });

  // ---- Regresión: MAIN de prefijos (E75) sigue reconstruyéndose tras el lote ----
  let man = null; for (let i = 0; i < 30; i++) { man = await ex(async () => (await (await fetch('/beatgaler-api/catalog/v1/prefix-packs/manifest', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json())); if (man && man.main && man.pendingCount < 5) break; await sleep(2000); }
  rec('REGRESSION-MAIN', man && man.main ? 'PASS' : 'FAIL', { main: man && man.main && { version: man.main.version, sizeBytes: man.main.sizeBytes }, entries: man && (man.entries || []).length, pendingCount: man && man.pendingCount });
  rec('E79-LOGS', 'INFO', { severe: (await browser.getLogs('browser').catch(() => [])).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 220)).slice(0, 12) });
} catch (e) { rec('E79', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
