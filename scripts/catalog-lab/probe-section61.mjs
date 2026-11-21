// Sonda LAB (§6.1 del documento maestro 2026-11-17) en Chrome real contra Cloud real + gateway FAKE + PostgreSQL efímero (Vite dev :1440).
//   node scripts/catalog-lab/probe-section61.mjs
// DRAWER-WAV: WAV elegido en el Drawer → se sube y queda en PostgreSQL (antes: «guardado» sin subir). DRAWER-BPM: metadatos persistidos.
// COVER-REMOVE: «Remove» → error explícito, Drawer abierto, portada intacta (antes: éxito falso). PENDING-*: subida interrumpida → aviso al
// recargar (abierta / terminada sin efecto) y referencia olvidada. Los beats tocados son del LAB (datos sintéticos); nada real.
import { parseArgs, createRun } from './browser-common.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'section61', args });
if (!R) process.exit(0);
const { rec, ex, waitFor, login, browser, POSTGRES, cfg, sleep, finish, shot } = R;

const api = (method, path, body, extra = {}) => ex(async (m, p, b, x) => {
  const ctx = await (await fetch('/beatgaler-api/catalog/v1/context', { credentials: 'include', headers: { 'X-BeatGaler-Client': 'web' } })).json();
  const h = { 'X-BeatGaler-Client': 'web', 'Content-Type': 'application/json', 'X-BeatGaler-CSRF': sessionStorage.getItem('beatgaler:web-csrf:v1') || '', 'X-Catalog-Era': ctx.authority_era, 'X-Catalog-Epoch': ctx.authority_epoch, ...x };
  const r = await fetch(`/beatgaler-api${p}`, { method: m, credentials: 'include', headers: h, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, userId: ctx.user_id };
}, method, path, body ?? null, extra);
const armPicker = (name, kind) => ex((n, k) => {
  const mk = () => { if (k === 'wav') { const len = 44 + 800; const b = new Uint8Array(len); const v = new DataView(b.buffer); const w = (o, s) => [...s].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
    w(0, 'RIFF'); v.setUint32(4, len - 8, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, 800, true);
    return new File([b], n, { type: 'audio/wav' }); } return new File([new Uint8Array(16)], n); };
  window.__queue = [mk()];
  if (!window.__pickerPatched) { window.__pickerPatched = true; const orig = HTMLInputElement.prototype.click; HTMLInputElement.prototype.click = function () { if (this.type !== 'file' || !window.__queue.length) return orig.call(this); const f = window.__queue.shift(); const dt = new DataTransfer(); dt.items.add(f); this.files = dt.files; setTimeout(() => this.dispatchEvent(new Event('change', { bubbles: true })), 0); }; }
}, name, kind);
const openEdit = async (id) => {
  await ex((i) => { const c = document.querySelector(`[data-card="${i}"] [data-beat-card-id]`) || document.querySelector(`[data-card="${i}"]`); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 })); }, id);
  await sleep(300);
  await ex(() => { const b = [...document.querySelectorAll('button, div, span')].find((x) => (x.textContent || '').trim() === 'Edit metadata'); b?.click(); });
  return waitFor(async () => ex(() => document.body.innerText.includes('Files stay pending until Save Changes')), { timeout: 10000, msg: 'edit drawer' });
};
const drawerOpen = () => ex(() => document.body.innerText.includes('Files stay pending until Save Changes'));
const clickSlot = (slot) => ex((s) => { const row = [...document.querySelectorAll('div')].find((d) => d.children.length >= 3 && d.firstElementChild?.textContent === s && d.querySelector('button')); row?.querySelector('button')?.click(); return Boolean(row); }, slot);
const clickSave = () => ex(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith('Save changes') && !x.disabled); b?.click(); return Boolean(b); });
const getBeat = async (id) => (await api('GET', `/catalog/v1/beats/${encodeURIComponent(id)}`)).body;

