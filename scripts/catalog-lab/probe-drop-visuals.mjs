// Sonda LAB: estados VISUALES y funcionales del arrastre sobre la Gallery POSTGRES (Chrome aislado, Cloud real + gateway FAKE + PostgreSQL efímero).
// Congela el estado de arrastre (dragenter/dragover sin soltar), mide la geometría de los indicadores y captura pantallas; después suelta de verdad.
//   node scripts/catalog-lab/probe-drop-visuals.mjs [--out DIR]
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'drop-visuals', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, browser, POSTGRES, cfg, sleep } = R;

const mp3b64 = (() => { const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; return Buffer.concat(Array.from({ length: 1500 }, () => f)).toString('base64'); })();
const dismissNotice = () => ex(() => { document.querySelector('.bg-catalog-notice button')?.click(); });
const notice = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
const apiBeat = (name) => ex(async (n) => { const r = await fetch(`/beatgaler-api/catalog/v1/beats?limit=200&q=${encodeURIComponent(n)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); const j = await r.json(); const it = (j.items || []).find((x) => x.name === n); return it ? { id: it.id, version: it.version, art: it.artwork?.fileId ?? null, master: it.playback?.fileId ?? null, hasWav: it.hasWav, tags: it.tags, bpm: it.bpm } : null; }, name);
const total = () => ex(async () => { const r = await fetch('/beatgaler-api/catalog/v1/beats?limit=200', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); return ((await r.json()).items || []).length; });

// Construye un File en la página: PNG/JPEG/GIF/WEBP reales (canvas), MP3 de silencio, TXT, SVG.
const BUILD = `window.__mk = async (name, kind) => {
  const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }); const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 64, 64); grad.addColorStop(0, '#' + (Math.floor(Math.random() * 0xffffff)).toString(16).padStart(6, '0')); grad.addColorStop(1, '#222'); g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const blob = (type) => new Promise((r) => cv.toBlob(r, type));
  if (kind === 'png') return new File([await blob('image/png')], name, { type: 'image/png' });
  if (kind === 'jpeg') return new File([await blob('image/jpeg')], name, { type: 'image/jpeg' });
  if (kind === 'webp') return new File([await blob('image/webp')], name, { type: 'image/webp' });
  if (kind === 'gif') { const b = Uint8Array.from(atob('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (c) => c.charCodeAt(0)); return new File([b], name, { type: 'image/gif' }); }
  if (kind === 'svg') return new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], name, { type: 'image/svg+xml' });
  if (kind === 'txt') return new File(['hola'], name, { type: 'text/plain' });
  const bytes = Uint8Array.from(atob(window.__mp3), (c) => c.charCodeAt(0)); return new File([bytes], name, { type: kind === 'wav' ? 'audio/wav' : 'audio/mpeg' });
};`;
const enter = async (name, kind, targetSel, partSel = null) => {
  await ex((n, k, t, p) => (async () => {
    const f = await window.__mk(n, k); const dt = new DataTransfer(); dt.items.add(f); window.__dt = dt; window.__file = f;
    const base = t ? document.querySelector(t) : null; window.__tgt = t ? (p ? base.querySelector(p) || base : base) : null;
    const el = window.__tgt || document.body; const mk = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
    el.dispatchEvent(mk('dragenter')); el.dispatchEvent(mk('dragover'));
  })(), name, kind, targetSel, partSel);
  await sleep(250);
};
const leave = () => ex(() => { const el = window.__tgt || document.body; el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); });
const release = () => ex(() => { const el = window.__tgt || document.body; const e = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }); el.dispatchEvent(e); return e.defaultPrevented; });
const press = (label) => ex((l) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === l); b?.click(); return Boolean(b); }, label);
const alertText = () => ex(() => { const t = document.body.innerText; const m = /Unsupported file|Drop the image on a beat|Nothing to import|Drop one file at a time/.exec(t); return m ? m[0] : null; });
const closeAlert = () => ex(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(OK|Close|Got it)$/i.test(x.textContent.trim())); b?.click(); return Boolean(b); });

// Geometría de los indicadores respecto a la tarjeta/portada y recorte por contenedores
const geometry = () => ex(() => {
  const id = window.__tgt?.closest('[data-beat-card-id]')?.getAttribute('data-beat-card-id'); const card = document.querySelector(`[data-beat-card-id="${id}"]`); if (!card) return null;
  const art = card.querySelector('[data-beat-artwork-id]'); const r = (e) => { const b = e.getBoundingClientRect(); return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const overlay = [...art.querySelectorAll('div')].find((d) => /Drop image/.test(d.textContent) && getComputedStyle(d).position === 'absolute');
  const cs = getComputedStyle(card); const as = getComputedStyle(art);
  // ¿Algún ancestro recorta el contorno de la tarjeta (outline 2px + offset 4px)?
  const o = (cs.outlineStyle !== 'none') ? parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset) : 0; const cr = card.getBoundingClientRect(); const clipped = [];
  for (let a = card.parentElement; a && a !== document.documentElement; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== 'visible') { const b = a.getBoundingClientRect(); if (cr.left - o < b.left - 0.5 || cr.right + o > b.right + 0.5) clipped.push({ cls: a.className?.toString().slice(0, 40), left: +(cr.left - o - b.left).toFixed(1), right: +(b.right - (cr.right + o)).toFixed(1) }); } }
  return { card: r(card), art: r(art), overlay: overlay ? r(overlay) : null, overlayRadius: overlay ? getComputedStyle(overlay).borderRadius : null, artRadius: as.borderRadius, artShadow: as.boxShadow, cardOutline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} off ${cs.outlineOffset}`, outlineExtent: o, clippedByAncestor: clipped, banner: Boolean(document.querySelector('[data-testid="catalog-drop-overlay"]')) };
});
const aligned = (g) => g.overlay && Math.abs(g.overlay.x - g.art.x) <= 1 && Math.abs(g.overlay.y - g.art.y) <= 1 && Math.abs(g.overlay.w - g.art.w) <= 1 && Math.abs(g.overlay.h - g.art.h) <= 1;

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'cards' });
  if (Number(process.env.VIS_W)) { await browser.setWindowSize(Number(process.env.VIS_W), 900); await sleep(800); }
  if (Number(process.env.VIS_ZOOM)) { await ex((z) => { document.documentElement.style.zoom = String(z); }, Number(process.env.VIS_ZOOM)); await sleep(500); }
  await ex((b64, build) => { window.__mp3 = b64; (0, eval)(build); }, mp3b64, BUILD);
  const cardSel = await ex(() => `[data-beat-card-id="${document.querySelector('[data-beat-card-id]').getAttribute('data-beat-card-id')}"]`);
  const NAME = await ex((s) => document.querySelector(`${s} [data-beat-artwork-id]`)?.getAttribute('aria-label')?.replace(/^(Play|Pause) /, '') ?? null, cardSel);
  const before = await apiBeat(NAME); const count0 = await total();
  rec('VIS-0-TARGET', 'INFO', { cardSel, NAME, before, count0 });

  // ---- Estados visuales (congelados) en distintas zonas de la tarjeta ----
  const zones = { portada: '[data-beat-artwork-id]', titulo: null, tags: null };
  for (const [zone, part] of [['portada', '[data-beat-artwork-id]'], ['cuerpo', null]]) {
    await enter('p.png', 'png', cardSel, part); const gI = await geometry(); await shot(`vis-image-${zone}`);
    rec(`VIS-IMAGE-${zone}`, gI && gI.overlay && aligned(gI) && gI.cardOutline.startsWith('none') && !gI.banner ? 'PASS' : 'FAIL', gI); await leave(); await sleep(150);
  }
  // sobre el título/etiquetas (zona de texto de la tarjeta, fuera de la portada)
  await ex((s) => { window.__textSel = s; }, cardSel);
  const textPart = await ex((s) => { const c = document.querySelector(s); const art = c.querySelector('[data-beat-artwork-id]'); const kids = [...c.querySelectorAll('*')].filter((e) => !art.contains(e) && e !== art && e.textContent.trim()); return kids.length ? (kids[0].id ? `#${kids[0].id}` : null) : null; }, cardSel);
  await ex((s) => { const c = document.querySelector(s); const art = c.querySelector('[data-beat-artwork-id]'); const t = [...c.querySelectorAll('*')].find((e) => !art.contains(e) && e !== art && e.children.length === 0 && e.textContent.trim()); if (t) t.setAttribute('data-probe-text', '1'); }, cardSel);
  await enter('p.png', 'png', cardSel, '[data-probe-text]'); const gT = await geometry(); await shot('vis-image-texto');
  rec('VIS-IMAGE-texto', gT && gT.overlay && aligned(gT) && gT.cardOutline.startsWith('none') ? 'PASS' : 'FAIL', gT); await leave(); await sleep(150);

  await enter('a.mp3', 'mp3', cardSel, '[data-probe-text]'); const gA = await geometry(); await shot('vis-audio-mp3');
  rec('VIS-AUDIO-mp3', gA && !gA.overlay && !gA.cardOutline.startsWith('none') && gA.clippedByAncestor.length === 0 && !gA.banner ? 'PASS' : 'FAIL', gA); await leave(); await sleep(150);
  await enter('a.wav', 'wav', cardSel, '[data-beat-artwork-id]'); const gW = await geometry(); await shot('vis-audio-wav');
  rec('VIS-AUDIO-wav', gW && !gW.overlay && !gW.cardOutline.startsWith('none') && gW.clippedByAncestor.length === 0 ? 'PASS' : 'FAIL', gW); await leave(); await sleep(150);
  await enter('a.mp3', 'mp3', null); const gG = await ex(() => ({ banner: Boolean(document.querySelector('[data-testid="catalog-drop-overlay"]')), anyRing: document.querySelectorAll('[data-beat-card-id]').length && [...document.querySelectorAll('[data-beat-card-id]')].some((c) => getComputedStyle(c).outlineStyle !== 'none'), text: document.querySelector('[data-testid="catalog-drop-overlay"]')?.innerText })); await shot('vis-global-banner');
  rec('VIS-GLOBAL-banner', gG.banner && !gG.anyRing ? 'PASS' : 'FAIL', gG); await leave(); await sleep(150);
  const gone = await ex(() => ({ banner: Boolean(document.querySelector('[data-testid="catalog-drop-overlay"]')), rings: [...document.querySelectorAll('[data-beat-card-id]')].filter((c) => getComputedStyle(c).outlineStyle !== 'none').length }));
  rec('VIS-CLEAR-on-leave', !gone.banner && gone.rings === 0 ? 'PASS' : 'FAIL', gone);

  if (process.env.VIS_W || process.env.VIS_ZOOM) throw new Error('VISUAL-ONLY-DONE');
  // ---- Funcional: imagen soltada en distintas zonas de la tarjeta cambia SU portada ----
  let prev = before;
  for (const [label, kind, part] of [['portada', 'png', '[data-beat-artwork-id]'], ['texto', 'jpeg', '[data-probe-text]'], ['hueco', 'webp', null], ['gif', 'gif', '[data-probe-text]']]) {
    await dismissNotice(); await sleep(150);
    await enter(`img-${label}.${kind === 'jpeg' ? 'jpg' : kind}`, kind, cardSel, part); await release();
    const n = await waitFor(async () => { const t = await notice(); return /Portada actualizada|No se pudo/.test(t) ? t : null; }, { timeout: 40000, msg: `notice ${label}` }).catch(async () => `TIMEOUT :: ${await notice()}`);
    await sleep(600);
    const after = await apiBeat(NAME); await sleep(300);
    rec(`FUN-IMAGE-${label}`, /Portada actualizada/.test(n) && after.art !== prev.art && after.version !== prev.version && after.id === before.id && after.master === before.master && JSON.stringify(after.tags) === JSON.stringify(before.tags) && after.bpm === before.bpm && !(await alertText()) && (await total()) === count0 ? 'PASS' : 'FAIL', { prevArt: prev.art, after, notice: n, total: await total(), count0 });
    prev = after;
  }
  await shot('fun-after-artwork');
  // ---- Incompatibles / fuera de tarjeta: solo avisan cuando corresponde, sin cambios ----
  for (const [id, name, kind, sel, expectAlert] of [['svg-en-tarjeta', 'x.svg', 'svg', cardSel, 'Unsupported file'], ['txt-en-tarjeta', 'x.txt', 'txt', cardSel, 'Unsupported file'], ['imagen-fuera', 'fuera.png', 'png', null, 'Drop the image on a beat'], ['txt-fuera', 'x.txt', 'txt', null, 'Unsupported file']]) {
    await enter(name, kind, sel, sel ? '[data-probe-text]' : null); await release(); await sleep(500);
    const a = await alertText(); await shot(`fun-${id}`); await closeAlert(); await sleep(200);
    const after = await apiBeat(NAME);
    rec(`FUN-${id}`, a === expectAlert && after.art === prev.art && after.version === prev.version && (await total()) === count0 ? 'PASS' : 'FAIL', { alert: a, expectAlert, after, total: await total() });
  }
  // ---- Audio sobre la tarjeta: cancelar no cambia nada; reemplazar conserva beat y portada; fuera de tarjeta importa ----
  await enter('c.mp3', 'mp3', cardSel, '[data-probe-text]'); await release(); await sleep(400);
  const dlg = await ex(() => /Replace MP3\?/.test(document.body.innerText)); await shot('fun-audio-confirm'); await press('Cancel'); await sleep(500);
  const afterCancel = await apiBeat(NAME);
  rec('FUN-AUDIO-cancel', dlg && afterCancel.master === prev.master && afterCancel.version === prev.version ? 'PASS' : 'FAIL', { dlg, afterCancel });
  await enter('r.mp3', 'mp3', cardSel, '[data-probe-text]'); await release(); await sleep(400); await press('Replace');
  const okM = await waitFor(async () => /MP3 reemplazado/.test(await notice()) || null, { timeout: 60000, msg: 'mp3' }).catch(() => false);
  const afterM = await apiBeat(NAME);
  rec('FUN-AUDIO-mp3', okM && afterM.id === before.id && afterM.master !== prev.master && afterM.art === prev.art && JSON.stringify(afterM.tags) === JSON.stringify(before.tags) && (await total()) === count0 ? 'PASS' : 'FAIL', { before: prev, afterM });
  await sleep(500);
  await enter(`Fuera de tarjeta ${Date.now() % 100000}.mp3`, 'mp3', null); await release();
  await waitFor(async () => (await ex(() => /Review beat 1 of 1/.test(document.body.innerText))) || null, { timeout: 30000, msg: 'review' }); await sleep(500);
  await ex(() => { [...document.querySelectorAll('button')].find((x) => /^Save/.test(x.textContent.trim()) && !x.disabled)?.click(); });
  const okN = await waitFor(async () => /importado\./.test(await notice()) || null, { timeout: 60000, msg: 'import' }).catch(() => false);
  rec('FUN-AUDIO-fuera-importa', okN && (await total()) === count0 + 1 ? 'PASS' : 'FAIL', { total: await total(), expected: count0 + 1 });
  rec('VIS-LOGS', 'INFO', { severe: (await browser.getLogs('browser').catch(() => [])).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 200)) });
} catch (e) { rec('VIS', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
