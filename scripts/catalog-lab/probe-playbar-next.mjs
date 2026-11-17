// Sonda LAB: «Siguiente»/«Anterior» de la Playbar, fin de pista y cambio real de audio (Cloud real + gateway FAKE + PostgreSQL efímero).
//   node scripts/catalog-lab/probe-playbar-next.mjs [--out DIR]
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'playbar-next', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, installAudioCapture, audioState, browser, POSTGRES, cfg, sleep } = R;
const playingCard = () => ex(() => { const c = document.querySelector('[data-card][data-playing="true"]'); return c ? { id: c.getAttribute('data-card'), ordinal: c.getAttribute('data-ordinal') } : null; });
const shellStatus = () => ex(() => { const s = document.querySelector('.bg-catalog-shell-status'); return s ? { playback: s.getAttribute('data-playback-status'), notice: document.querySelector('.bg-catalog-notice')?.textContent || '' } : null; });
const clickTitle = (t) => ex((title) => { const b = document.querySelector(`button[title="${title}"]`); if (!b) return false; b.click(); return true; }, t);
const state = async () => ({ marker: await ex(() => window.__probeMark ?? null), card: await playingCard(), audio: (await audioState())[0] || null, shell: await shellStatus() });
try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'catalog cards' });
  await installAudioCapture();
  await ex(() => { window.__probeMark = 'alive'; window.__net = []; const of = window.fetch; window.fetch = async (...a) => { const u = String(a[0]?.url ?? a[0]); const r = await of(...a); if (/query-sets|rounds/.test(u)) { let body = ''; try { body = (await r.clone().text()).slice(0, 160); } catch {} window.__net.push(`${a[1]?.method || 'GET'} ${u.replace(/^.*catalog\/v1/, '')} -> ${r.status} ${body}`); } return r; }; });
  const first = await ex(() => document.querySelector('[data-card]')?.getAttribute('data-card'));
  await (await browser.$(`[data-card="${first}"] [data-beat-artwork-id]`)).click();
  await waitFor(async () => { const a = (await audioState())[0]; return a && !a.paused && a.t > 0.1 ? a : null; }, { timeout: 30000, msg: 'first playing' });
  const s0 = await state(); rec('NEXT-0-PLAYING', 'INFO', s0);
  await sleep(300);
  const clicked = await clickTitle('Next'); await sleep(2500);
  const s1 = await state(); await shot('n1-after-next');
  rec('NEXT-1-NEXT', clicked && s1.card && s1.card.id !== s0.card?.id && s1.audio && !s1.audio.paused ? 'PASS' : 'FAIL', { clicked, before: s0, after: s1 });
  const step = async (id, title, fn, check) => { const before = await state(); const clicked = await fn(); await sleep(2500); const after = await state(); rec(id, check(before, after, clicked) ? 'PASS' : 'FAIL', { title, clicked, before: before.card, after: after.card, audioBefore: before.audio, audioAfter: after.audio, shell: after.shell }); return after; };
  // Si la tarjeta reproducida queda fuera de la ventana virtualizada (Shuffle/lista larga) no hay [data-playing]: se exige que el audio haya reiniciado (t menor que lo esperable sin cambio).
  const changed = (b, a, c) => c && a.audio && !a.audio.paused && !a.audio.error && (a.card ? a.card.id !== b.card?.id : (a.audio.t < (b.audio?.t ?? 0) + 2));
  // 3 «Siguiente» seguidos (con pausas humanas)
  await step('NEXT-2', 'segundo Next', () => clickTitle('Next'), changed);
  await step('NEXT-3', 'tercer Next', () => clickTitle('Next'), changed);
  // Anterior (progress > 0.05 → seek 0; luego otra vez → pista anterior)
  await step('PREV-1', 'Previous con progreso (seek 0, misma pista)', () => clickTitle('Previous'), (b, a, c) => c && a.card?.id === b.card?.id);
  await sleep(300);
  const beforePrev2 = (await playingCard()).id;
  await clickTitle('Next'); await sleep(900);
  await step('PREV-2', 'Previous justo tras cambiar de pista → vuelve a la pista anterior', () => clickTitle('Previous'), (b, a, c) => c && a.card?.id === beforePrev2 && a.audio && !a.audio.paused);
  // Next con búsqueda activa (conjunto filtrado)
  await typeSearch('Beat'); await sleep(1200);
  const inSearch = await playingCard();
  await step('NEXT-SEARCH', 'Next con filtro de búsqueda (audio continúa)', () => clickTitle('Next'), (b, a, c) => c && a.audio && !a.audio.paused && !a.audio.error);
  await typeSearch(''); await sleep(1200);
  // Shuffle
  await ex(() => { const b = document.querySelector('button[title*="huffle"]'); b?.click(); }); await sleep(800);
  await step('NEXT-SHUFFLE', 'Next con Shuffle', () => clickTitle('Next'), changed);
  await step('NEXT-SHUFFLE-2', 'Next con Shuffle (2)', () => clickTitle('Next'), changed);
  // Reproducción automática al terminar la pista (los audios del LAB duran ~4 s): arranca otra pista sin pulsar nada
  const first3 = await ex(() => document.querySelector('[data-card]')?.getAttribute('data-card'));
  await ex(() => document.querySelector('[data-card]')?.scrollIntoView());
  await (await browser.$(`[data-card="${first3}"] [data-beat-artwork-id]`)).click();
  await waitFor(async () => { const a = (await audioState())[0]; return a && !a.paused && a.t > 0.1 ? a : null; }, { timeout: 20000, msg: 'play for ended' });
  const idBefore = (await playingCard())?.id; await sleep(7000);
  const afterEnd = await state();
  rec('ENDED-AUTOADVANCE', afterEnd.audio && !afterEnd.audio.paused && !afterEnd.audio.error && afterEnd.shell?.playback === 'playing' && (afterEnd.card ? afterEnd.card.id !== idBefore : true) ? 'PASS' : 'FAIL', { idBefore, afterEnd });
  // Revisión del catálogo subida por OTRA sesión (otro dispositivo): el conjunto de resultados del cliente queda obsoleto → Next debe recuperarse.
  const { execFileSync } = await import('node:child_process');
  await ex(() => { const c = document.querySelector('[data-card]'); c?.scrollIntoView(); });
  const first2 = await ex(() => document.querySelector('[data-card]')?.getAttribute('data-card'));
  await (await browser.$(`[data-card="${first2}"] [data-beat-artwork-id]`)).click(); await sleep(1500);
  execFileSync(process.execPath, ['scripts/catalog-lab/bump-revision.mjs'], { env: { ...process.env, NAME: `Otro dispositivo ${Date.now() % 100000}` }, stdio: 'pipe', timeout: 60000 });
  await step('NEXT-STALE-SET', 'Next tras subir la revisión desde otra sesión', () => clickTitle('Next'), changed);
  await step('NEXT-STALE-SET-2', 'Next otra vez', () => clickTitle('Next'), changed);
  const logs = (await browser.getLogs('browser').catch(() => [])).map((l) => `${l.level} ${String(l.message).slice(0, 200)}`);
  rec('NEXT-LOGS', 'INFO', { logs, net: await ex(() => window.__net) });
} catch (e) { rec('NEXT', 'ERROR', { message: String(e && e.message || e), logs: (await browser.getLogs('browser').catch(() => [])).slice(-12).map((l) => `${l.level} ${String(l.message).slice(0, 220)}`) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