try {
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await ex(() => document.querySelectorAll('[data-card]').length)) > 2, { timeout: 90000, msg: 'cards' });
  await sleep(800);
  const ids = await ex(() => [...document.querySelectorAll('[data-card]')].slice(0, 6).map((c) => c.getAttribute('data-card')));
  const details = []; for (const id of ids) details.push(await getBeat(id));
  const target = details.find((d) => !d.hasWav) ?? details[0];

  // DRAWER-WAV
  await openEdit(target.id);
  await armPicker('lab-hq.wav', 'wav');
  const slotClicked = await clickSlot('WAV'); await sleep(500);
  const pendingShown = await ex(() => document.body.innerText.includes('Pending: lab-hq.wav'));
  await clickSave();
  const closed = await waitFor(async () => !(await drawerOpen()), { timeout: 30000, msg: 'drawer closes after save' }).catch(() => false);
  const errText = closed ? null : await ex(() => document.body.innerText.slice(-600));
  const after = await getBeat(target.id);
  rec('DRAWER-WAV', slotClicked && pendingShown && closed && after.hasWav === true && Number(after.version) > Number(target.version) ? 'PASS' : 'FAIL', { beat: target.id, hadWav: target.hasWav, slotClicked, pendingShown, closed, errText, hasWavAfter: after.hasWav, version: [target.version, after.version] });
  await shot('drawer-wav-after');

  // DRAWER-BPM (metadatos; antes en un beat sin MASTER no se enviaba nada)
  const t2 = await getBeat(target.id); const newBpm = String(t2.bpm === '141' ? 142 : 141);
  await openEdit(target.id);
  await ex((v) => { const i = [...document.querySelectorAll('input[inputmode="decimal"]')][0]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); }, newBpm);
  await sleep(200); await clickSave();
  const closed2 = await waitFor(async () => !(await drawerOpen()), { timeout: 20000, msg: 'drawer closes' }).catch(() => false);
  const t3 = await getBeat(target.id);
  rec('DRAWER-BPM', closed2 && t3.bpm === newBpm ? 'PASS' : 'FAIL', { bpm: [t2.bpm, t3.bpm], expected: newBpm });

  // COVER-ADD (portada nueva desde el Drawer → REPLACE con ARTWORK) si no hay ningún beat visible con portada
  let withArt = details.find((d) => d.hasArtwork);
  if (!withArt) {
    await openEdit(target.id);
    await ex(() => (async () => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); const inp = document.querySelector('input[type=file][accept^="image"]'); const dt = new DataTransfer(); dt.items.add(new File([png], 'cover.png', { type: 'image/png' })); inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true })); })());
    // el Drawer abre el recorte (ImageCropModal) antes de aceptar la imagen
    await waitFor(async () => ex(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Apply crop')), { timeout: 15000, msg: 'crop modal' }).catch(() => null);
    await sleep(500); await ex(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Apply crop')?.click());
    await waitFor(async () => ex(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Remove')), { timeout: 15000, msg: 'cover picked' }).catch(() => null);
    const before = await getBeat(target.id); await clickSave();
    const closed3 = await waitFor(async () => !(await drawerOpen()), { timeout: 30000, msg: 'drawer closes' }).catch(() => false);
    const a1 = await getBeat(target.id);
    rec('COVER-ADD', closed3 && a1.hasArtwork === true && Number(a1.version) > Number(before.version) ? 'PASS' : 'FAIL', { closed: closed3, hasArtwork: a1.hasArtwork, version: [before.version, a1.version] });
    if (a1.hasArtwork) withArt = a1;
    await sleep(1500);
  }
  // COVER-REMOVE
  if (!withArt) rec('COVER-REMOVE', 'NO EJECUTADO', { reason: 'ningún beat visible con portada' });
  else {
    await openEdit(withArt.id);
    await waitFor(async () => ex(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Remove')), { timeout: 15000, msg: 'cover loaded in drawer' });
    await ex(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove').click()); await sleep(200);
    await clickSave();
    // decisión del propietario 2026-11-17: «Remove» desvincula la portada en PostgreSQL (detalle en probe-artwork-remove.mjs)
    const closedR = await waitFor(async () => !(await drawerOpen()), { timeout: 20000, msg: 'drawer closes (remove)' }).catch(() => false);
    const art = await getBeat(withArt.id);
    rec('COVER-REMOVE', closedR && art.hasArtwork === false && art.artwork === null && Number(art.version) === Number(withArt.version) + 1 ? 'PASS' : 'FAIL', { closed: closedR, hasArtwork: art.hasArtwork, version: [withArt.version, art.version] });
    await shot('cover-removed');
  }

  // PENDING-OPEN / PENDING-ENDED: operación IMPORT creada y nunca subida (como una pestaña cerrada a medias) + referencia local.
  const pname = `LAB pending ${Date.now() % 100000}`;
  const created = await api('POST', '/catalog/v1/operations', { kind: 'IMPORT', parts: [{ partKey: 'MASTER:0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: 417, sha256: 'a'.repeat(64), filename: 'p.mp3', mime: 'audio/mpeg' }], metadata: { name: pname, bpm: '', key: '', tags: [], rating: 0 } }, { 'Idempotency-Key': `lab-${Date.now()}` });
  const opId = created.body?.operationId; const uid = created.userId;
  await ex((u, o, n) => { const k = `beatgaler:catalog-ops:v1:${u}`; const refs = JSON.parse(localStorage.getItem(k) || '[]'); refs.push({ operationId: o, kind: 'IMPORT', beatId: null, label: `Importar «${n}»`, nameKey: n.toLowerCase(), createdAt: Date.now() }); localStorage.setItem(k, JSON.stringify(refs)); }, uid, opId, pname);
  await browser.url(`${POSTGRES}/gallery`);
  const n1 = await waitFor(async () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || ''), { timeout: 30000, msg: 'notice open' }).catch(() => '');
  rec('PENDING-OPEN', created.status < 300 && n1.includes('aún confirmándose') && n1.includes(pname) ? 'PASS' : 'FAIL', { create: created.status, opStatus: created.body?.status, notice: n1 });
  const cancel = await api('POST', `/catalog/v1/operations/${opId}/cancel`, {});
  await browser.url(`${POSTGRES}/gallery`);
  const n2 = await waitFor(async () => ex(() => document.querySelector('.bg-catalog-notice')?.textContent || ''), { timeout: 30000, msg: 'notice ended' }).catch(() => '');
  const refsLeft = await ex((u, o) => JSON.parse(localStorage.getItem(`beatgaler:catalog-ops:v1:${u}`) || '[]').filter((r) => r.operationId === o).length, uid, opId);
  rec('PENDING-ENDED', cancel.body?.status === 'CANCELED' && n2.includes('no completada') && refsLeft === 0 ? 'PASS' : 'FAIL', { cancel: cancel.body?.status, notice: n2, refsLeft });
} catch (e) { rec('ERROR-RUN', 'FAIL', { message: String(e.message).slice(0, 400) }); await shot('error'); }
await finish();
