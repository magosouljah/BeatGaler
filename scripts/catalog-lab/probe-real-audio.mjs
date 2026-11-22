// E72 — Sonda FÍSICA de audio: LAB REAL (Telegram de pruebas Bot20/MASTER/testborrar) con Direct B + MSE + prefijos. Chrome aislado, nunca el del propietario.
// Mide tiempos reales, peticiones HTTP al Cloud y tráfico del Worker mtcute (= Telegram directo). No borra nada en Telegram.
//   LAB_STATE_DIR=... node scripts/catalog-lab/probe-real-audio.mjs --phase up|upload-one|cold|restart|switch|replace|cover|project|project-download|main|packs|e73 [--out DIR]
import fs from 'node:fs';
import path from 'node:path';
import { buttonActions, reviewActions, parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const phase = args.rest[args.rest.indexOf('--phase') + 1] || 'up';
const R = await createRun({ kind: `real-audio-${phase === 'packs' ? 'fresh' : 'main'}`, args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, installAudioCapture, browser, POSTGRES, cfg, sleep } = R;
const { pressEnabled: press } = buttonActions(ex);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const mp3 = fs.readFileSync(path.join(ROOT, 'tmp', 'gallery-test', 'Galer E2E Beat.mp3'));
const VARIANTS = { A: mp3, B: mp3.subarray(0, 420000), C: mp3.subarray(0, 262144 + 1000) }; // B y C: truncados (MP3 tolera cortes) → hash distinto

// Instrumento: Worker mtcute (Telegram directo) — operaciones, bytes y duración por operación; HTTP al Cloud por Resource Timing.
await browser.scriptAddPreloadScript({ functionDeclaration: `() => {
  try { localStorage.setItem('bg:diag', '1'); } catch (e) {}
  window.__fx = []; const of = window.fetch.bind(window); window.fetch = async (...a) => { const u = String((a[0] && a[0].url) || a[0]); if (!u.includes('catalog/v1/')) return of(...a); const e = { u: u.split('catalog/v1/')[1].split('?')[0].replace(/[A-Za-z0-9_-]{16,}/g, '#').slice(0, 48), m: (a[1] && a[1].method) || 'GET', range: (a[1] && a[1].headers && (a[1].headers.Range || a[1].headers.range)) || null, t: Math.round(performance.now()) }; window.__fx.push(e); try { const r = await of(...a); e.status = r.status; e.ttfbMs = Math.round(performance.now()) - e.t; e.len = Number(r.headers.get('content-length') || 0); return r; } catch (err) { e.err = String(err && err.name); throw err; } };
  window.__pt = []; const ci = console.info.bind(console); console.info = (...a) => { try { const m = typeof a[0] === 'string' && a[0].startsWith('[play-trace] ') ? JSON.parse(a[0].slice(13)) : null; if (m) window.__pt.push({ stage: m.stage, t: m.t_ms, elapsed: m.elapsed_ms, total: m.total_ms }); } catch (e) {} return ci(...a); };
  const W = window.Worker; window.__wk = { out: [], inn: [] };
  const sz = (v, d = 0) => { if (!v || d > 4) return 0; if (v instanceof ArrayBuffer) return v.byteLength; if (ArrayBuffer.isView(v)) return v.byteLength; if (typeof v === 'object') { let n = 0; for (const k of Object.keys(v)) n += sz(v[k], d + 1); return n; } return 0; };
  window.Worker = function (...a) { const w = new W(...a); const pm = w.postMessage.bind(w);
    w.postMessage = (m, ...r) => { try { window.__wk.out.push({ t: performance.now(), op: m && m.op, id: m && m.requestId, up: sz(m && m.input) }); } catch (e) {} return pm(m, ...r); };
    w.addEventListener('message', (e) => { try { const d = e.data || {}; window.__wk.inn.push({ t: performance.now(), id: d.requestId, type: d.type || d.kind, bytes: sz(d), err: d.error ? String(d.error.code || d.error.message || d.error).slice(0, 80) : null }); } catch (_) {} });
    return w; };
  window.Worker.prototype = W.prototype;
}` });

const snap = () => ex(() => ({ wk: { out: window.__wk ? window.__wk.out.length : -1, inn: window.__wk ? window.__wk.inn.length : -1 }, res: performance.getEntriesByType('resource').length, now: performance.now() }));
const since = (s) => ex((s0) => {
  const out = (window.__wk ? window.__wk.out : []).slice(s0.wk.out); const inn = (window.__wk ? window.__wk.inn : []).slice(s0.wk.inn);
  const byId = new Map(inn.map((x) => [x.id, x])); const ops = {};
  for (const o of out) { const k = o.op || '?'; ops[k] = ops[k] || { n: 0, upBytes: 0, downBytes: 0 }; ops[k].n++; ops[k].upBytes += o.up || 0; }
  for (const x of inn) { const o = out.find((y) => y.id === x.id); const k = o ? o.op || '?' : 'unmatched'; ops[k] = ops[k] || { n: 0, upBytes: 0, downBytes: 0 }; ops[k].downBytes += x.bytes || 0; }
  const http = performance.getEntriesByType('resource').slice(s0.res).filter((r) => r.name.includes('/beatgaler-api/')).map((r) => ({ u: r.name.split('/beatgaler-api')[1] || r.name.replace(/[0-9a-f]{20,}/g, '#'), b: r.encodedBodySize || r.transferSize || 0, ms: Math.round(r.duration) }));
  const agg = {}; for (const h of http) { const k = h.u.split('?')[0]; agg[k] = agg[k] || { n: 0, bytes: 0 }; agg[k].n++; agg[k].bytes += h.b; }
  return { workerOps: ops, workerErrors: inn.filter((x) => x.err).map((x) => x.err), httpCalls: http.length, http: agg };
}, s);

const notice = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
const api = (p, init) => ex(async (p0, i0) => { const r = await fetch('/beatgaler-api/catalog/v1' + p0, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web', ...(i0 && i0.method === 'POST' ? { 'Content-Type': 'application/json', 'X-BeatGaler-CSRF': sessionStorage.getItem('beatgaler:web-csrf:v1') || '' } : {}) }, ...(i0 || {}) }); return { status: r.status, body: await r.json().catch(() => null) }; }, p, init || null);
const beats = async () => ((await api('/beats?limit=200')).body || {}).items || [];
const dropFile = async (name, buf, targetSel = null) => {
  await ex((n, data, sel) => { const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], n, { type: 'audio/mpeg' })); window.__dt = dt; window.__tgt = sel; const t = sel ? document.querySelector(sel) : window; const mk = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); t.dispatchEvent(mk('dragenter')); t.dispatchEvent(mk('dragover')); }, name, Buffer.from(buf).toString('base64'), targetSel);
  await sleep(150);
  await ex(() => { const t = window.__tgt ? document.querySelector(window.__tgt) : window; t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); });
};
const { setName, saveReview } = reviewActions(ex);

