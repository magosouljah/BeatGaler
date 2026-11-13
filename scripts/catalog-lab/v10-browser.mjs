// V10 navegador — scroll/retroceso + soak con medición de frames (rAF, longtask, long-animation-frame), memoria JS (CDP Performance +
// performance.memory, con GC forzado periódico) y DOM acotado, contra el LAB (Cloud real + gateway FAKE + PG efímero). Uso:
//   node scripts/catalog-lab/v10-browser.mjs [--duration-min 20] [--sample-sec 10] [--browser chrome|edge] [--out DIR] [--skip SCROLLBACK|SOAK] [--no-gc]
// Salida: <out>/v10/v10-results.json (+ capturas + SHA256SUMS). Es medición LAB (headless, SwiftShader, gateway fake): no es evidencia
// de rendimiento real ni cierra G3/G5; sirve para detectar fugas, DOM no acotado y bloqueos de frame.
import { parseArgs, createRun, sleep } from './browser-common.mjs';

const args = parseArgs();
const durationMin = args.durationMin ?? 20; const sampleSec = args.sampleSec ?? 10; const noGc = args.rest.includes('--no-gc');
const R = await createRun({ kind: 'v10', args });
if (!R) process.exit(0);
const { browser, rec, want, ex, shot, waitFor, cdp, login, galleryState, typeSearch, openTagBar, scrollTo, POSTGRES, cfg, N } = R;

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const frameStats = (dts) => ({ frames: dts.length, p50: pct(dts, 50), p95: pct(dts, 95), p99: pct(dts, 99), max: dts.length ? Math.max(...dts) : null, over33: dts.filter((d) => d > 33.4).length, over50: dts.filter((d) => d > 50).length, over100: dts.filter((d) => d > 100).length, over250: dts.filter((d) => d > 250).length });
const installMonitor = () => ex(() => {
  if (window.__lab10) return true;
  const S = window.__lab10 = { dts: [], last: 0, longtasks: [], loaf: [] };
  const loop = (t) => { if (S.last) { if (S.dts.length < 20000) S.dts.push(Math.round((t - S.last) * 10) / 10); } S.last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) S.longtasks.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) S.loaf.push({ d: Math.round(e.duration), b: Math.round(e.blockingDuration || 0) }); }).observe({ type: 'long-animation-frame', buffered: false }); } catch {}
  S.snap = () => { const o = { dts: S.dts, longtasks: S.longtasks, loaf: S.loaf }; S.dts = []; S.longtasks = []; S.loaf = []; S.last = 0; return o; };
  return true;
});
const snap = () => ex(() => (window.__lab10 ? window.__lab10.snap() : { dts: [], longtasks: [], loaf: [] }));
const cdpMetrics = async () => { try { await cdp('Performance.enable'); const m = await cdp('Performance.getMetrics'); const o = {}; for (const x of m.metrics || []) o[x.name] = x.value; return o; } catch { return null; } };
const gc = async () => { if (noGc) return; try { await cdp('HeapProfiler.collectGarbage'); } catch {} };
// Ruido conocido del LAB (no del producto): favicon inexistente en Vite y /auth/signup/status 503 (registro/billing sandbox sin configurar). Se cuenta aparte.
const NOISE = /favicon\.ico|\/auth\/signup\/status/;
let noiseCount = 0;
const severeLogs = async () => { try { const all = (await browser.getLogs('browser')).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 200)); noiseCount += all.filter((m) => NOISE.test(m)).length; return all.filter((m) => !NOISE.test(m)); } catch { return []; } };
const slope = (pts) => { const n = pts.length; if (n < 3) return null; const mx = pts.reduce((a, p) => a + p[0], 0) / n; const my = pts.reduce((a, p) => a + p[1], 0) / n; let num = 0; let den = 0; for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; } return den ? num / den : null; };
const boundCards = (g) => g.cards > 0 && g.cards <= g.columns * (Math.ceil(g.clientHeight / (g.rowHeight + 28)) + 2 * 8 + 3);

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'catalog cards' });
  await installMonitor();
  const g0 = await galleryState(); await shot('v10-00-start');
  rec('V10-ENV', 'RECORDED', { beats: N, durationMin, sampleSec, gcForced: !noGc, nodes: g0.domNodes, cards: g0.cards, columns: g0.columns, hw: await ex(() => ({ cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory ?? null, perfMemory: Boolean(performance.memory) })) });

  // ---------- Scroll y retroceso ----------
  if (want('SCROLLBACK')) {
    const issues = []; let maxCards = 0; let maxNodes = 0; const dtsAll = [];
    const check = async (tag) => { const g = await galleryState(); maxCards = Math.max(maxCards, g.cards); maxNodes = Math.max(maxNodes, g.domNodes); if (g.dupIds > 0) issues.push(`${tag}: dupIds=${g.dupIds}`); if (g.contiguous === false) issues.push(`${tag}: no contiguo`); if (!boundCards(g) && g.cards > 0) issues.push(`${tag}: cards ${g.cards} fuera de cota`); return g; };
    await snap();
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let i = 0; i < Math.max(40, Math.ceil(N / 6)); i++) { await ex(() => { const el = document.querySelector('[data-library-scroll="true"]'); el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + el.clientHeight * 0.9); }); await sleep(120); if (i % 5 === 0) await check(`down${cycle}.${i}`); }
      const end = await check(`end${cycle}`);
      for (let i = 0; i < Math.max(40, Math.ceil(N / 6)); i++) { await ex(() => { const el = document.querySelector('[data-library-scroll="true"]'); el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight * 0.9); }); await sleep(120); if (i % 5 === 0) await check(`up${cycle}.${i}`); }
      const top = await check(`top${cycle}`);
      if (top.ordinalMin !== 0) issues.push(`top${cycle}: ordinalMin=${top.ordinalMin}`);
      if (end.ordinalMax !== N - 1) issues.push(`end${cycle}: ordinalMax=${end.ordinalMax} (esperado ${N - 1})`);
    }
    const s1 = await snap(); dtsAll.push(...s1.dts);
    // salto aleatorio de scroll (anclaje por ordinal)
    for (let i = 0; i < 20; i++) { const frac = Math.random(); await ex((f) => { const el = document.querySelector('[data-library-scroll="true"]'); el.scrollTop = f * (el.scrollHeight - el.clientHeight); }, frac); await sleep(350); await check(`jump${i}`); }
    // retroceso del navegador (history): filtrar por tag → scroll → back → forward
    const urlBefore = (await galleryState()).url; await scrollTo(0); await sleep(300);
    let backInfo = {};
    try {
      await openTagBar(); const tb = await browser.$('[data-label="trap"]'); await tb.waitForDisplayed({ timeout: 5000 }); await tb.click(); await sleep(1200);
      const filtered = await galleryState(); await scrollTo(1500); await sleep(500);
      await browser.back(); await sleep(1500); const afterBack = await galleryState();
      await browser.forward(); await sleep(1500); const afterFwd = await galleryState();
      backInfo = { urlBefore, urlFiltered: filtered.url, filteredTotal: filtered.setsize, urlAfterBack: afterBack.url, totalAfterBack: afterBack.setsize, cardsAfterBack: afterBack.cards, urlAfterForward: afterFwd.url, totalAfterForward: afterFwd.setsize, backRestoredUnfiltered: afterBack.setsize === String(N), historyEntryForFilter: filtered.url !== urlBefore };
      if (afterBack.dupIds > 0 || afterFwd.dupIds > 0 || afterBack.cards === 0) issues.push('back/forward: estado inconsistente');
      await browser.url(`${POSTGRES}/gallery`); await waitFor(async () => (await galleryState()).cards > 0, { timeout: 60000, msg: 'cards after reset' }); await installMonitor();
    } catch (e) { backInfo = { error: e.message.slice(0, 160) }; issues.push(`back/forward error: ${e.message.slice(0, 100)}`); }
    await shot('v10-01-scrollback');
    rec('V10-SCROLLBACK', issues.length === 0 ? 'PASS' : 'FAIL', { cycles: 3, maxMountedCards: maxCards, maxDomNodes: maxNodes, frames: frameStats(dtsAll), longtasks: s1.longtasks.length, issues: issues.slice(0, 20), history: backInfo });
  }

  // ---------- Soak ----------
  if (want('SOAK')) {
    await installMonitor(); await snap();
    const samples = []; const dtsAll = []; const longtasks = []; const loaf = []; let actionErrors = 0; const severe = []; const actions = { scroll: 0, jump: 0, search: 0, tag: 0 };
    const t0 = Date.now(); const deadline = t0 + durationMin * 60000; let nextSample = t0 + sampleSec * 1000; let lastSearch = t0; let lastTag = t0;
    await gc(); const m0 = await cdpMetrics(); const base = await galleryState();
    console.log(`SOAK: ${durationMin} min, muestra cada ${sampleSec}s, ${N} beats`);
    while (Date.now() < deadline) {
      try {
        const r = Math.random();
        if (r < 0.75) { actions.scroll++; await ex((dir) => { const el = document.querySelector('[data-library-scroll="true"]'); el.scrollTop = Math.max(0, Math.min(el.scrollHeight, el.scrollTop + dir * el.clientHeight * (0.3 + Math.random() * 0.8))); }, Math.random() < 0.55 ? 1 : -1); }
        else { actions.jump++; await ex(() => { const el = document.querySelector('[data-library-scroll="true"]'); el.scrollTop = Math.random() * (el.scrollHeight - el.clientHeight); }); }
        if (Date.now() - lastSearch > 60000) { actions.search++; lastSearch = Date.now(); await typeSearch('V09 Beat 0'); await sleep(1500); await typeSearch(''); }
        if (Date.now() - lastTag > 90000) { actions.tag++; lastTag = Date.now(); await openTagBar(); const dr = await browser.$('[data-label="drill"]'); await dr.waitForDisplayed({ timeout: 5000 }); await dr.click(); await sleep(1500); await openTagBar(); const al = await browser.$('[data-label="All"]'); await al.waitForDisplayed({ timeout: 5000 }); await al.click(); await sleep(1200); }
      } catch (e) { actionErrors++; if (actionErrors < 6) console.log('soak action error:', e.message.slice(0, 120)); }
      await sleep(180 + Math.random() * 220);
      if (Date.now() >= nextSample) {
        nextSample += sampleSec * 1000;
        const s = await snap(); dtsAll.push(...s.dts); longtasks.push(...s.longtasks); loaf.push(...s.loaf);
        const g = await galleryState();
        await gc(); const m = await cdpMetrics();
        const heapJs = await ex(() => (performance.memory ? performance.memory.usedJSHeapSize : null));
        const sev = await severeLogs(); severe.push(...sev);
        const row = { tSec: Math.round((Date.now() - t0) / 1000), nodes: g.domNodes, cards: g.cards, dup: g.dupIds, contiguous: g.contiguous, cardsBounded: boundCards(g), jsHeapMB: m?.JSHeapUsedSize != null ? Math.round(m.JSHeapUsedSize / 1e4) / 100 : (heapJs ? Math.round(heapJs / 1e4) / 100 : null), cdpNodes: m?.Nodes ?? null, listeners: m?.JSEventListeners ?? null, documents: m?.Documents ?? null, frames: frameStats(s.dts), longtasks: s.longtasks.length, loaf: s.loaf.length, severeLogs: sev.length };
        samples.push(row);
        if (samples.length % 6 === 0) console.log(JSON.stringify({ tSec: row.tSec, nodes: row.nodes, cards: row.cards, heapMB: row.jsHeapMB, p95: row.frames.p95, over100: row.frames.over100 }));
      }
    }
    await shot('v10-02-soak-end');
    const fin = await galleryState(); const mEnd = await cdpMetrics();
    const warm = samples.filter((x) => x.tSec >= Math.min(120, durationMin * 60 * 0.2)); const heapPts = warm.filter((x) => x.jsHeapMB != null).map((x) => [x.tSec / 60, x.jsHeapMB]);
    const heapSlope = slope(heapPts); const nodesMax = Math.max(...samples.map((x) => x.nodes), base.domNodes); const cardsMax = Math.max(...samples.map((x) => x.cards), 0);
    const heapFirst = heapPts[0]?.[1] ?? null; const heapLast = heapPts[heapPts.length - 1]?.[1] ?? null;
    const overall = frameStats(dtsAll);
    const checks = {
      noDuplicateIds: samples.every((x) => x.dup === 0),
      cardsAlwaysBounded: samples.every((x) => x.cardsBounded),
      domBounded: nodesMax <= Math.max(base.domNodes * 2, base.domNodes + 4000),
      heapNotGrowing: heapSlope == null ? null : (heapSlope < 2 || (heapLast != null && heapFirst != null && heapLast <= heapFirst * 1.5)), // < 2 MB/min o ≤ +50 % tras warm-up
      heapUnder200MB: heapLast == null ? null : heapLast < 200,
      noSevereConsole: severe.length === 0,
      noActionErrors: actionErrors === 0,
      stillResponsive: fin.cards > 0,
    };
    const ok = Object.values(checks).every((v) => v !== false);
    rec('V10-SOAK', ok ? 'PASS' : 'FAIL', { durationMin, samples: samples.length, actions, actionErrors, domNodes: { baseline: base.domNodes, max: nodesMax, final: fin.domNodes }, maxMountedCards: cardsMax, heap: { baselineMB: m0?.JSHeapUsedSize ? Math.round(m0.JSHeapUsedSize / 1e4) / 100 : null, firstWarmMB: heapFirst, lastMB: heapLast, slopeMBperMin: heapSlope == null ? null : Math.round(heapSlope * 100) / 100, gcForced: !noGc }, finalCdp: mEnd && { Nodes: mEnd.Nodes, JSEventListeners: mEnd.JSEventListeners, Documents: mEnd.Documents }, frames: overall, longtasks: { count: longtasks.length, max: longtasks.length ? Math.max(...longtasks) : null }, longAnimationFrames: { count: loaf.length, maxMs: loaf.length ? Math.max(...loaf.map((x) => x.d)) : null, maxBlockingMs: loaf.length ? Math.max(...loaf.map((x) => x.b)) : null }, severeConsoleSample: severe.slice(0, 5), knownLabNoiseIgnored: noiseCount, checks, nota: 'headless + SwiftShader + gateway fake; ejecutar en máquina exclusiva; no cierra G3/G5', samplesSeries: samples });
  }
} catch (error) {
  rec('RUN', 'ERROR', { message: error.message, stack: (error.stack || '').split('\n').slice(0, 4) });
  await shot('v10-99-error');
} finally {
  await R.finish();
}
