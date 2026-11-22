// E2E real (2026-11-20): UI real en Chrome aislado contra LAB REAL (Bot20/MASTER 2/testborrar). Edicion, filtros, papelera, restauracion y seek.
//   . tmp/e72tmp/labenv-e2e.sh; node scripts/catalog-lab/probe-e2e-ui.mjs --phase discover|edit|filter|trash|seek
// Solo opera sobre beats propios de pruebas (nombre "E72 ..."/"E2E ..."). No borra nada en Telegram.
import { cardActions, parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const phase = args.rest[args.rest.indexOf('--phase') + 1] || 'discover';
const R = await createRun({ kind: `e2e-ui-${phase}`, args });
if (!R) process.exit(0);
const { rec, ex, waitFor, login, galleryState, typeSearch, installAudioCapture, browser, POSTGRES, cfg, sleep } = R;

const api = (p, init) => ex(async (p0, i0) => {
  const csrf = (document.cookie.match(/(?:^|; )(?:bg_csrf|csrf)[^=]*=([^;]*)/) || [])[1];
  const r = await fetch('/beatgaler-api/catalog/v1' + p0, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' }, ...(i0 || {}) });
  let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b };
}, p, init);
const beats = async () => ((await api('/beats?limit=200')).body || {}).items || [];
const openGallery = async () => { await login(POSTGRES, cfg.account); await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.storeStatus !== 'loading' ? g : null; }, { timeout: 90000, msg: 'gallery' }); await installAudioCapture(); await sleep(1200); };
const { cardOf, menu } = cardActions(ex);
const dump = () => ex(() => ({ inputs: [...document.querySelectorAll('input,textarea,select')].filter((e) => e.offsetParent !== null).map((e) => ({ t: e.tagName, type: e.type, ph: e.placeholder, v: String(e.value).slice(0, 40), aria: e.getAttribute('aria-label') })), buttons: [...document.querySelectorAll('button')].filter((e) => e.offsetParent !== null).map((e) => (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 30)).filter(Boolean).slice(0, 60) }));

