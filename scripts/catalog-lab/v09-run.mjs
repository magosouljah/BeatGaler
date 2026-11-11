// V09 — Regresión en navegador real contra el LAB (Cloud real + gateway FAKE + PG efímero). Uso:
//   node scripts/catalog-lab/v09-run.mjs [--browser chrome|edge] [--out DIR] [--only ID,ID] [--skip ID] [--headed]
// Casos (IDs para --only): ENV GEOM SCROLL FOCUS QUERY INTERACTION MEDIA RESOURCES BULKTAGS ZOOM200 REDUCEDMOTION TOUCH LEGACY AUTH
// (MOUNT corre siempre.) 14 casos originales V09 + BULKTAGS/ZOOM200/REDUCEDMOTION/TOUCH, estos 3 últimos EMULADOS por CDP (no hardware real).
// Los estados son: PASS | FAIL | INFO | RECORDED | NO EJECUTADO | ERROR. Un PASS aquí es evidencia LAB, jamás de un gate.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, createRun, edgeInstalled } from './browser-common.mjs';

const args = parseArgs();
const R = await createRun({ kind: 'v09', args });
if (!R) { process.exit(0); }
const { browser, rec, want, ex, shot, waitFor, sleep, cdp, setViewport, login, logout, galleryState, installAudioCapture, audioState, typeSearch, openTagBar, scrollTo, drainNet, apiReqs, NET, POSTGRES, LEGACY, cfg, N, OUT } = R;
const expectBounded = (s) => s.cards > 0 && s.cards <= s.columns * (Math.ceil(s.clientHeight / (s.rowHeight + 28)) + 2 * 8 + 3);
const EM = 'EMULADO'; // etiqueta explícita de casos emulados
const searchHits = Math.max(0, Math.min(N, 20) - 10); // "V09 Beat 01" → nombres 010..019
const cancelSelection = async () => { if (await browser.$('[aria-label="Cancel selection"]').isExisting()) { await browser.$('[aria-label="Cancel selection"]').click().catch(() => {}); await sleep(300); } };
const detailOf = (id) => ex(async (i) => (await fetch(`/beatgaler-api/catalog/v1/beats/${encodeURIComponent(i)}`, { credentials: 'include' })).json(), id);

