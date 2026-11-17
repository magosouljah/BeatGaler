// Sonda LAB: avisos flotantes (no mueven el layout), liquid-glass de la toolbar sobre portadas, buscador persistente y cursores (Chrome aislado, Cloud real + gateway FAKE + PostgreSQL efímero).
//   node scripts/catalog-lab/probe-ui-polish.mjs [--out DIR]   (VIS_W=ancho para otro tamaño de ventana)
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'ui-polish', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, browser, POSTGRES, cfg, sleep } = R;

const BUILD = `window.__png = async (name) => { const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }); const g = cv.getContext('2d'); const gr = g.createLinearGradient(0, 0, 64, 64); gr.addColorStop(0, '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')); gr.addColorStop(1, '#222'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new File([await new Promise((r) => cv.toBlob(r, 'image/png'))], name, { type: 'image/png' }); };`;
const dropImageOnFirstCard = () => ex(() => (async () => {
  const card = document.querySelector('[data-beat-card-id]'); const dt = new DataTransfer(); dt.items.add(await window.__png('cover.png'));
  const mk = (t) => new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt });
  card.dispatchEvent(mk('dragenter')); card.dispatchEvent(mk('dragover')); await new Promise((r) => setTimeout(r, 200)); card.dispatchEvent(mk('drop'));
})());
const noticeInfo = () => ex(() => { const n = document.querySelector('.bg-floating-notice'); if (!n) return null; const r = n.getBoundingClientRect(); const cs = getComputedStyle(n); return { text: n.querySelector('.bg-floating-notice-text')?.textContent, tone: n.dataset.noticeTone, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, position: getComputedStyle(n.parentElement).position, backdrop: cs.backdropFilter || cs.webkitBackdropFilter, inViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight }; });
const layout = () => ex(() => { const sc = document.querySelector('[data-library-scroll="true"]'); const c = document.querySelector('[data-beat-card-id]'); const r = (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((v) => +v.toFixed(1)).join(','); }; return { scrollTop: sc.scrollTop, scroller: r(sc), firstCard: r(c), docH: document.documentElement.scrollHeight, bodyH: document.body.scrollHeight, status: r(document.querySelector('.bg-catalog-shell-status')) }; });
const overlaps = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
const rectOf = (sel) => ex((s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; }, sel);