try {
  await openGallery();
  if (phase === 'discover') {
    const list = await beats(); rec('LIST', 'INFO', { names: list.map((b) => b.name) });
    await typeSearch('E72 Beat B'); const id = await cardOf('E72 Beat B'); rec('CARD', id ? 'PASS' : 'FAIL', { id });
    const opened = await menu(id, 'Edit metadata'); await sleep(900); rec('DRAWER', 'INFO', { opened, ...(await dump()) });
  }
  const setVal = (idx, v) => ex((i, x) => { try { return setVal0(i, x); } catch (e) { return 'ERR ' + e.message; } function setVal0(i, x) { const els = [...document.querySelectorAll('input:not([type=search]):not([type=file]):not([type=checkbox]):not([type=range])')].filter((e) => e.offsetParent !== null); const e = els[i]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, x); e.dispatchEvent(new Event('input', { bubbles: true })); return els.length; } }, idx, v);
  const press = (l) => ex((t) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t && !x.disabled); b?.click(); return Boolean(b); }, l);
  const noticeText = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
  const byName = async (n) => (await beats()).find((b) => b.name === n);
  const clearSearch = async () => { await typeSearch(''); await sleep(500); };
  if (phase === 'all' || phase === 'edit') {
    // EDIT: renombrar, etiqueta, BPM (UI) -> persistencia (API PostgreSQL) -> sobrevive a recarga
    const NEW = 'E2E Beat B edit';
    await typeSearch('E72 Beat B'); const id = await cardOf('E72 Beat B');
    if (!id) rec('EDIT-OPEN', 'FAIL', { why: 'sin tarjeta' }); else {
      const op = await menu(id, 'Edit metadata'); await sleep(900); rec('EDIT-DRAWER', 'INFO', { op, ...(await dump()) });
      rec('SETVAL', 'INFO', { r: await setVal(0, NEW) }); await sleep(200);
      await ex(() => { const i = [...document.querySelectorAll('input:not([type=search]):not([type=file]):not([type=checkbox]):not([type=range])')].find((e) => e.placeholder.startsWith('Add tag')); i.focus(); });
      await setVal(1, "e2e-tag"); await ex(() => { const i = [...document.querySelectorAll('input:not([type=search]):not([type=file]):not([type=checkbox]):not([type=range])')].find((e) => e.placeholder.startsWith('Add tag')); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true })); }); await sleep(300);
      await setVal(2, "140"); await sleep(200);
      const saved = await press('Save changes');
      const ok = await waitFor(async () => (await byName(NEW)) || null, { timeout: 30000, msg: 'rename' }).catch(() => null);
      const detail = ok ? (await api('/beats/' + ok.id)).body : null;
      rec('EDIT-RENAME-TAG-BPM', ok && JSON.stringify(detail).includes('e2e-tag') ? 'PASS' : 'FAIL', { saved, notice: await noticeText(), bpm: detail && detail.bpm, tags: detail && detail.tags, version: ok && ok.version });
      await browser.url(POSTGRES + '/gallery'); await sleep(2500); await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.storeStatus !== 'loading' ? g : null; }, { timeout: 60000, msg: 'gallery reload' });
      await typeSearch(NEW); rec('EDIT-PERSIST-AFTER-RELOAD', (await cardOf(NEW)) ? 'PASS' : 'FAIL', {});
    }
  }
  if (phase === 'all' || phase === 'filter') {
    await clearSearch();
    const total = (await beats()).length;
    await typeSearch('E72 Beat'); const a = (await galleryState()).cards; rec('FILTER-SEARCH-SUBSTRING', a >= 2 && a < total ? 'PASS' : 'FAIL', { shown: a, total });
    await typeSearch('zzz-no-such-beat'); const z = (await galleryState()).cards; rec('FILTER-SEARCH-EMPTY', z === 0 ? 'PASS' : 'FAIL', { shown: z });
    await clearSearch();
    // etiqueta: clic en la tag bar
    await R.openTagBar(); await sleep(500);
    const tagClicked = await ex(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'e2e-tag'); b?.click(); return Boolean(b); }); await sleep(900);
    const tg = (await galleryState()).cards; rec('FILTER-TAG', tagClicked && tg === 1 ? 'PASS' : 'FAIL', { tagClicked, shown: tg });
    await ex(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'e2e-tag'); b?.click(); }); await sleep(800);
    const all = (await galleryState()).cards; rec('FILTER-TAG-CLEAR', all === total ? 'PASS' : 'FAIL', { shown: all, total });
  }
  if (phase === 'all' || phase === 'trash') {
    await clearSearch();
    const NAME = 'E72 Beat C'; const before = await byName(NAME);
    await typeSearch(NAME); const id = await cardOf(NAME);
    const used = await menu(id, 'Remove from library'); await sleep(900);
    rec('TRASH-DIALOG', 'INFO', { used, ...(await dump()) });
    await press('Remove'); await press('Move to trash'); await press('Delete'); await press('Confirm'); await sleep(2500);
    const after = await byName(NAME);
    rec('TRASH-REMOVED-FROM-LIST', before && !after ? 'PASS' : 'FAIL', { before: Boolean(before), after: Boolean(after) });
    const trashed = (await api('/beats?state=TRASH&limit=50')).body;
    rec('TRASH-LISTED', JSON.stringify(trashed).includes(NAME) ? 'PASS' : 'INFO', { sample: JSON.stringify(trashed).slice(0, 200) });
  }
  const play = (id, to = 25000) => ex(async (cid, t) => {
    const el = document.querySelector(`[data-beat-card-id="${cid}"] [data-beat-artwork-id]`); if (!el) return { error: 'no-card' };
    const prev = window.__v09Audio ? window.__v09Audio.currentSrc : ''; const t0 = performance.now(); el.click();
    for (;;) { const a = window.__v09Audio; if (a && a.currentSrc && a.currentSrc !== prev && !a.paused && a.currentTime > 0.05 && a.readyState >= 3 && !a.error) return { ms: Math.round(performance.now() - t0), d: a.duration };
      if (performance.now() - t0 > t) return { timeout: true, err: a && a.error ? a.error.code : null, t: a && a.currentTime, ready: a && a.readyState }; await new Promise((r) => setTimeout(r, 50)); }
  }, id, to);
  const seekTo = (frac, to = 30000) => ex(async (f, t) => {
    const a = window.__v09Audio; const target = a.duration * f; const t0 = performance.now(); a.currentTime = target;
    for (;;) { if (!a.seeking && !a.paused && a.readyState >= 3 && a.currentTime >= target && a.currentTime < target + 5 && !a.error) { const c0 = a.currentTime; await new Promise((r) => setTimeout(r, 1200)); return { ok: a.currentTime > c0 + 0.5, ms: Math.round(performance.now() - t0), target: Number(target.toFixed(1)), at: Number(a.currentTime.toFixed(1)) }; }
      if (performance.now() - t0 > t) return { timeout: true, target, at: a.currentTime, paused: a.paused, seeking: a.seeking, ready: a.readyState, err: a.error ? a.error.code : null }; await new Promise((r) => setTimeout(r, 50)); }
  }, frac, to);
  if (phase === 'all' || phase === 'seek') {
    await clearSearch(); await typeSearch('E72 Beat A'); const id = await cardOf('E72 Beat A');
    const p = await play(id); rec('PLAY-A', p.d ? 'PASS' : 'FAIL', p);
    for (const f of [0.6, 0.9, 0.1]) { const r = await seekTo(f); rec('SEEK-' + f, r.ok ? 'PASS' : 'FAIL', r); }
    const pause = await ex(async () => { const a = window.__v09Audio; a.pause(); const t = a.currentTime; await new Promise((r) => setTimeout(r, 800)); const p0 = a.paused; a.play(); await new Promise((r) => setTimeout(r, 1200)); return { pausedStays: p0, resumed: !a.paused && a.currentTime > t }; });
    rec('PAUSE-RESUME', pause.pausedStays && pause.resumed ? 'PASS' : 'FAIL', pause);
  }
  if (phase === 'auth') {
    await R.logout(); await browser.url(POSTGRES + '/gallery'); await waitFor(async () => (await browser.$('#auth-login-identifier').isExisting()) || null, { timeout: 60000, msg: 'login form' });
    rec('AUTH-LOGGED-OUT-SHOWS-LOGIN', 'PASS', {});
    await browser.$('#auth-login-identifier').setValue(cfg.account.email); await browser.$('#auth-login-password').setValue('clave-incorrecta-e2e'); await browser.$('.bg-auth-form button[type="submit"]').click(); await sleep(3000);
    const still = await browser.$('#auth-login-identifier').isExisting(); const msg = await ex(() => [...document.querySelectorAll('[role=alert],.bg-auth-error,[class*=error]')].map((e) => e.innerText).join(' / ').slice(0, 200) || 'sin-alerta');
    rec('AUTH-WRONG-PASSWORD-REJECTED', still ? 'PASS' : 'FAIL', { msg });
    await openGallery(); rec('AUTH-LOGIN-OK', (await galleryState()).cards > 0 ? 'PASS' : 'FAIL', {});
    await browser.url(POSTGRES + '/gallery'); await sleep(2500); const g = await waitFor(async () => { const x = await galleryState(); return x.mode === 'postgres' && x.cards > 0 ? x : null; }, { timeout: 60000, msg: 'session persists' }).catch(() => null);
    rec('AUTH-SESSION-SURVIVES-RELOAD', g ? 'PASS' : 'FAIL', {});
  }
  if (phase === 'outage') {
    // Corte de red del navegador (CDP) con la sesion abierta: durante el corte la reproduccion de un beat sin cache debe fallar de forma limpia;
    // al volver la red debe recuperarse SIN recargar. Cache de prefijos vaciada para forzar lectura real por Telegram.
    const secs = Number(process.env.OUTAGE_S || 75);
    await clearSearch(); await ex(() => new Promise((res) => { const q = indexedDB.open('beatgaler-catalog-prefix', 1); q.onsuccess = () => { const t = q.result.transaction('prefixes', 'readwrite').objectStore('prefixes').clear(); t.onsuccess = () => res(true); t.onerror = () => res(false); }; q.onerror = () => res(false); }));
    const ids = await ex(() => [...document.querySelectorAll('[data-beat-card-id]')].map((c) => c.getAttribute('data-beat-card-id')));
    const r0 = await play(ids[0]); rec('OUTAGE-0-PLAY-BEFORE', r0.d ? 'PASS' : 'FAIL', r0); await ex(() => { window.__v09Audio?.pause(); });
    await R.cdp('Network.enable'); await R.cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await sleep(secs * 1000);
    const r1 = await play(ids[1], 20000); rec('OUTAGE-1-PLAY-OFFLINE', r1.timeout || r1.error ? 'PASS' : 'INFO', { note: 'esperado: falla o espera sin colgar la UI', ...r1, ui: await ex(() => document.querySelector('.bg-catalog-notice')?.textContent || null) });
    await R.cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(3000);
    const r2 = await play(ids[2], 60000); rec('OUTAGE-2-RECOVERS-WITHOUT-RELOAD', r2.d ? 'PASS' : 'FAIL', r2);
    const tr = await ex(() => (window.__pt || []).slice(-8).map((x) => x.stage)); rec('OUTAGE-TRACE', 'INFO', { tr });
  }
  if (phase === 'main2') {
    await clearSearch(); const mf = async () => { const m = ((await api('/prefix-packs/manifest')).body) || {}; return { main: m.main ? { v: m.main.version, size: m.main.sizeBytes } : null, pending: m.pendingCount, rebuild: m.rebuild, building: m.building, current: m.current, pendingIds: (m.pending || []).map((p) => p.fileId) }; };
    rec('MAIN2-BEFORE', 'INFO', await mf());
    const ids = await ex(() => [...document.querySelectorAll('[data-beat-card-id]')].map((c) => c.getAttribute('data-beat-card-id')));
    for (const id of ids) { const r = await play(id, 30000); rec('MAIN2-PLAY', r.d ? 'PASS' : 'FAIL', { id, ...r }); await ex(() => { window.__v09Audio?.pause(); }); await sleep(800); }
    await browser.url(POSTGRES + '/gallery'); await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && g.storeStatus !== 'loading' ? g : null; }, { timeout: 90000, msg: 'gallery' });
    let m = await mf(); for (let i = 0; i < 30 && !m.main; i++) { await sleep(3000); m = await mf(); }
    rec('MAIN2-PUBLISHED', m.main ? 'PASS' : 'FAIL', m);
  }
  if (phase === 'download') {
    const DL = process.env.DL_NAME || 'E72 Beat A'; const DL_BYTES = Number(process.env.DL_BYTES || 0); await clearSearch(); await typeSearch(DL); const id = await cardOf(DL);
    await ex(() => { window.__saved = []; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { const name = this.download; const href = this.href; (async () => { const b = await (await fetch(href)).arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', b); const u8 = new Uint8Array(b); const hx = (x) => [...x].map((v) => v.toString(16).padStart(2, '0')).join(''); window.__saved.push({ head: hx(u8.subarray(0, 48)), tail: hx(u8.subarray(u8.length - 140)), name, size: b.byteLength, sha: [...new Uint8Array(h)].map((v) => v.toString(16).padStart(2, '0')).join('') }); })(); return; } return orig.call(this); }; });
    await menu(id, 'Download'); await sleep(1200); rec('DOWNLOAD-DIALOG', 'INFO', await dump());
    const clicked = await ex(() => { const b = [...document.querySelectorAll('button')].find((x) => /MP3|Master|Audio|WAV/i.test(x.textContent) && !x.disabled); if (b) b.click(); return b ? b.textContent.trim() : null; });
    const saved = await waitFor(async () => { const v = await ex(() => window.__saved); return v && v.length ? v[0] : null; }, { timeout: 90000, interval: 500, msg: 'saved' }).catch((e) => ({ error: String(e.message) }));
    const fs = await import('node:fs'); const crypto = await import('node:crypto'); const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'tmp', 'gallery-test', 'Galer E2E Beat.mp3'));
    const srcB = DL_BYTES ? src.subarray(0, DL_BYTES) : src; const sha = crypto.createHash('sha256').update(srcB).digest('hex'); const head = Buffer.from(String(saved && saved.size));
    rec('DOWNLOAD-MASTER-SHA', saved && saved.sha === sha ? 'PASS' : 'FAIL', { clicked, saved, expectedBytes: srcB.length, expectedSha: sha.slice(0, 12) });
  }
  if (phase === 'restore') {
    await ex(() => { [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Settings' || x.textContent.trim() === 'Settings')?.click(); }); await sleep(900);
    await ex(() => { [...document.querySelectorAll('button')].find((x) => /^Trash/i.test(x.textContent.trim()))?.click(); }); await sleep(1200);
    rec('SETTINGS-TRASH', 'INFO', { ...(await dump()), text: await ex(() => document.body.innerText.slice(0, 600)) });
    const before = await byName('E72 Beat C');
    await ex(() => { [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Restore')?.click(); }); await sleep(3000);
    const after = await byName('E72 Beat C');
    rec('RESTORE-FROM-TRASH-UI', !before && after && after.state !== 'TRASH' ? 'PASS' : 'FAIL', { before: Boolean(before), after: after && after.state });
  }
} catch (e) { rec('ERROR-RUN', 'FAIL', { message: String(e && e.message).slice(0, 300) }); }
await R.finish();