try {
  // ---------- ENV ----------
  if (want('ENV')) {
    const caps = browser.capabilities;
    const env = await ex(() => ({ ua: navigator.userAgent, dpr: devicePixelRatio, viewport: [innerWidth, innerHeight], reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, hover: matchMedia('(hover: hover)').matches, pointer: matchMedia('(pointer: fine)').matches ? 'fine' : 'coarse', hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null }));
    const refresh = await ex(() => new Promise((res) => { let n = 0; const s = performance.now(); const f = () => { n++; if (performance.now() - s >= 1000) res(n); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
    const manifest = { browser: { name: caps.browserName, version: caps.browserVersion, headless: !args.headed }, page: env, refreshHz: refresh, edge: edgeInstalled() ? (args.browser === 'edge' ? 'EJECUTADO en esta corrida' : 'instalado; no usado en esta corrida (--browser edge)') : 'NO INSTALADO', screenReader: 'NO EJECUTADO (no automatizable aquí)', zoom200: 'EMULADO por CDP (Emulation.setDeviceMetricsOverride 720x450@2x), no zoom real del navegador', touch: 'EMULADO por CDP, sin pantalla táctil real', reducedMotion: 'EMULADO por CDP (setEmulatedMedia)', lab: { cloud: `http://127.0.0.1:${cfg.ports.cloud}`, beats: N, account: cfg.account.userId } };
    fs.writeFileSync(path.join(OUT, 'v09-manifest.json'), JSON.stringify(manifest, null, 2));
    rec('ENV', 'RECORDED', { browser: `${caps.browserName} ${caps.browserVersion}`, refreshHz: refresh, dpr: env.dpr });
  }

  // ---------- login POSTGRES + MOUNT ----------
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'catalog cards' });
  await drainNet();
  let s = await galleryState(); await shot('01-postgres-gallery-1440');
  const catalogRequests = await apiReqs(/^\/catalog\/v1\//); const legacyIndexRequests = await apiReqs(/^\/transport\/(index|session|trash|quota|topic|project)|^\/library\//);
  rec('MOUNT', s.mode === 'postgres' && s.composition === 'catalog' && s.chrome && s.toolbar && s.tagBar && !s.pager && legacyIndexRequests === 0 && catalogRequests > 0 ? 'PASS' : 'FAIL', { mode: s.mode, composition: s.composition, chrome: s.chrome, toolbar: s.toolbar, tagBar: s.tagBar, pager: s.pager, cards: s.cards, setsize: s.setsize, legacyIndexRequests, catalogRequests });

  // ---------- C12-V-GEOM ----------
  if (want('GEOM')) {
    const geom = [];
    for (const w of [1440, 1401, 1400, 1161, 1160, 941, 940, 768, 751, 750, 591, 590, 375, 360, 359]) {
      await setViewport(w, 900); await sleep(400);
      const g = await galleryState(); const iw = await ex(() => innerWidth);
      const expectedCols = iw <= 359 ? 1 : iw <= 590 ? 2 : iw <= 750 ? 3 : iw <= 940 ? 4 : iw <= 1160 ? 5 : iw <= 1400 ? 6 : 7;
      const pitchOk = g.rowTops.length > 1 ? Math.abs((g.rowTops[1] - g.rowTops[0]) - (g.rowHeight + parseFloat(g.cssVars.rowGap))) <= 1 : true;
      const ok = g.columns === expectedCols && Number(g.cssVars.cols) === expectedCols && g.cardWidth <= 160 && g.dupIds === 0 && g.contiguous && pitchOk && expectBounded(g);
      geom.push({ w, innerWidth: iw, ok, columns: g.columns, cssCols: g.cssVars.cols, cardWidth: g.cardWidth, cardHeight: g.cardHeight, pitch: g.rowTops.length > 1 ? g.rowTops[1] - g.rowTops[0] : null, rowGap: g.cssVars.rowGap, cards: g.cards });
      if ([1440, 768, 375].includes(w)) await shot(`02-geom-${w}`);
    }
    const hscroll = await ex(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    rec('C12-V-GEOM', geom.every((g) => g.ok) && !hscroll ? 'PASS' : 'FAIL', { widths: geom, horizontalOverflow: hscroll });
    try { await setViewport(1440, 900, 2); await sleep(300); const g2 = await galleryState(); await shot('02-geom-1440-dpr2'); rec('C12-V-GEOM-DPR2', g2.columns === 7 && g2.cardWidth <= 160 && g2.dupIds === 0 ? 'PASS' : 'FAIL', { dpr: await ex(() => devicePixelRatio), columns: g2.columns, cardWidth: g2.cardWidth, nota: 'DPR 2 por BiDi setViewport (EMULADO)' }); await setViewport(1440, 900, 1); } catch (e) { rec('C12-V-GEOM-DPR2', 'NO EJECUTADO', { reason: e.message.slice(0, 120) }); }
    await setViewport(1440, 900); await sleep(300);
  }

  // ---------- C12-V-SCROLL + BORDER ----------
  if (want('SCROLL')) {
    const seenIds = new Set(); let maxCards = 0; let maxNodes = 0; const steps = [];
    const scroller = await browser.$('[data-library-scroll="true"]');
    for (let i = 0; i < Math.max(80, Math.ceil(N / 3)); i++) {
      await ex(() => { const el = document.querySelector('[data-library-scroll="true"]'); el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + el.clientHeight * 0.5); });
      await sleep(220);
      const g = await galleryState(); maxCards = Math.max(maxCards, g.cards); maxNodes = Math.max(maxNodes, g.domNodes);
      for (const id of await ex(() => [...document.querySelectorAll('[data-card]')].map((c) => c.getAttribute('data-card')))) seenIds.add(id);
      steps.push({ i, scrollTop: g.scrollTop, cards: g.cards, ordinals: [g.ordinalMin, g.ordinalMax], dup: g.dupIds, contiguous: g.contiguous, placeholders: g.placeholders, resident: g.residentRows });
      if (g.ordinalMax >= N - 1 && g.placeholders.length === 0 && g.scrollTop + g.clientHeight >= g.scrollHeight - 2) break;
    }
    const end = await galleryState(); await shot('03-scroll-end');
    await scroller.click(); await browser.keys(['Home']); await sleep(400); const home = await galleryState();
    await browser.keys(['End']); await sleep(600); const endKey = await galleryState();
    await browser.keys(['PageUp']); await sleep(300); const pgup = await galleryState();
    const borderOk = steps.every((x) => x.dup === 0 && x.contiguous !== false) && end.ordinalMax === N - 1 && seenIds.size >= Math.floor(N * 0.97);
    rec('C12-V-SCROLL', borderOk && maxCards <= 7 * (Math.ceil(900 / 267) + 2 * 8 + 3) && home.ordinalMin === 0 && endKey.ordinalMax === N - 1 && pgup.scrollTop < endKey.scrollTop ? 'PASS' : 'FAIL', { stepsRun: steps.length, maxMountedCards: maxCards, maxDomNodes: maxNodes, uniqueSeen: seenIds.size, lastOrdinal: end.ordinalMax, homeFirst: home.ordinalMin, endLast: endKey.ordinalMax, pageUpMoved: pgup.scrollTop < endKey.scrollTop, placeholdersSeen: steps.some((x) => x.placeholders.length > 0) });
    rec('C12-V-BORDER', steps.every((x) => x.dup === 0) && end.columns === 7 && end.dupIds === 0 ? 'PASS' : 'FAIL', { lastRowColumns: end.columns, dupAtEnd: end.dupIds, placeholderBeforeSeen: steps.some((x) => x.placeholders.includes('before')), placeholderAfterSeen: steps.some((x) => x.placeholders.includes('after')) });
    await browser.keys(['Home']); await sleep(400);
  }

  // ---------- C12-V-FOCUS (teclado + ARIA; lector de pantalla NO EJECUTADO) ----------
  if (want('FOCUS')) {
    await scrollTo(0); await sleep(200);
    const focusSeq = [];
    await ex(() => document.querySelector('[data-card] [tabindex], [data-card] button, [data-card] a')?.focus());
    for (let i = 0; i < 6; i++) { await browser.keys(['Tab']); focusSeq.push(await ex(() => ({ tag: document.activeElement?.tagName, inCard: Boolean(document.activeElement?.closest('[data-card]')), card: document.activeElement?.closest('[data-card]')?.getAttribute('data-ordinal') ?? null, body: document.activeElement === document.body }))); }
    await browser.keys(['Shift', 'Tab']); await browser.keys(['Shift']);
    const back = await ex(() => ({ body: document.activeElement === document.body, inCard: Boolean(document.activeElement?.closest('[data-card]')) }));
    await browser.keys(['Escape']); const esc = await ex(() => ({ body: document.activeElement === document.body, menus: document.querySelectorAll('[role="menu"]').length }));
    const aria = await ex(() => { const feed = document.querySelector('[role="feed"]'); const a = document.querySelector('[data-card]'); return { feed: Boolean(feed), feedBusy: feed?.getAttribute('aria-busy'), article: a?.tagName, posinset: a?.getAttribute('aria-posinset'), setsize: a?.getAttribute('aria-setsize'), status: document.querySelector('.bg-catalog-shell-status')?.getAttribute('aria-live') }; });
    rec('C12-V-FOCUS', focusSeq.every((f) => !f.body) && !back.body && aria.feed && aria.article === 'ARTICLE' && aria.posinset && aria.setsize && aria.status === 'polite' ? 'PASS' : 'FAIL', { focusSeq, back, esc, aria, screenReader: 'NO EJECUTADO (no disponible/automatizable)' });
  }

  // ---------- C12-V-QUERY ----------
  if (want('QUERY')) {
    await typeSearch('V09 Beat 01');
    await waitFor(async () => (await galleryState()).setsize === String(searchHits), { timeout: 15000, msg: `search totalMatched=${searchHits}` });
    const q1 = await galleryState(); await shot('04-query-search');
    const reqQ = await apiReqs(/^\/catalog\/v1\/beats\?.*q=V09/);
    await typeSearch('');
    await waitFor(async () => (await galleryState()).setsize === String(N), { timeout: 15000, msg: 'search cleared' });
    await openTagBar();
    const tagBtn = await browser.$('[data-label="trap"]'); await tagBtn.waitForDisplayed({ timeout: 5000 });
    await tagBtn.click(); await sleep(900);
    const q2 = await waitFor(async () => { const g = await galleryState(); return g.setsize && g.setsize !== String(N) ? g : null; }, { timeout: 15000, msg: 'tag filter' });
    await shot('04-query-tag');
    const reqTag = await apiReqs(/^\/catalog\/v1\/beats\?.*includeTag=trap/);
    await openTagBar(); await browser.$('[data-label="All"]').click(); await sleep(900);
    await waitFor(async () => (await galleryState()).setsize === String(N), { timeout: 15000, msg: 'tag cleared' });
    await browser.$('[aria-label="Sort beats"]').click(); await sleep(300);
    let sorted = null;
    for (const it of await browser.$$('[role="menuitem"], [role="menuitemradio"]')) { const t = (await it.getText()).toLowerCase(); if (t.includes('name') || t.includes('nombre')) { await it.click(); sorted = t; break; } }
    await sleep(900);
    const reqSort = await apiReqs(/^\/catalog\/v1\/beats\?.*sort=name/);
    const q3 = await galleryState();
    rec('C12-V-QUERY', q1.setsize === String(searchHits) && reqQ > 0 && Number(q2.setsize) < N && reqTag > 0 && (sorted ? reqSort > 0 : true) && q3.url.includes('bgSort=name') ? 'PASS' : 'FAIL', { searchTotal: q1.setsize, searchExpected: searchHits, searchRequests: reqQ, tagTotal: q2.setsize, tagRequests: reqTag, sortChosen: sorted, sortRequests: reqSort, url: q3.url });
    await browser.$('[aria-label="Sort beats"]').click(); await sleep(200); for (const it of await browser.$$('[role="menuitem"], [role="menuitemradio"]')) { const t = (await it.getText()).toLowerCase(); if (t.includes('rating')) { await it.click(); break; } } await sleep(600);
  }

  // ---------- C12-V-INTERACTION + DRAWER ----------
  if (want('INTERACTION')) {
    await browser.$('[aria-label="Select beats"]').click(); await sleep(300);
    const cards = await browser.$$('[data-card]');
    await cards[0].click(); await sleep(150);
    const prep = await galleryState();
    await waitFor(async () => (await galleryState()).selectionStatus === 'active', { timeout: 20000, msg: 'selection active' });
    await cards[2].click(); await sleep(200);
    await waitFor(async () => (await galleryState()).selectionCount === '2', { timeout: 10000, msg: 'count 2' });
    const sel2 = await galleryState(); await shot('05-selection-2');
    await (await browser.$('.bg-gallery-selection-actions')).$('button=Select All').click();
    await waitFor(async () => (await galleryState()).selectionCount === String(N), { timeout: 20000, msg: `select all ${N}` });
    const all = await galleryState(); await shot('05-selection-all');
    const flagsOnCards = await ex(() => [...document.querySelectorAll('[data-card]')].every((c) => c.getAttribute('data-selected') === 'true'));
    const ext = await ex(async () => { const csrf = sessionStorage.getItem('beatgaler:web-csrf:v1') || ''; const ctx = await (await fetch('/beatgaler-api/catalog/v1/context', { credentials: 'include' })).json(); const id = document.querySelector('[data-card]').getAttribute('data-card'); const d = await (await fetch(`/beatgaler-api/catalog/v1/beats/${encodeURIComponent(id)}`, { credentials: 'include' })).json(); const r = await fetch(`/beatgaler-api/catalog/v1/beats/${encodeURIComponent(id)}`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-BeatGaler-CSRF': csrf, 'X-Catalog-Era': ctx.authority_era, 'X-Catalog-Epoch': ctx.authority_epoch, 'Idempotency-Key': `lab-ext-${Date.now()}` }, body: JSON.stringify({ expectedVersion: d.version, patch: { rating: (d.rating + 1) % 6 } }) }); return { status: r.status, id }; });
    for (let i = 0; i < 12; i++) { await ex(() => { const el = document.querySelector('[data-library-scroll="true"]'); el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + el.clientHeight * 0.8); }); await sleep(250); }
    const conflict = await waitFor(async () => { const g = await galleryState(); return g.selectionStatus === 'conflict' ? g : null; }, { timeout: 20000, msg: 'selection conflict' }).catch(() => null);
    const staleCopy = await ex(() => document.body.innerText.includes('La biblioteca cambió; se recargó el inicio con tus filtros.'));
    await scrollTo(0); await sleep(500);
    const editAllDisabled = await ex(() => { const b = [...document.querySelectorAll('.bg-gallery-selection-actions button')].find((x) => x.textContent.trim() === 'Edit all'); return b ? b.disabled : null; });
    await shot('05-selection-conflict');
    await (await browser.$('.bg-gallery-selection-actions')).$('button=Cancel').click(); await sleep(300);
    await browser.$('[aria-label="Select beats"]').click(); await sleep(200);
    await (await browser.$$('[data-card]'))[1].click();
    await waitFor(async () => (await galleryState()).selectionCount === '1', { timeout: 15000, msg: 'count 1' });
    await typeSearch('V09 Beat 02');
    const notice = await waitFor(async () => { const g = await galleryState(); return g.notice && g.notice.includes('Selección borrada al cambiar los filtros') ? g.notice : null; }, { timeout: 10000, msg: 'notice' }).catch(() => null);
    await shot('05-selection-notice');
    await typeSearch(''); await browser.$('[aria-label="Cancel selection"]').click().catch(() => {});
    rec('C12-V-INTERACTION', prep.selectionStatus && sel2.selectionCount === '2' && all.selectionCount === String(N) && flagsOnCards && ext.status === 200 && conflict && editAllDisabled === true && notice ? 'PASS' : 'FAIL', { preparingSeen: prep.selectionStatus, count2: sel2.selectionCount, selectAll: all.selectionCount, flagsOnResidentCards: flagsOnCards, externalPatch: ext.status, conflictStatus: conflict?.selectionStatus ?? null, staleReloadCopy: staleCopy, editAllDisabledInConflict: editAllDisabled, notice });
    const title = await browser.$('[data-card] .bg-beat-detail'); const oldName = await title.getText(); await title.click(); await sleep(500);
    const drawerOpen = await ex((n) => Boolean(document.querySelector('input[value]')) || document.body.innerText.includes(n), oldName);
    await shot('06-drawer-detail');
    await browser.keys(['Escape']); await sleep(400);
    const overlayGone = await ex(() => ![...document.querySelectorAll('div')].some((d) => { const st = getComputedStyle(d); return st.position === 'fixed' && st.inset === '0px' && Number(st.zIndex) >= 300; }));
    await shot('06-drawer-closed');
    rec('C12-V-DRAWER', drawerOpen && overlayGone ? 'PASS' : 'FAIL', { beat: oldName, drawerOpen, closedWithEscape: overlayGone });
    if (!overlayGone) { await ex(() => { for (const d of document.querySelectorAll('div')) { const st = getComputedStyle(d); if (st.position === 'fixed' && st.inset === '0px' && Number(st.zIndex) >= 300) d.click(); } }); await sleep(300); }
  }

  // ---------- C12-V-MEDIA ----------
  if (want('MEDIA')) {
    await scrollTo(0); await sleep(300); await cancelSelection();
    await installAudioCapture();
    const first = await browser.$('[data-card] [data-beat-artwork-id]'); const firstId = await ex(() => document.querySelector('[data-card]').getAttribute('data-card'));
    await first.click();
    const playing = await waitFor(async () => { const g = await galleryState(); const a = g.audio[0]; return a && !a.paused && a.t > 0.2 ? g : null; }, { timeout: 30000, msg: 'audio playing' }).catch(() => null);
    const p1 = await galleryState(); await shot('07-media-playing');
    await scrollTo('end'); await sleep(1200); await scrollTo('end'); await sleep(800);
    const evicted = { ...(await ex((id) => ({ cardMounted: Boolean(document.querySelector(`[data-card='${id}']`)), player: Boolean(document.querySelector('[title="Next"]')) }), firstId)), audio: await audioState() };
    await sleep(1500);
    const later = await audioState();
    await shot('07-media-evicted');
    await browser.$('[title="Next"]').waitForExist({ timeout: 15000 });
    await browser.$('[title="Next"]').click(); await waitFor(async () => { const g = await galleryState(); return g.playbackStatus === 'playing' || g.playbackStatus === 'loading' ? g : null; }, { timeout: 15000 }).catch(() => null);
    await sleep(1500); const afterNext = { audio: await audioState() };
    await browser.$('[title="Shuffle"]').click(); await sleep(300); await browser.$('[title="Next"]').click(); await sleep(2500);
    const afterShuffle = { audio: await audioState(), status: await ex(() => document.querySelector('.bg-catalog-shell-status')?.getAttribute('data-playback-status')) };
    await browser.$('[title="Previous"]').click(); await sleep(1500);
    const afterPrev = await audioState();
    await shot('07-media-after-transport');
    const mediaReqs = await apiReqs(/^\/catalog\/v1\/(files|media)\//);
    const continued = later[0] && !later[0].error && (later[0].t > evicted.audio[0].t || (!later[0].paused && later[0].t < evicted.audio[0].t));
    rec('C12-V-MEDIA', playing && !evicted.cardMounted && evicted.audio[0] && !evicted.audio[0].paused && continued && evicted.player && afterNext.audio[0] && !afterNext.audio[0].error && !afterNext.audio[0].paused && afterShuffle.audio[0] && !afterShuffle.audio[0].error && !afterShuffle.audio[0].paused && afterPrev[0] && !afterPrev[0].error && !afterPrev[0].paused ? 'PASS' : 'FAIL', { startedAt: p1.audio[0]?.t ?? null, srcScheme: p1.audio[0]?.src ?? null, continuedOrAdvanced: continued, evictedCardMounted: evicted.cardMounted, audioWhileEvicted: evicted.audio, audioLater: later, playerMounted: evicted.player, afterNext, afterShuffle, afterPrev, mediaRequests: mediaReqs });
    await browser.$('[title="Shuffle"]').click().catch(() => {});
  }

  // ---------- C12-V-RESOURCES (ligero) ----------
  if (want('RESOURCES')) {
    await scrollTo(0); await sleep(300);
    const base = await ex(() => ({ nodes: document.getElementsByTagName('*').length, heap: performance.memory ? performance.memory.usedJSHeapSize : null }));
    for (let i = 0; i < 25; i++) { await scrollTo('end'); await sleep(120); await scrollTo(0); await sleep(120); }
    await sleep(1500);
    const after = await ex(() => ({ nodes: document.getElementsByTagName('*').length, heap: performance.memory ? performance.memory.usedJSHeapSize : null, cards: document.querySelectorAll('[data-card]').length }));
    rec('C12-V-RESOURCES', after.nodes <= base.nodes * 1.35 && (after.heap === null || after.heap <= base.heap * 2.5 || after.heap < 150e6) ? 'PASS' : 'FAIL', { cycles: 25, baseNodes: base.nodes, afterNodes: after.nodes, baseHeapMB: base.heap ? Math.round(base.heap / 1e6) : null, afterHeapMB: after.heap ? Math.round(after.heap / 1e6) : null, mountedCards: after.cards, note: 'soak corto; V10 (v10-browser.mjs) mide capacidad real' });
  }

  // ---------- NUEVO: bulk add/remove de tags (Drawer bulk → BULK_PATCH con tagsOp), verificado contra el servidor ----------
  if (want('BULKTAGS')) {
    const TAG = 'labbulk';
    const bulk = async (mode) => {
      await scrollTo(0); await sleep(300); await cancelSelection();
      await browser.$('[aria-label="Select beats"]').click(); await sleep(300);
      const cs = await browser.$$('[data-card]');
      await cs[0].click(); await waitFor(async () => (await galleryState()).selectionStatus === 'active', { timeout: 25000, msg: 'selection active' });
      for (const i of [1, 2]) { await cs[i].click(); await sleep(300); }
      await waitFor(async () => { const g = await galleryState(); return g.selectionCount === '3' && g.selectionStatus === 'active'; }, { timeout: 25000, msg: 'selection 3 active' });
      const ids = await ex(() => [...document.querySelectorAll('[data-card]')].slice(0, 3).map((c) => c.getAttribute('data-card')));
      await (await browser.$('.bg-gallery-selection-actions')).$('button=Edit all').click(); await sleep(600);
      await ex(() => [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith('TAGS'))?.querySelector('input[type="checkbox"]')?.click());
      await sleep(300);
      if (mode === 'remove') {
        await ex(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove tags')?.click()); await sleep(300);
        // el Drawer puede reiniciar su estado si la rejilla refresca los beats seleccionados tras la mutación anterior: reintenta hasta marcar el tag
        for (let k = 0; k < 8; k++) {
          // ámbito = el panel del Drawer (div[data-prevent-enter-save]); la Tag Bar también tiene botones aria-pressed con el mismo texto
          const pressed = await ex((t) => { const b = [...document.querySelectorAll('[data-prevent-enter-save="true"] button[aria-pressed]')].find((x) => x.textContent.trim() === t); if (!b) return null; if (b.getAttribute('aria-pressed') !== 'true') b.click(); return b.getAttribute('aria-pressed'); }, TAG);
          await sleep(500);
          if (await ex((t) => [...document.querySelectorAll('[data-prevent-enter-save="true"] button[aria-pressed]')].some((x) => x.textContent.trim() === t && x.getAttribute('aria-pressed') === 'true'), TAG)) break;
          if (k === 7) console.log('bulk remove: tag no quedó marcado', pressed);
        }
      } else {
        const inp = await browser.$('input[placeholder^="Add tag"]'); await inp.waitForExist({ timeout: 5000 }); await inp.setValue(TAG); await browser.keys(['Enter']); await sleep(200);
      }
      await shot(`11-bulktags-${mode}-drawer`);
      const label = await ex(() => [...document.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim(), d: b.disabled })).find((b) => /^(Apply to|Remove \d+ tag)/.test(b.t)) || null);
      await ex(() => [...document.querySelectorAll('button')].find((b) => /^(Apply to|Remove \d+ tag)/.test(b.textContent.trim()))?.click());
      const done = await waitFor(async () => { const g = await galleryState(); return g.notice && /Edición en lote/.test(g.notice) ? g.notice : null; }, { timeout: 40000, msg: 'bulk notice' }).catch(() => null);
      await sleep(500);
      const tagsAfter = []; for (const id of ids) tagsAfter.push(((await detailOf(id)).tags || []).includes(TAG));
      return { ids, label, notice: done, hasTag: tagsAfter };
    };
    try {
      const add = await bulk('add'); await shot('11-bulktags-add-done');
      const rem = await bulk('remove'); await shot('11-bulktags-remove-done');
      rec('BULKTAGS', add.hasTag.length === 3 && add.hasTag.every(Boolean) && rem.hasTag.every((x) => !x) && add.notice && rem.notice ? 'PASS' : 'FAIL', { add, remove: rem, nota: 'añadir y luego quitar un tag común en 3 beats; verificado por GET de detalle del servidor' });
    } catch (e) { await shot('11-bulktags-error'); rec('BULKTAGS', 'FAIL', { error: e.message.slice(0, 200) }); await cancelSelection(); await browser.keys(['Escape']).catch(() => {}); }
  }

  // ---------- NUEVO (EMULADO): zoom de página 200 % ----------
  if (want('ZOOM200')) {
    try {
      await scrollTo(0); await cancelSelection();
      await cdp('Emulation.setDeviceMetricsOverride', { width: 720, height: 450, deviceScaleFactor: 2, mobile: false });
      await sleep(600);
      const g = await galleryState(); await shot('12-zoom200-emulado');
      const m = await ex(() => { const vis = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; }; return { innerWidth, dpr: devicePixelRatio, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, search: vis(document.querySelector('button[aria-label="Search beats"]')), sort: vis(document.querySelector('[aria-label="Sort beats"]')), select: vis(document.querySelector('[aria-label="Select beats"]')), firstCard: vis(document.querySelector('[data-card]')) }; });
      const ok = m.innerWidth === 720 && m.dpr === 2 && g.columns === 3 && g.cardWidth <= 160 && !m.hscroll && m.search && m.firstCard && g.dupIds === 0 && expectBounded(g);
      rec('C12-V-ZOOM200 (EMULADO)', ok ? 'PASS' : 'FAIL', { emulado: true, metodo: 'CDP setDeviceMetricsOverride 720x450@2x ≈ zoom 200 % sobre 1440x900', columns: g.columns, cardWidth: g.cardWidth, ...m });
    } catch (e) { rec('C12-V-ZOOM200 (EMULADO)', 'NO EJECUTADO', { emulado: true, reason: e.message.slice(0, 160) }); }
    finally { await cdp('Emulation.clearDeviceMetricsOverride').catch(() => {}); await setViewport(1440, 900, 1).catch(() => {}); await sleep(400); }
  }

  // ---------- NUEVO (EMULADO): prefers-reduced-motion ----------
  if (want('REDUCEDMOTION')) {
    const probe = () => ex(() => {
      const ms = (v) => v.split(',').map((x) => { x = x.trim(); return x.endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000; });
      let maxTrans = 0; let maxAnim = 0; const els = [...document.querySelectorAll('body *')].slice(0, 4000);
      for (const el of els) { const cs = getComputedStyle(el); if (cs.transitionProperty !== 'none' && cs.transitionProperty !== 'all') maxTrans = Math.max(maxTrans, ...ms(cs.transitionDuration)); else if (cs.transitionProperty === 'all') maxTrans = Math.max(maxTrans, ...ms(cs.transitionDuration)); if (cs.animationName !== 'none') maxAnim = Math.max(maxAnim, ...ms(cs.animationDuration)); }
      const running = document.getAnimations().filter((a) => a.playState === 'running');
      return { matches: matchMedia('(prefers-reduced-motion: reduce)').matches, maxTransitionMs: Math.round(maxTrans), maxAnimationMs: Math.round(maxAnim), runningAnimations: running.length, infiniteRunning: running.filter((a) => a.effect?.getComputedTiming().iterations === Infinity).length, scrollBehavior: getComputedStyle(document.querySelector('[data-library-scroll="true"]') || document.body).scrollBehavior };
    });
    try {
      await scrollTo(0); await cancelSelection(); await sleep(400);
      const base = await probe();
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await sleep(500);
      await openTagBar(); await scrollTo(600); await sleep(400);
      const red = await probe(); const g = await galleryState(); await shot('13-reduced-motion-emulado');
      const works = g.cards > 0 && g.dupIds === 0;
      const respects = red.maxTransitionMs <= Math.max(200, 0) && red.maxAnimationMs <= 200 && red.infiniteRunning === 0;
      rec('C12-V-REDUCEDMOTION (EMULADO)', red.matches && works && respects ? 'PASS' : 'FAIL', { emulado: true, metodo: 'CDP Emulation.setEmulatedMedia prefers-reduced-motion: reduce', baseline: base, reduced: red, appFunctional: works, criterio: 'sin animaciones infinitas en curso y transición/animación máx ≤ 200 ms con reduce' });
    } catch (e) { rec('C12-V-REDUCEDMOTION (EMULADO)', 'NO EJECUTADO', { emulado: true, reason: e.message.slice(0, 160) }); }
    finally { await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }).catch(() => {}); await scrollTo(0).catch(() => {}); }
  }

  // ---------- NUEVO (EMULADO): táctil ----------
  if (want('TOUCH')) {
    try {
      await cancelSelection();
      await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await browser.url(`${POSTGRES}/gallery`); await waitFor(async () => (await galleryState()).cards > 0, { timeout: 60000, msg: 'touch cards' });
      // la métrica móvil se aplica DESPUÉS de navegar (el override previo no sobrevive a la navegación)
      await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }); await sleep(900);
      const env = await ex(() => ({ coarse: matchMedia('(pointer: coarse)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, touchPoints: navigator.maxTouchPoints, innerWidth }));
      const g0 = await galleryState(); await shot('14-touch-emulado-top');
      const t0 = g0.scrollTop;
      await cdp('Input.synthesizeScrollGesture', { x: 195, y: 600, yDistance: -900, speed: 1200, gestureSourceType: 'touch' }); await sleep(900);
      let g1 = await galleryState(); let swipeMethod = 'synthesizeScrollGesture';
      if (g1.scrollTop <= t0) { // respaldo: secuencia táctil manual (touchStart → touchMove… → touchEnd)
        swipeMethod = 'dispatchTouchEvent manual';
        await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 700 }] });
        for (let y = 700; y >= 200; y -= 25) { await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y }] }); await sleep(16); }
        await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(900);
        g1 = await galleryState();
      }
      const tap = async (selector) => { const r = await ex((sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; }, selector); if (!r) return null; await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }); await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); return r; };
      await scrollTo(0); await sleep(500);
      const selBtn = await tap('[aria-label="Select beats"]'); await sleep(500);
      const inSelect = await browser.$('[aria-label="Cancel selection"]').isExisting();
      const cardTap = await tap('[data-card]'); await sleep(400);
      const sel = await waitFor(async () => { const g = await galleryState(); return g.selectionCount === '1' ? g : null; }, { timeout: 20000, msg: 'touch select' }).catch(() => null);
      await shot('14-touch-emulado-select');
      const noHScroll = !(await ex(() => document.documentElement.scrollWidth > document.documentElement.clientWidth));
      const ok = env.touchPoints > 0 && env.innerWidth === 390 && g1.scrollTop > t0 && selBtn && inSelect && sel && noHScroll && g1.dupIds === 0 && expectBounded(g1);
      rec('C12-V-TOUCH (EMULADO)', ok ? 'PASS' : 'FAIL', { emulado: true, metodo: 'CDP touch emulation + synthesizeScrollGesture + dispatchTouchEvent (390x844@3x mobile); sin pantalla táctil real', env, swipeScroll: { from: t0, to: g1.scrollTop, method: swipeMethod }, selectButtonTapTarget: selBtn && { w: Math.round(selBtn.w), h: Math.round(selBtn.h) }, enteredSelectMode: inSelect, cardTapSelected: Boolean(sel), noHorizontalScroll: noHScroll, cardsMounted: g1.cards });
      await cancelSelection();
    } catch (e) { rec('C12-V-TOUCH (EMULADO)', 'NO EJECUTADO', { emulado: true, reason: e.message.slice(0, 200) }); }
    finally {
      await cdp('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {}); await cdp('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await setViewport(1440, 900, 1).catch(() => {}); await browser.url(`${POSTGRES}/gallery`).catch(() => {}); await sleep(1500);
    }
  }

  // ---------- C12-V-LEGACY (POSTGRES, enlace bgPage) ----------
  if (want('LEGACY')) {
    if (N > 120) {
      await browser.url(`${POSTGRES}/gallery?bgPage=100`); await waitFor(async () => (await galleryState()).cards > 0, { timeout: 30000, msg: 'bgPage cards' }); await sleep(500);
      const bg = await galleryState(); await shot('08-legacy-bgpage-100');
      await browser.url(`${POSTGRES}/gallery?bgPage=999999`); await sleep(2500);
      const far = await galleryState(); await shot('08-legacy-bgpage-far');
      const copyText = await ex(() => document.body.innerText);
      const farOk = (far.cards > 0 && (copyText.includes('último bloque') || far.ordinalMin > 0)) || copyText.includes('Este enlace antiguo no se puede abrir en esta posición.');
      rec('C12-V-LEGACY-POSTGRES', bg.ordinalMin >= 90 && bg.ordinalMin <= 110 && !bg.pager && farOk ? 'PASS' : 'FAIL', { bgPage100FirstOrdinal: bg.ordinalMin, pager: bg.pager, farResolution: { cards: far.cards, firstOrdinal: far.ordinalMin, copyLast: copyText.includes('último bloque'), copyUnresolvable: copyText.includes('Este enlace antiguo no se puede abrir en esta posición.'), url: far.url } });
    } else rec('C12-V-LEGACY-POSTGRES', 'NO EJECUTADO', { reason: `bgPage=100 requiere biblioteca > 120 beats (LAB sembrado con ${N})` });
  }

  // ---------- C12-V-AUTH: A → logout → B ----------
  if (want('AUTH')) {
    await browser.url(`${POSTGRES}/gallery`); await waitFor(async () => (await galleryState()).cards > 0, { timeout: 30000, msg: 'A cards' });
    const aState = await galleryState(); const aIds = await ex(() => [...document.querySelectorAll('[data-card]')].map((c) => c.getAttribute('data-card')));
    await logout(); await drainNet(); const netMark = NET.length;
    await login(POSTGRES, cfg.accountB);
    await waitFor(async () => { const g = await galleryState(); return g.mode === 'postgres' && (g.storeStatus === 'empty' || g.cards > 0) ? g : null; }, { timeout: 40000, msg: 'B gallery' });
    const bState = await galleryState(); const bIds = await ex(() => [...document.querySelectorAll('[data-card]')].map((c) => c.getAttribute('data-card')));
    const bodyText = await ex(() => document.body.innerText);
    await shot('09-auth-account-b');
    const leak = aIds.filter((id) => bIds.includes(id)).length;
    await drainNet(); const reqsAfterSwitch = NET.slice(netMark).filter((u) => u.includes('/catalog/v1/'));
    const mediaForA = reqsAfterSwitch.filter((u) => /\/catalog\/v1\/(files|media)\//.test(u)).length;
    const blobs = await ex(() => [...document.querySelectorAll('img, audio')].filter((e) => (e.currentSrc || e.src || '').startsWith('blob:')).length);
    rec('C12-V-AUTH', bState.mode === 'postgres' && leak === 0 && bState.cards === 0 && bodyText.includes('Empty Gallery') && blobs === 0 && mediaForA === 0 ? 'PASS' : 'FAIL', { mediaRequestsAfterSwitch: mediaForA, catalogRequestsAfterSwitch: reqsAfterSwitch.length, accountA: aState.cards, accountB: { cards: bState.cards, storeStatus: bState.storeStatus }, leakedIds: leak, blobUrlsVisible: blobs, emptyCopy: bodyText.includes('Empty Gallery') });
    await logout();
  }

  // ---------- C12-V-LEGACY: flag apagado ----------
  if (want('LEGACY')) {
    if (cfg.ports.webLegacy && await fetch(LEGACY).then(() => true, () => false)) {
      await login(LEGACY, cfg.account); await sleep(4000);
      const l = await galleryState(); const body = await ex(() => document.body.innerText);
      const netBefore = NET.length; await drainNet();
      const catalogRequests2 = NET.slice(netBefore).filter((u) => u.includes(`127.0.0.1:${cfg.ports.webLegacy}`) && u.includes('/catalog/v1/')).length;
      await shot('10-legacy-flag-off');
      rec('C12-V-LEGACY-FLAGOFF', l.composition === 'legacy' && catalogRequests2 === 0 && l.mode !== 'postgres' ? 'PASS' : 'FAIL', { composition: l.composition, catalogRequests: catalogRequests2, pager: l.pager, mode: l.mode, bodySample: body.slice(0, 160) });
      await logout();
    } else rec('C12-V-LEGACY-FLAGOFF', 'NO EJECUTADO', { reason: 'Vite LEGACY no levantado (lab up --no-legacy)' });
  }

  // ---------- no automatizados ----------
  rec('SCREEN-READER', 'NO EJECUTADO', { reason: 'NVDA/Narrador no automatizables en este arnés' });
  if (args.browser !== 'edge') rec('EDGE', 'NO EJECUTADO', { reason: edgeInstalled() ? 'esta corrida usa Chrome; repetir con --browser edge' : 'Edge no instalado' });
} catch (error) {
  rec('RUN', 'ERROR', { message: error.message, stack: (error.stack || '').split('\n').slice(0, 4) });
  await shot('99-error');
} finally {
  await R.finish();
}
