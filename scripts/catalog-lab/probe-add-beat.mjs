// Sonda LAB: flujo de «Add beat» con PANTALLA DE REVISIÓN (Drawer en modo review, como el BeatGaler anterior) en el LAB (Chrome aislado, Cloud real + gateway FAKE + PostgreSQL efímero).
// E77: la subida va navegador → «Telegram» (doble HTTP del LAB FAKE); el retraso y el fallo simulados se inyectan en ese envío, no en el Cloud.
// El selector nativo no es automatizable: se sustituye HTMLInputElement.click() por un File inyectado; todo lo demás es la UI real.
//   A) MP3: revisar (nombre/BPM/key/tag/portada) → guardar → PostgreSQL + reproducción   B) nombre > 50: rechazado, no importa
//   C) cancelar: no importa nada   D) WAV: conversión WAV→MP3 (MASTER) + WAV HQ   E) PROJECT elegido en la revisión (ZIP)
//   node scripts/catalog-lab/probe-add-beat.mjs [--out DIR]
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'add-beat', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, installAudioCapture, audioState, browser, POSTGRES, cfg, sleep } = R;

const silentMp3Base64 = () => { const frame = Buffer.alloc(417); frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; return Buffer.concat(Array.from({ length: 1500 }, () => frame)).toString('base64'); };
const BUILD = `window.__mk = async (name, kind) => {
  if (kind === 'wav') { const rate = 44100, n = rate; const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 8000), true); return new File([buf], name, { type: 'audio/wav' }); }
  if (kind === 'png') { const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }); const g = cv.getContext('2d'); g.fillStyle = '#c0392b'; g.fillRect(0, 0, 64, 64); return new File([await new Promise((r) => cv.toBlob(r, 'image/png'))], name, { type: 'image/png' }); }
  if (kind === 'zip') return new File([new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], name, { type: 'application/zip' });
  const bytes = Uint8Array.from(atob(window.__mp3), (c) => c.charCodeAt(0)); return new File([bytes], name, { type: 'audio/mpeg' });
};`;
// Parchea el selector de archivos: la siguiente apertura devuelve el File (o varios, por cola, para los selectores del paso de revisión).
const armPicker = (...files) => ex((list) => (async () => {
  window.__queue = [];
  for (const [n, k] of list) window.__queue.push(await window.__mk(n, k));
  if (!window.__pickerPatched) {
    window.__pickerPatched = true; const orig = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== 'file' || !window.__queue.length) return orig.call(this);
      const file = window.__queue.shift(); const dt = new DataTransfer(); dt.items.add(file); this.files = dt.files;
      setTimeout(() => this.dispatchEvent(new Event('change', { bubbles: true })), 0);
    };
  }
})(), files);
const clickByText = (text, sel = 'button') => ex((t, s) => { const b = [...document.querySelectorAll(s)].find((x) => (x.textContent || '').trim() === t || (t.length > 8 && (x.textContent || '').includes(t))); if (!b) return false; b.click(); return true; }, text, 'button');
const clickStarts = (text) => ex((t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith(t) && !x.disabled); if (!b) return false; b.click(); return true; }, text);
const notice = () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || '');
const apiBeat = (name) => ex(async (n) => { const r = await fetch(`/beatgaler-api/catalog/v1/beats?limit=200&q=${encodeURIComponent(n)}`, { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); const it = ((await r.json()).items || []).find((x) => x.name === n); return it ? { id: it.id, bpm: it.bpm, key: it.key, tags: it.tags, hasWav: it.hasWav, hasProject: it.hasProject, hasArtwork: it.hasArtwork, master: it.playback?.fileId ?? null } : null; }, name);
const total = () => ex(async () => { const r = await fetch('/beatgaler-api/catalog/v1/beats?limit=200', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } }); return ((await r.json()).items || []).length; });
const setField = (idx, value) => ex((i, v) => { const inputs = [...document.querySelectorAll('input:not([type=file]):not([type=checkbox]):not([type=search])')].filter((x) => x.offsetParent !== null); const el = inputs[i]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); return inputs.length; }, idx, value);
const review = () => ex(() => ({ open: /Review beat 1 of 1/.test(document.body.innerText), name: [...document.querySelectorAll('input')].find((i) => i.offsetParent !== null && i.value && !i.type.match(/file|checkbox|search/))?.value, inputs: [...document.querySelectorAll('input:not([type=file]):not([type=checkbox]):not([type=search])')].filter((x) => x.offsetParent !== null).map((x) => ({ v: x.value, p: x.placeholder })) }));
const openPicker = async (files) => { await armPicker(...files); await clickByText('Add beat'); await sleep(500); await clickByText('Choose MP3 or WAV'); await waitFor(async () => (await review()).open || null, { timeout: 30000, msg: 'review open' }); await sleep(800); };

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => { const g = await galleryState(); return g.cards > 0 || (process.env.LAB_REAL === '1' && g.mode === 'postgres' && g.storeStatus === 'empty'); }, { timeout: 90000, msg: 'catalog cards' }); // LAB REAL: biblioteca inicialmente vacía
  await installAudioCapture();
  await ex((b64, build) => { window.__mp3 = b64; (0, eval)(build); }, silentMp3Base64(), BUILD);
  const count0 = await total();

  // A) MP3 → revisión → editar → guardar
  await openPicker([['Beat revisado.mp3', 'mp3']]); await shot('a1-review'); const r0 = await review();
  const NAME = 'Revisado ' + (Date.now() % 1000000);
  await setField(0, NAME); await setField(2, '128'); await setField(3, 'Am');
  // tag: el campo «Add tag, press Enter…»
  await ex(() => { const t = [...document.querySelectorAll('input')].find((i) => /Add tag/.test(i.placeholder)); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(t, 'Trap'); t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  // portada: el input de imagen del Drawer
  await ex(() => (async () => { const inp = document.querySelector('input[type=file][accept^="image"]'); const dt = new DataTransfer(); dt.items.add(await window.__mk('portada.png', 'png')); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); })());
  await sleep(1200); await shot('a1b-crop'); await clickByText('Apply crop'); await sleep(1500); await shot('a2-edited');
  const earlyA = await apiBeat(NAME);
  // «Save and finish» inmediato: la subida se retrasa 4 s en el navegador; la revisión debe cerrarse YA y el beat verse cargándose en la Gallery.
  await ex(() => { if (!window.__origFetch) { window.__origFetch = window.fetch; window.fetch = async (...a) => { const m = String((a[1] && a[1].method) || 'GET').toUpperCase(); if (m === 'POST' && String((a[0] && a[0].url) || a[0]).includes('/lab-telegram/send')) await new Promise((r) => setTimeout(r, window.__uploadDelay || 0)); return window.__origFetch(...a); }; const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__labSend = String(m).toUpperCase() === 'POST' && String(u).includes('/lab-telegram/send'); return xo.call(this, m, u, ...r); }; XMLHttpRequest.prototype.send = function (...a) { if (!this.__labSend) return xs.apply(this, a); const d = window.__uploadDelay || 0; if (d) setTimeout(() => xs.apply(this, a), d); else xs.apply(this, a); }; } window.__uploadDelay = 4000; });
  // E79 — estado único: muestreo por fotograma desde «Save» hasta después del commit (tarjetas del catálogo, tarjetas con el nombre del beat, su ordinal y estados vacíos).
  const cardsBefore = await ex(() => document.querySelectorAll('[data-card]').length);
  await ex((name) => { window.__frames = []; window.__framesStop = false; const tick = () => { const cards = [...document.querySelectorAll('[data-card]')]; const named = [...document.querySelectorAll('.lab-beat-tile')].filter((c) => c.textContent.includes(name)); const own = cards.find((c) => c.textContent.includes(name)); const st = document.querySelector('[data-catalog-state]'); window.__frames.push({ t: Math.round(performance.now()), cards: cards.length, named: named.length, ord: own ? own.getAttribute('data-ordinal') : null, pending: document.querySelectorAll('[data-pending-import]').length, status: st ? st.getAttribute('data-catalog-state') : null }); if (!window.__framesStop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }, NAME);
  const tSave = Date.now();
  await clickStarts('Save');
  const quick = await waitFor(async () => { const st = await ex((name) => ({ reviewOpen: /Review beat 1 of 1/.test(document.body.innerText), uploads: Number((document.querySelector('.bg-catalog-shell-status') || { getAttribute: () => 0 }).getAttribute('data-uploads') || 0), notice: (document.querySelector('.bg-catalog-notice') || {}).textContent || '', named: [...document.querySelectorAll('.lab-beat-tile')].filter((c) => c.textContent.includes(name)).length }), NAME); return !st.reviewOpen && st.uploads === 1 && st.notice.includes('Subiendo') ? st : null; }, { timeout: 6000, msg: 'review closed + upload in progress' }).catch(() => null);
  const tClosed = Date.now() - tSave; const midA = await apiBeat(NAME);
  rec('ADD-A0-SAVE-FINISH-IMMEDIATE', quick && tClosed < 3500 && quick.notice.includes('Subiendo') && quick.named === 0 && !midA ? 'PASS' : 'FAIL', { closedAfterMs: tClosed, state: quick, committedYet: Boolean(midA) });
  await shot('a2b-uploading');
  const okA = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import A' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  await sleep(1800); const frames = await ex(() => { window.__framesStop = true; return window.__frames; });
  await ex(() => { window.__uploadDelay = 0; });
  const bA = await apiBeat(NAME);
  const withCard = frames.filter((x) => x.named > 0); const ords = [...new Set(withCard.map((x) => x.ord))];
  rec('ADD-A1-SINGLE-STATE', bA && withCard.length > 0 && Math.max(...frames.map((x) => x.named)) === 1 && ords.length === 1 && !frames.some((x) => x.pending > 0 || x.status) && Math.min(...frames.map((x) => x.cards)) >= cardsBefore ? 'PASS' : 'FAIL', { frames: frames.length, maxCardsWithName: Math.max(...frames.map((x) => x.named)), ordinalsSeen: ords, provisionalCardsEver: frames.some((x) => x.pending > 0), emptyOrLoadingEver: frames.some((x) => Boolean(x.status)), cardsBefore, minCards: Math.min(...frames.map((x) => x.cards)), maxCards: Math.max(...frames.map((x) => x.cards)), cardAppearedMsAfterSave: withCard.length ? withCard[0].t - frames[0].t : null, committed: Boolean(bA) });
  rec('ADD-A-REVIEW-SAVE', r0.open && r0.name === 'Beat revisado' && !earlyA && /importado\./.test(String(okA)) && bA && bA.bpm === '128' && /^a/i.test(bA.key) && bA.tags.map((t) => t.toLowerCase()).includes('trap') && bA.hasArtwork && bA.master && (await total()) === count0 + 1 ? 'PASS' : 'FAIL', { review: r0, earlyListed: Boolean(earlyA), notice: okA, saved: bA });
  await sleep(800); await typeSearch(NAME); await sleep(900);
  const card = await ex(() => document.querySelector('[data-beat-card-id]')?.getAttribute('data-beat-card-id'));
  let played = null; if (card) { await (await browser.$(`[data-beat-card-id="${card}"] [data-beat-artwork-id]`)).click(); played = await waitFor(async () => { const a = (await audioState())[0]; return a && !a.paused && a.t > 0.1 && !a.error ? a : null; }, { timeout: 30000, msg: 'play' }).catch(() => null); }
  rec('ADD-A-PLAYS', played ? 'PASS' : 'FAIL', { audio: played }); await typeSearch(''); await sleep(600);

  // B) nombre > 50: se rechaza el guardado, nada se importa
  const count1 = await total();
  await openPicker([['Otro.mp3', 'mp3']]); await setField(0, 'N'.repeat(51)); await sleep(300); await clickStarts('Save'); await sleep(1500);
  const errB = await ex(() => /Máximo 50 caracteres/.test(document.body.innerText)); await shot('b-name-too-long');
  const still = (await review()).open;
  rec('ADD-B-NAME-50', errB && still && (await total()) === count1 ? 'PASS' : 'FAIL', { errB, reviewStillOpen: still });
  // C) cancelar (Cancel import): nada se importa ni se modifica
  await clickByText('Cancel import'); await sleep(900);
  rec('ADD-C-CANCEL', !(await review()).open && (await total()) === count1 && !(await apiBeat('N'.repeat(51))) ? 'PASS' : 'FAIL', { total: await total(), count1 });

  // D) WAV: conversión WAV → MP3 (MASTER) + WAV HQ
  await openPicker([['Beat wav.wav', 'wav']]); await shot('d1-wav-review');
  const WN = 'WAV ' + (Date.now() % 1000000); await setField(0, WN); await sleep(300); await clickStarts('Save');
  const okD = await waitFor(async () => /importado\./.test(await notice()) ? await notice() : null, { timeout: 90000, msg: 'import WAV' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  const bD = await apiBeat(WN);
  rec('ADD-D-WAV', /importado\./.test(String(okD)) && bD && bD.hasWav && bD.master ? 'PASS' : 'FAIL', { notice: okD, saved: bD });

  // E) PROJECT elegido en la revisión (slot PROJECT)
  await openPicker([['Con proyecto.mp3', 'mp3']]); const PN = 'Con proyecto ' + (Date.now() % 100000); await setField(0, PN);
  await armPicker(['mi-proyecto.zip', 'zip']);
  await ex(() => { const rows = [...document.querySelectorAll('span')].filter((s) => s.textContent.trim() === 'PROJECT'); const btn = rows[0]?.parentElement?.querySelector('button'); btn?.click(); }); await sleep(900);
  await ex(() => document.querySelector('.bg-catalog-notice button')?.click()); await clickStarts('Save');
  const okE = await waitFor(async () => /Con proyecto.*importado\./.test(await notice()) ? await notice() : null, { timeout: 60000, msg: 'import project' }).catch(async (e) => `ERR ${e.message} :: ${await notice()}`);
  const bE = await apiBeat(PN);
  rec('ADD-E-PROJECT-IN-REVIEW', /importado\./.test(String(okE)) && bE && bE.hasProject ? 'PASS' : 'FAIL', { notice: okE, saved: bE });
  // F) fallo definitivo en segundo plano: la revisión se reabre con lo editado, el beat no aparece y hay aviso claro (nunca un éxito falso)
  const FN = 'Fallo bg ' + (Date.now() % 1000000);
  await openPicker([['fallo.mp3', 'mp3']]); await sleep(800); await setField(0, FN); await sleep(300);
  await ex(() => { window.__origFetch2 = window.fetch; window.fetch = async (...a) => { const m = String((a[1] && a[1].method) || 'GET').toUpperCase(); if (m === 'POST' && String((a[0] && a[0].url) || a[0]).includes('/lab-telegram/send')) return new Response(JSON.stringify({ failure: { kind: 'PERMANENT', code: 'LAB_SIMULADO', retryAfterMs: 0 } }), { status: 409, headers: { 'Content-Type': 'application/json' } }); return window.__origFetch2(...a); };
    // E80: el doble Direct B envía con XMLHttpRequest: el mismo rechazo permanente simulado, sin red, para ese camino.
    const xo2 = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__labSend = String(m).toUpperCase() === 'POST' && String(u).includes('/lab-telegram/send'); return xo2.call(this, m, u, ...r); }; window.__origXhrSend2 = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function (...x) { if (!this.__labSend) return window.__origXhrSend2.apply(this, x); const body = JSON.stringify({ failure: { kind: 'PERMANENT', code: 'LAB_SIMULADO', retryAfterMs: 0 } }); Object.defineProperty(this, 'status', { value: 409 }); Object.defineProperty(this, 'responseText', { value: body }); this.getResponseHeader = () => 'application/json'; setTimeout(() => this.onload && this.onload(new Event('load')), 0); }; });
  await clickStarts('Save');
  const reopened = await waitFor(async () => { const st = await ex(() => ({ open: /Review beat 1 of 1/.test(document.body.innerText), name: [...document.querySelectorAll('input')].find((i) => i.offsetParent !== null && i.value === arguments[0])?.value || null, pending: Number((document.querySelector('.bg-catalog-shell-status') || { getAttribute: () => 0 }).getAttribute('data-uploads') || 0) })); return st.open && st.pending === 0 ? st : null; }, { timeout: 20000, msg: 'review reopened' }).catch(() => null);
  const nameKept = await ex((n) => [...document.querySelectorAll('input')].some((i) => i.value === n), FN);
  const noteF = await waitFor(async () => { const n = await notice(); return n.includes('No se pudo importar') ? n : null; }, { timeout: 20000, msg: 'failure notice' }).catch(() => notice()); const listedF = await apiBeat(FN);
  rec('ADD-F-BG-FAILURE-REOPENS-REVIEW', reopened && nameKept && /No se pudo importar/.test(noteF) && !listedF ? 'PASS' : 'FAIL', { reopened, nameKept, notice: noteF, listed: Boolean(listedF) });
  await ex(() => { window.fetch = window.__origFetch2; if (window.__origXhrSend2) XMLHttpRequest.prototype.send = window.__origXhrSend2; }); await clickByText('Cancel').catch(() => {}); await sleep(500);
  rec('ADD-LOGS', 'INFO', { severe: (await browser.getLogs('browser').catch(() => [])).filter((l) => l.level === 'SEVERE').map((l) => String(l.message).slice(0, 200)) });
} catch (e) { rec('ADD', 'ERROR', { message: String(e && e.message || e) }); await shot('error').catch(() => {}); } finally { await R.finish(); }