async function importBeat(name, buf) {
  const s0 = await snap(); const t0 = Date.now();
  await dropFile(name + '.mp3', buf);
  await waitFor(async () => (await ex(() => /Review beat 1 of 1/.test(document.body.innerText))) || null, { timeout: 30000, msg: 'review' }); await sleep(500);
  await setName(name); await sleep(300);
  const tSave = Date.now(); await saveReview();
  const ok = await waitFor(async () => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*importado\\.').test(await notice()) ? await notice() : null, { timeout: 120000, msg: 'import ' + name }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  const ms = Date.now() - tSave; const m = await since(s0);
  const saved = (await beats()).find((b) => b.name === name);
  return { name, bytes: buf.length, saveToImportedMs: ms, notice: String(ok).slice(0, 80), saved: saved ? { id: saved.id, fileId: saved.playback && saved.playback.fileId } : null, ...m };
}

// Medición de «audio audible»: clic en la carátula → <audio> avanza (currentTime > 50 ms, readyState ≥ 3) con un currentSrc distinto del anterior.
const playMeasured = (beatId, timeout = 20000) => ex(async (id, to) => {
  const el = document.querySelector(`[data-card="${id}"] [data-beat-artwork-id]`) || document.querySelector(`[data-beat-card-id="${id}"] [data-beat-artwork-id]`); if (!el) return { error: 'no-card' };
  const prev = window.__v09Audio ? window.__v09Audio.currentSrc : ''; const t0 = performance.now(); el.click();
  for (;;) { const a = window.__v09Audio; if (a && a.currentSrc && a.currentSrc !== prev && !a.paused && a.currentTime > 0.05 && a.readyState >= 3 && !a.error) return { ms: Math.round(performance.now() - t0), t: a.currentTime, src: a.currentSrc.slice(0, 5) };
    if (performance.now() - t0 > to) return { timeout: true, ms: Math.round(performance.now() - t0), err: a && a.error ? a.error.code : null, paused: a ? a.paused : null, t: a ? a.currentTime : null, ready: a ? a.readyState : null }; await new Promise((r) => setTimeout(r, 5)); }
}, beatId, timeout);
const idbEntries = () => ex(async () => { if (!(await indexedDB.databases()).some((d) => d.name === 'beatgaler-catalog-prefix')) return 0; /* no crearla antes que la app (quedaría sin almacén) */ return new Promise((res) => { const q = indexedDB.open('beatgaler-catalog-prefix', 1); q.onerror = () => res(-1); q.onsuccess = () => { try { const t = q.result.transaction('prefixes', 'readonly').objectStore('prefixes').count(); t.onsuccess = () => res(t.result); t.onerror = () => res(-2); } catch (e) { res(-3); } }; }); });
const clearIdb = () => ex(() => new Promise((res) => { const q = indexedDB.open('beatgaler-catalog-prefix', 1); q.onsuccess = () => { const t = q.result.transaction('prefixes', 'readwrite').objectStore('prefixes').clear(); t.onsuccess = () => res(true); t.onerror = () => res(false); }; q.onerror = () => res(false); }));
const openGallery = async () => { await login(POSTGRES, cfg.account); await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.storeStatus !== 'loading' ? g : null; }, { timeout: 90000, msg: 'gallery' }); await installAudioCapture(); await sleep(1500); };
const nameOf = { A: 'E72 Beat A', B: 'E72 Beat B', C: 'E72 Beat C' };