try {
  await login(POSTGRES, cfg.account);
  if (Number(process.env.VIS_W)) { await browser.setWindowSize(Number(process.env.VIS_W), 900); await sleep(800); }
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'cards' });
  await ex((b) => (0, eval)(b), BUILD);

  // ---- 1. Aviso flotante de éxito: no altera layout ni scroll; desaparece solo ----
  const l0 = await layout();
  await dropImageOnFirstCard();
  const ok = await waitFor(async () => { const n = await noticeInfo(); return n && /Portada actualizada/.test(n.text) ? n : null; }, { timeout: 40000, msg: 'success notice' }).catch(() => null);
  await sleep(500); const l1 = await layout(); await shot('ui-notice-success');
  const toolbar = await rectOf('.lab-gallery-toolbar-float'); const addBtn = await ex(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Add beat')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
  const player = await rectOf('.lab-player, [data-testid="player"]');
  rec('UI-NOTICE-success-floats', ok && ok.position === 'fixed' && ok.tone === 'success' && /blur/.test(ok.backdrop || '') && ok.inViewport && JSON.stringify(l0) === JSON.stringify(l1) && !overlaps(ok.rect, toolbar) && (!addBtn || !overlaps(ok.rect, addBtn)) && (!player || !overlaps(ok.rect, player)) ? 'PASS' : 'FAIL', { ok, toolbar, addBtn, player, layoutBefore: l0, layoutAfter: l1 });
  const gone = await waitFor(async () => (await noticeInfo()) === null || null, { timeout: 8000, msg: 'auto-dismiss' }).catch(() => false);
  const l2 = await layout();
  rec('UI-NOTICE-success-autodismiss', gone && JSON.stringify(l0) === JSON.stringify(l2) ? 'PASS' : 'FAIL', { gone, layoutEnd: l2 });

  // ---- 1b. Aviso de error real (la subida falla): permanece, no altera layout ----
  await ex(() => { if (!window.__f) { window.__f = window.fetch; window.fetch = (u, o) => (String(u?.url ?? u).includes('/transfer/upload') ? Promise.resolve(new Response(JSON.stringify({ code: 'BOOM', error: 'upload failed (simulado en el LAB)' }), { status: 500, headers: { 'Content-Type': 'application/json' } })) : window.__f(u, o)); } });
  await dropImageOnFirstCard();
  const err = await waitFor(async () => { const n = await noticeInfo(); return n && n.tone === 'error' ? n : null; }, { timeout: 40000, msg: 'error notice' }).catch(() => null);
  await sleep(500); const l3 = await layout(); await shot('ui-notice-error'); await sleep(6000); const still = await noticeInfo();
  rec('UI-NOTICE-error-persists', err && err.position === 'fixed' && err.inViewport && still && still.tone === 'error' && JSON.stringify(l0) === JSON.stringify(l3) ? 'PASS' : 'FAIL', { err, stillAfter6s: Boolean(still), layoutAfter: l3 });
  await ex(() => { window.fetch = window.__f; window.__f = null; document.querySelector('.bg-floating-notice-close')?.click(); });

  // ---- 3. Toolbar liquid-glass: el fondo de la lente contiene las portadas (antes: lienzo plano #0c0c0c) ----
  await ex(() => { const sc = document.querySelector('[data-library-scroll="true"]'); sc.scrollTop = 120; }); await sleep(900);
  const glass = await ex(() => { const c = document.querySelector('.studio-candidate-canvas'); const imgs = [...document.querySelectorAll('.bg-catalog-track [data-beat-artwork-id] img:not([alt=""])')].filter((i) => i.complete && i.naturalWidth); const st = document.querySelector('.studio-candidate-stage'); const sr = st.getBoundingClientRect(); const behind = imgs.filter((i) => { const r = i.getBoundingClientRect(); return !(r.right < sr.left || r.left > sr.right || r.bottom < sr.top || r.top > sr.bottom); }).length; return { engine: st.dataset.glassEngine, ready: c?.dataset.engineReady, background: c?.dataset.background, coversBehindToolbar: behind, canvas: c ? [c.width, c.height] : null }; });
  await shot('ui-toolbar-glass-scrolled');
  rec('UI-TOOLBAR-glass-backdrop', glass.engine === 'studio' && glass.ready === 'true' && glass.background === 'gallery-artwork' && glass.coversBehindToolbar > 0 ? 'PASS' : 'FAIL', glass);

  // ---- 4. Buscador persistente ----
  await ex(() => { document.querySelector('[data-library-scroll="true"]').scrollTop = 0; }); await sleep(300);
  const searchOpen = () => ex(() => document.querySelector('.studio-search')?.classList.contains('is-open'));
  await ex(() => document.querySelector('.studio-search > button').click()); await sleep(500);
  const wasOpen = await searchOpen(); await typeSearch('V09 Beat 02'); await sleep(900);
  const resultsBefore = (await galleryState()).cards;
  await ex(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))); await (await browser.$('body')).click({ x: 20, y: 400 }).catch(() => {}); await sleep(600);
  const keptOpen = await searchOpen(); const value = await ex(() => document.querySelector('.studio-search input').value); const resultsAfter = (await galleryState()).cards;
  await ex(() => document.querySelector('button[aria-label="Sort beats"]').click()); await sleep(500); const afterMenu = await searchOpen(); await ex(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))); await sleep(300);
  await shot('ui-search-persistent');
  rec('UI-SEARCH-persists-with-text', wasOpen && keptOpen && afterMenu && value === 'V09 Beat 02' && resultsBefore === resultsAfter ? 'PASS' : 'FAIL', { wasOpen, keptOpen, afterMenu, value, resultsBefore, resultsAfter });
  await typeSearch(''); await sleep(700); await ex(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))); await sleep(700);
  const closedWhenEmpty = !(await searchOpen());
  rec('UI-SEARCH-closes-when-empty', closedWhenEmpty ? 'PASS' : 'FAIL', { closedWhenEmpty });

  // ---- 5. Cursores ----
  await ex(() => document.querySelector('.studio-search > button').click()); await sleep(300);
  const cursors = await ex(() => { const tags = [...document.querySelectorAll('.lab-gallery-tag')]; const input = document.querySelector('.studio-search input'); return { tags: tags.length, tagCursors: [...new Set(tags.map((t) => getComputedStyle(t).cursor))], tagLabelCursors: [...new Set(tags.map((t) => getComputedStyle(t.querySelector('.lab-gallery-tag-label') || t).cursor))], cancelX: (() => { for (const sh of document.styleSheets) { try { for (const r of sh.cssRules) if (/search-cancel-button/.test(r.selectorText || '') && r.style.cursor) return r.style.cursor; } catch (e) { /* hoja externa */ } } return null; })(), bodyCursor: getComputedStyle(document.body).cursor, grid: getComputedStyle(document.querySelector('.bg-catalog-track')).cursor }; });
  rec('UI-CURSORS', cursors.tags > 0 && cursors.tagCursors.join() === 'pointer' && cursors.tagLabelCursors.join() === 'pointer' && cursors.cancelX === 'pointer' && cursors.grid !== 'pointer' ? 'PASS' : 'FAIL', cursors);
  rec('UI-LOGS', 'INFO', { severe: (await browser.getLogs('browser').catch(() => [])).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 200)) });
} catch (e) { rec('UI', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
