// E80 — Perfil de CPU del arranque de la Gallery POSTGRES (LAB). Recarga /gallery con el Profiler de CDP activo, espera a la Gallery interactiva
// y agrega el tiempo propio por función/archivo hasta ese instante. Solo diagnóstico (no forma parte de ninguna suite).
//   node scripts/catalog-lab/probe-startup-profile.mjs [--base http://127.0.0.1:1442] [--reloads 3] [--top 25]
import { parseArgs, createRun } from './browser-common.mjs';

const args = parseArgs();
const opt = (k, d) => { const i = args.rest.indexOf(k); return i >= 0 ? args.rest[i + 1] : d; };
const reloads = Number(opt('--reloads', '3'));
const top = Number(opt('--top', '25'));
const R = await createRun({ kind: `startup-profile-${opt('--label', 'run')}`, args });
if (!R) process.exit(0);
const { rec, ex, waitFor, login, browser, POSTGRES, cfg, sleep, finish, cdp } = R;
const BASE = opt('--base', POSTGRES);

try {
  await login(BASE, cfg.account);
  await waitFor(async () => (await ex(() => document.querySelectorAll('[data-card]').length)) > 0, { timeout: 90000, msg: 'cards after login' });
  await cdp('Profiler.enable'); await cdp('Profiler.setSamplingInterval', { interval: 200 });
  const agg = new Map(); const byUrl = new Map(); let total = 0;
  for (let i = 0; i < reloads; i++) {
    await cdp('Profiler.start');
    await browser.url(`${BASE}/gallery`);
    const t = await waitFor(async () => ex(() => {
      const card = document.querySelector('[data-card]');
      return card && !document.querySelector('[data-catalog-provisional="true"]') && document.querySelector('[data-store-status="ready"]') ? Math.round(performance.now()) : null;
    }), { timeout: 60000, msg: 'interactive' });
    const { profile } = await cdp('Profiler.stop');
    const p = profile?.value?.profile ?? profile ?? (await Promise.resolve(null));
    const prof = p?.nodes ? p : profile;
    const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
    const counts = new Map(); for (const s of prof.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
    const dt = (prof.endTime - prof.startTime) / 1000 / prof.samples.length;
    for (const [id, c] of counts) {
      const n = nodes.get(id); const f = n.callFrame; const ms = c * dt; total += ms;
      const file = (f.url || '').split('/').pop() || `(${f.functionName || 'native'})`;
      const k = `${f.functionName || '(anon)'} @ ${file}:${f.lineNumber}`;
      agg.set(k, (agg.get(k) ?? 0) + ms); byUrl.set(file, (byUrl.get(file) ?? 0) + ms);
    }
    rec(`RELOAD-${i}`, 'INFO', { interactiveAt: t });
    await sleep(300);
  }
  const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${(v / reloads).toFixed(1)}ms ${k}`);
  rec('BY-FILE', 'INFO', { perReloadMs: fmt(byUrl) });
  rec('BY-FUNCTION', 'INFO', { perReloadMs: fmt(agg), totalPerReloadMs: Math.round(total / reloads) });
} catch (e) { rec('ERROR', 'FAIL', { message: String(e.message).slice(0, 300) }); }
await finish();