try {
  await openGallery();
  const ctx = (await api('/context')).body || {};
  rec('E72-CONTEXT', ctx.capabilities && ctx.capabilities.direct && ctx.capabilities.prefixPacks ? 'PASS' : 'FAIL', { capabilities: ctx.capabilities, mode: (await galleryState()).mode });

  if (phase === 'up') {
    for (const k of ['A', 'B', 'C']) { const r = await importBeat(nameOf[k], VARIANTS[k]); rec('UPLOAD-' + k, r.saved ? 'PASS' : 'FAIL', r); await sleep(1500); }
    const have = await beats(); rec('UPLOAD-LIST', 'INFO', { names: have.map((b) => b.name), idbEntries: await idbEntries() });
  }

  if (phase === 'upload-one') { const N = process.env.UPLOAD_NAME || 'E72 Beat D'; const D = Buffer.concat([mp3.subarray(0, 200000), Buffer.from('E72-' + N)]); const r = await importBeat(N, D); rec('UPLOAD-D', r.saved ? 'PASS' : 'FAIL', r); }
  const find = async (k) => (await beats()).find((b) => b.name === nameOf[k]);
  const argv = (k, d) => { const i = args.rest.indexOf(k); return i >= 0 ? args.rest[i + 1] : d; };
  const manifestBrief = async () => { const m = (await api('/prefix-packs/manifest')).body || {}; return { main: m.main ? { version: m.main.version, sizeBytes: m.main.sizeBytes } : null, entries: (m.entries || []).length, pendingCount: m.pendingCount, rebuild: m.rebuild, building: m.building, current: m.current }; };
  const traces = (re) => ex((src) => (window.__pt || []).filter((x) => new RegExp(src).test(x.stage)).map((x) => ({ s: x.stage, t: Math.round(x.t) })), re);
  // Espera a la siguiente renovación de clave (latido cada 60 s; la antelación forzada hace que cada latido renueve) y vuelve `leadMs` después:
  // el siguiente latido cae entonces durante lo que se lance a continuación.
  const armRenewal = async (leadMs) => { const t0 = Date.now(); const base = (await traces('CONTROLLER_CREDENTIAL_REFRESH_READY')).length; let seen = false; await waitFor(async () => { seen = (await traces('CONTROLLER_CREDENTIAL_REFRESH_READY')).length > base; return seen || Date.now() - t0 > 100000; }, { timeout: 110000, interval: 200, msg: 'renewal tick' }); await sleep(leadMs); return { tickSeen: seen, waitedMs: Date.now() - t0 }; };
  const refreshTrace = (fromMs) => ex((t0) => (window.__pt || []).filter((x) => x.stage.includes('CREDENTIAL_REFRESH') && x.t >= t0).map((x) => ({ s: x.stage.replace('CONTROLLER_CREDENTIAL_REFRESH_', ''), afterMs: Math.round(x.t - t0) })), fromMs);

  if (phase === 'cover') {
    // E78: portada por arrastre sobre una BeatCard → sube por Direct B (ARTWORK) y se muestra leyendo de Telegram.
    const b = await find(argv('--beat', 'A')); if (!b) throw new Error('beat no existe');
    await typeSearch(b.name); await sleep(700);
    const cardSel = await ex(() => { const c = document.querySelector('[data-card]'); return c ? `[data-card="${c.getAttribute('data-card')}"]` : null; });
    const s0 = await snap();
    await ex((sel) => (async () => { const cv = Object.assign(document.createElement('canvas'), { width: 256, height: 256 }); const g = cv.getContext('2d'); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 256, 256); g.fillStyle = '#f1c40f'; g.fillRect(64, 64, 128, 128); const blob = await new Promise((res) => cv.toBlob(res, 'image/png')); const dt = new DataTransfer(); dt.items.add(new File([blob], 'portada-e78.png', { type: 'image/png' })); window.__dt = dt; window.__tgt = sel; const t = document.querySelector(sel); const mk = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }); t.dispatchEvent(mk('dragenter')); t.dispatchEvent(mk('dragover')); await new Promise((r2) => setTimeout(r2, 150)); t.dispatchEvent(mk('drop')); })(), cardSel);
    await sleep(1200); await press('Apply crop'); await press('Replace');
    const done = await waitFor(async () => { const x = (await beats()).find((y) => y.id === b.id); return x && x.hasArtwork ? x : null; }, { timeout: 60000, msg: 'artwork committed' }).catch(() => null);
    await sleep(2500); const m = await since(s0);
    const shown = await ex((sel) => { const c = document.querySelector(sel); if (!c) return null; const img = c.querySelector('img'); const bg = [...c.querySelectorAll('*')].map((e) => getComputedStyle(e).backgroundImage).find((v) => v && v.includes('blob:')); return { img: img ? { src: (img.currentSrc || img.src || '').slice(0, 5), w: img.naturalWidth } : null, background: bg ? 'blob' : null }; }, cardSel);
    rec('COVER-UPLOAD-AND-SHOW', done && shown && ((shown.img && shown.img.w > 0) || shown.background) ? 'PASS' : 'FAIL', { hasArtwork: Boolean(done), shown, ...m });
  }

  if (phase === 'project') {
    // E78: PROJECT grande por Direct B con subida por partes REANUDABLE. La sonda fija en SU perfil una antelación de renovación alta para que la
    // clave temporal se renueve durante la subida (cada latido, ~30 s) y espera al momento justo antes de una renovación para guardar.
    const MB = Number(argv('--mb', '48')); const SIZE = MB * 1024 * 1024; const NAME = argv('--name', 'E78 Proyecto');
    const margin = argv('--renew-margin', '590');
    await ex((v) => { localStorage.setItem('bg:lab:renew-margin-s', v); }, margin);
    await browser.url(POSTGRES + '/gallery'); await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.storeStatus !== 'loading' ? g : null; }, { timeout: 90000, msg: 'gallery' }); await sleep(1500);
    await ex((size) => { const chunk = 1 << 20; const parts = []; let x = 123456789; for (let off = 0; off < size; off += chunk) { const n = Math.min(chunk, size - off); const b = new Uint8Array(n); for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; b[i] = x & 0xff; } parts.push(b); } window.__zip = new File(parts, 'e78-proyecto.zip', { type: 'application/zip' });
      if (!window.__pp) { window.__pp = true; const orig = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type !== 'file' || !window.__pick) return orig.call(this); const f = window.__pick; window.__pick = null; const dt = new DataTransfer(); dt.items.add(f); this.files = dt.files; setTimeout(() => this.dispatchEvent(new Event('change', { bubbles: true })), 0); }; } }, SIZE);
    await dropFile(NAME + '.mp3', VARIANTS.C);
    await waitFor(async () => (await ex(() => /Review beat 1 of 1/.test(document.body.innerText))) || null, { timeout: 30000, msg: 'review' }); await sleep(600);
    await setName(NAME); await sleep(300);
    await ex(() => { window.__pick = window.__zip; const rows = [...document.querySelectorAll('span')].filter((sp) => sp.textContent.trim() === 'PROJECT'); const btn = rows[0] && rows[0].parentElement && rows[0].parentElement.querySelector('button'); if (btn) btn.click(); });
    await sleep(1200); await ex(() => { const x = document.querySelector('.bg-catalog-notice button'); if (x) x.click(); });
    // esperar a ~6 s antes de la siguiente renovación (la sesión ya está abierta por la preconexión; los latidos son cada ~30 s)
    await waitFor(async () => (await traces('CONTROLLER_SESSION_DATA_PLANE_READY|CONTROLLER_CREDENTIAL_REFRESH_READY')).length > 0, { timeout: 60000, msg: 'direct session' });
    const tick = await armRenewal(Number(argv('--lead-ms', '53000')));
    const refreshBefore = (await traces('CONTROLLER_CREDENTIAL_REFRESH_BEGIN')).length; const s0 = await snap(); const tSave = Date.now(); const pSave = await ex(() => performance.now());
    await saveReview();
    const ok = await waitFor(async () => new RegExp(NAME + '.*importado\\.').test(await notice()) ? await notice() : null, { timeout: 600000, interval: 500, msg: 'import project' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
    const ms = Date.now() - tSave; const m = await since(s0); const refreshDuring = (await traces('CONTROLLER_CREDENTIAL_REFRESH_BEGIN')).length - refreshBefore;
    const saved = (await beats()).find((x) => x.name === NAME);
    rec('PROJECT-RESUMABLE-UPLOAD', saved && saved.hasProject && /importado/.test(String(ok)) ? (refreshDuring > 0 ? 'PASS' : 'PASS-SIN-RENOVACION') : 'FAIL', { name: NAME, projectBytes: SIZE, saveToImportedMs: ms, renewalsDuringUpload: refreshDuring, tick, renewalTrace: await refreshTrace(pSave), notice: String(ok).slice(0, 90), saved: saved ? { id: saved.id, hasProject: saved.hasProject } : null, manifest: await manifestBrief(), ...m });
    await ex(() => { localStorage.removeItem('bg:lab:renew-margin-s'); });
  }

  if (phase === 'project-download') {
    // E78: descarga del PROJECT desde la UI (Download → Full Project) por Direct B, con renovación de clave durante la lectura; SHA-256 contra el original.
    const MB = Number(argv('--mb', '48')); const SIZE = MB * 1024 * 1024; const NAME = argv('--name', 'E78 Proyecto');
    await ex((v) => { localStorage.setItem('bg:lab:renew-margin-s', v); }, argv('--renew-margin', '590'));
    await browser.url(POSTGRES + '/gallery'); await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.storeStatus !== 'loading' ? g : null; }, { timeout: 90000, msg: 'gallery' }); await sleep(1500);
    const expected = await ex(async (size) => { const chunk = 1 << 20; const parts = []; let x = 123456789; for (let off = 0; off < size; off += chunk) { const n = Math.min(chunk, size - off); const b = new Uint8Array(n); for (let i = 0; i < n; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; b[i] = x & 0xff; } parts.push(b); } const h = await crypto.subtle.digest('SHA-256', await new Blob(parts).arrayBuffer()); return [...new Uint8Array(h)].map((v) => v.toString(16).padStart(2, '0')).join(''); }, SIZE);
    await ex(() => { window.__saved = []; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { const name = this.download; const href = this.href; (async () => { const b = await (await fetch(href)).arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', b); window.__saved.push({ name, size: b.byteLength, sha: [...new Uint8Array(h)].map((v) => v.toString(16).padStart(2, '0')).join('') }); })(); return; } return orig.call(this); }; });
    await typeSearch(NAME); await sleep(800);
    const cardSel = await ex(() => { const c = document.querySelector('[data-beat-card-id]'); return c ? '[data-beat-card-id="' + c.getAttribute('data-beat-card-id') + '"]' : null; });
    await waitFor(async () => (await traces('CONTROLLER_SESSION_DATA_PLANE_READY|CONTROLLER_CREDENTIAL_REFRESH_READY')).length > 0, { timeout: 60000, msg: 'direct session' });
    const tick = await armRenewal(Number(argv('--lead-ms', '56000')));
    const refreshBefore = (await traces('CONTROLLER_CREDENTIAL_REFRESH_BEGIN')).length; const s0 = await snap(); const t0 = Date.now(); const p0 = await ex(() => performance.now());
    const opened = await ex((sel) => { const c = document.querySelector(sel); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 20 })); return new Promise((res) => setTimeout(() => { const m = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.trim() === 'Download'); if (m) m.click(); res(Boolean(m)); }, 250)); }, cardSel);
    await sleep(900);
    const clicked = await ex(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Full Project') && !x.disabled); if (b) b.click(); return Boolean(b); });
    const saved = await waitFor(async () => { const v = await ex(() => window.__saved); return v && v.length ? v[0] : null; }, { timeout: 300000, interval: 500, msg: 'project saved' }).catch((e) => ({ error: String(e.message) }));
    const ms = Date.now() - t0; const m = await since(s0); const refreshDuring = (await traces('CONTROLLER_CREDENTIAL_REFRESH_BEGIN')).length - refreshBefore;
    const okBytes = saved && saved.size === SIZE && saved.sha === expected;
    rec('PROJECT-DOWNLOAD-VERIFIED', okBytes ? (refreshDuring > 0 ? 'PASS' : 'PASS-SIN-RENOVACION') : 'FAIL', { name: NAME, opened, clicked, expectedBytes: SIZE, saved: saved && { name: saved.name, size: saved.size, shaMatches: saved.sha === expected, error: saved.error }, clickToSavedMs: ms, renewalsDuringDownload: refreshDuring, tick, renewalTrace: await refreshTrace(p0), ...m });
    await ex(() => { localStorage.removeItem('bg:lab:renew-margin-s'); });
  }

  if (phase === 'main') {
    // E75: tras ≥5 cambios confirmados el navegador reconstruye el MAIN una vez; aquí solo se observa PostgreSQL (manifiesto).
    const t0 = Date.now(); let brief = await manifestBrief();
    for (let i = 0; i < 40 && !(brief.main && brief.pendingCount === 0); i++) { await sleep(3000); brief = await manifestBrief(); }
    rec('MAIN-STATE', brief.main ? 'PASS' : 'INFO', { waitedMs: Date.now() - t0, ...brief });
  }
  if (phase === 'cold' || phase === 'restart') {
    const s0 = await snap(); rec('IDB-ENTRIES', 'INFO', { phase, entries: await idbEntries() });
    for (const k of ['A', 'B']) {
      const b = await find(k); if (!b) { rec('PLAY-' + k, 'FAIL', { reason: 'beat no existe; ejecuta --phase up' }); continue; }
      if (phase === 'cold') { await clearIdb(); }
      await typeSearch(nameOf[k]); await sleep(700);
      const id = await ex(() => document.querySelector('[data-card]')?.getAttribute('data-card'));
      const s1 = await snap(); const p = await playMeasured(id); await sleep(2500); const m = await since(s1);
      rec(`PLAY-${phase.toUpperCase()}-${k}`, p.timeout || p.error ? 'FAIL' : 'PASS', { measure: p, ...m, audio: await ex(() => { const a = window.__v09Audio; return a ? { t: a.currentTime, d: a.duration, err: a.error && a.error.code } : null; }) });
      await ex(() => { window.__v09Audio && window.__v09Audio.pause(); }); await typeSearch(''); await sleep(400);
    }
  }

  if (phase === 'switch') {
    const ids = []; for (const k of ['A', 'B', 'C']) { await typeSearch(nameOf[k]); await sleep(600); ids.push(await ex(() => document.querySelector('[data-card]')?.getAttribute('data-card'))); }
    await typeSearch(''); await sleep(600);
    const s0 = await snap();
    const seq = []; for (const id of [ids[0], ids[1], ids[2], ids[0], ids[2]]) { seq.push(await ex((i) => { const e = document.querySelector(`[data-card="${i}"] [data-beat-artwork-id]`); if (e) e.click(); return Boolean(e); }, id)); await sleep(120); }
    await sleep(4000); const m = await since(s0);
    const a = await ex(() => { const x = window.__v09Audio; return x ? { paused: x.paused, t: x.currentTime, d: x.duration, err: x.error && x.error.code, src: x.currentSrc.slice(0, 5) } : null; });
    rec('SWITCH-RAPID', a && !a.paused && a.t > 0.3 && !a.err ? 'PASS' : 'FAIL', { clicks: seq, audio: a, ...m });
    const s1 = await snap(); const seekTo = await ex(async () => { const x = window.__v09Audio; const target = x.duration * 0.7; const t0 = performance.now(); x.currentTime = target; for (;;) { if (!x.seeking && x.readyState >= 3 && !x.paused && x.currentTime > target + 0.05) return { ms: Math.round(performance.now() - t0), target, t: x.currentTime }; if (performance.now() - t0 > 20000) return { timeout: true, t: x.currentTime, ready: x.readyState, buffered: [...Array(x.buffered.length).keys()].map((i) => [x.buffered.start(i), x.buffered.end(i)]) }; await new Promise((r) => setTimeout(r, 10)); } });
    rec('SEEK-70', seekTo.timeout ? 'FAIL' : 'PASS', { seek: seekTo, ...(await since(s1)) });
  }

  if (phase === 'replace') {
    const b = await find('A'); if (!b) throw new Error('beat A no existe');
    const fileBefore = b.playback && b.playback.fileId; const idb0 = await idbEntries();
    await typeSearch(nameOf.A); await sleep(700);
    const cardSel = await ex(() => { const c = document.querySelector('[data-card]'); return c ? `[data-card="${c.getAttribute('data-card')}"]` : null; });
    const newBuf = Buffer.concat([mp3.subarray(0, 300000), Buffer.from('E72-REPLACED')]); // mismo audio recortado + marca → hash nuevo
    const s0 = await snap(); await dropFile('reemplazo-e72.mp3', newBuf, cardSel); await sleep(400); await press('Replace');
    const ok = await waitFor(async () => /MP3 reemplazado/.test(await notice()) ? await notice() : null, { timeout: 90000, msg: 'replace' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
    const m = await since(s0); const a2 = await find('A');
    rec('REPLACE-MP3', /reemplazado/.test(String(ok)) && a2 && a2.playback.fileId !== fileBefore ? 'PASS' : 'FAIL', { notice: String(ok).slice(0, 60), fileBefore, fileAfter: a2 && a2.playback.fileId, idbBefore: idb0, idbAfter: await idbEntries(), ...m });
    const id = await ex(() => document.querySelector('[data-card]')?.getAttribute('data-card')); const s1 = await snap(); const p = await playMeasured(id);
    rec('REPLACE-PLAY-NEW', p.timeout ? 'FAIL' : 'PASS', { measure: p, ...(await since(s1)) });
  }

  if (phase === 'packs') {
    // Perfil NUEVO (sin caché): la restauración desde el MAIN (E75) corre 4 s después de abrir; medimos peticiones/bytes y entradas restauradas.
    const s0 = await snap(); const t0 = Date.now();
    const e0 = await idbEntries();
    const got = await waitFor(async () => { const n = await idbEntries(); return n > e0 ? n : null; }, { timeout: 90000, msg: 'prefix restore' }).catch(() => -1);
    await sleep(3000); const m = await since(s0); const man = (await api('/prefix-packs/manifest')).body;
    rec('PACKS-FRESH-PROFILE', got > 0 ? 'PASS' : 'FAIL', { entriesBefore: e0, entriesAfter: await idbEntries(), msToFirstEntry: Date.now() - t0, manifest: man && { main: man.main && { version: man.main.version, sizeBytes: man.main.sizeBytes }, entries: (man.entries || []).length, pendingCount: man.pendingCount, rebuild: man.rebuild }, ...m });
    const b = (await beats())[0]; if (b) { const s1 = await snap(); const p = await playMeasured(b.id); rec('PACKS-PLAY-RESTORED', p.timeout ? 'FAIL' : 'PASS', { measure: p, ...(await since(s1)) }); }
  }
  if (phase === 'e73') {
    // E73: carga NUEVA de la Gallery (sesión web ya iniciada en el perfil) → preconexión (D) → reproducción inmediata (E) o con sesión lista.
    const arg = (k, d) => { const i = args.rest.indexOf(k); return i >= 0 ? args.rest[i + 1] : d; };
    const mode = arg('--mode', 'immediate'); const prefix = arg('--prefix', 'clear'); const label = arg('--label', mode + '-' + prefix); const which = arg('--beat', 'B');
    const target = await find(which); if (!target) throw new Error('beat no existe');
    if (prefix === 'clear') await clearIdb();
    await browser.url(POSTGRES + '/gallery');
    const sel = '[data-card="' + target.id + '"] [data-beat-artwork-id]';
    await waitFor(() => ex((q) => Boolean(document.querySelector(q)), sel), { timeout: 60000, interval: 40, msg: 'card' });
    const tCard = await ex(() => Math.round(performance.now()));
    const stages = () => ex(() => (window.__pt || []).filter((x) => /^(CONTROLLER_|DIRECT_)/.test(x.stage)).map((x) => ({ s: x.stage, t: Math.round(x.t), ...(x.elapsed != null ? { ms: Math.round(x.elapsed) } : {}), ...(x.total != null ? { total: Math.round(x.total) } : {}) })));
    const readyAt = async () => { const st = await stages(); const r = st.find((x) => x.s === 'CONTROLLER_VAULT_PEER_READY') || st.find((x) => x.s === 'CONTROLLER_BACKGROUND_VERIFY_READY'); return r ? r.t : null; };
    if (mode === 'ready') { await waitFor(async () => (await readyAt()) != null, { timeout: 90000, interval: 100, msg: 'direct ready' }); await sleep(300); }
    const s1 = await snap(); const tClick = await ex(() => Math.round(performance.now()));
    const p = await playMeasured(target.id, 30000);
    await waitFor(async () => (await readyAt()) != null, { timeout: 90000, interval: 200, msg: 'direct ready (after play)' }).catch(() => null);
    await sleep(3000); const m = await since(s1);
    const res = await ex(() => performance.getEntriesByType('resource').filter((r) => /catalog\/v1\/(media|files|direct)/.test(r.name)).map((r) => ({ u: r.name.replace(/^.*catalog\/v1\//, '').replace(/[A-Za-z0-9_-]{16,}/g, '#').slice(0, 40), t: Math.round(r.startTime), ms: Math.round(r.duration), b: r.encodedBodySize || 0 })));
    const st = await stages();
    const pick = (n) => st.find((x) => x.s === n) || null;
    rec('E73-' + label.toUpperCase(), p.timeout || p.error ? 'FAIL' : 'PASS', { mode, prefix, beat: which, cardVisibleAtMs: tCard, clickAtMs: tClick, timeToAudioMs: p.ms, measure: p,
      direct: { prepareBegin: pick('CONTROLLER_SESSION_PREPARE_BEGIN'), prepareDone: pick('CONTROLLER_SESSION_PREPARE_DONE'), initializeDone: pick('CONTROLLER_SESSION_INITIALIZE_DONE'), dataPlaneReady: pick('CONTROLLER_SESSION_DATA_PLANE_READY'), vaultPeerReadyAtMs: await readyAt(), connects: st.filter((x) => x.s === 'CONTROLLER_CONNECT_NEW').length },
      fetches: await ex((t0) => (window.__fx || []).filter((x) => x.t >= t0 - 50 && /^(media|files|direct)/.test(x.u)), tClick), gatewayMediaRequests: res.filter((r) => r.u.startsWith('media')).length, gatewayMediaBytes: res.filter((r) => r.u.startsWith('media')).reduce((a, r) => a + r.b, 0), sessionRequests: res.filter((r) => r.u.startsWith('direct')), ...m });
  }
} catch (e) { rec('E72', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
