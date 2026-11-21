// Sonda LAB REAL: «Download Everything» desde la UI con MP3 + WAV + PROJECT reales (Telegram de pruebas); SHA-256 de cada archivo guardado.
//   . /tmp/realenv2.sh; node scripts/catalog-lab/probe-download-all.mjs [--out DIR]
import crypto from 'node:crypto';
import { parseArgs, createRun } from './browser-common.mjs';
import * as API from './real-api.mjs';
const args = parseArgs();
const R = await createRun({ kind: 'download-all', args });
if (!R) process.exit(0);
const { rec, ex, shot, waitFor, login, galleryState, typeSearch, browser, POSTGRES, cfg, sleep } = R;
const ok = (id, cond, extra) => rec(id, cond ? 'PASS' : 'FAIL', extra);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const S = String(Date.now() % 1e6); const NAME = `Descarga total ${S}`;
const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90;
const mp3 = Buffer.concat([...Array.from({ length: 1400 }, () => f), crypto.randomBytes(40)]);
const wav = crypto.randomBytes(1_700_000);
const zip = Buffer.concat([Buffer.from('PK\x03\x04'), crypto.randomBytes(1_100_000), Buffer.from([0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
const expected = { mp3: sha(mp3), wav: sha(wav), zip: sha(zip) };
try {
  await API.login();
  const r = await API.importBeat(NAME, [{ role: 'MASTER', bytes: mp3, filename: 'master.mp3', mime: 'audio/mpeg' }, { role: 'WAV', bytes: wav, filename: 'hq.wav', mime: 'audio/wav' }, { role: 'PROJECT', bytes: zip, filename: 'proj.zip', mime: 'application/zip' }]);
  ok('DL-0-IMPORT-3-FILES', r.commit?.status === 200 && r.commit.body?.status === 'COMMITTED', { commit: r.commit?.status });
  await login(POSTGRES, cfg.account);
  await waitFor(async () => (await galleryState()).cards > 0, { timeout: 90000, msg: 'cards' });
  await typeSearch(NAME); await sleep(1200);
  await ex(() => { window.__saved = []; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { const name = this.download; const href = this.href; (async () => { const b = new Uint8Array(await (await fetch(href)).arrayBuffer()); const h = await crypto.subtle.digest('SHA-256', b); window.__saved.push({ name, size: b.length, sha: [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('') }); })(); return; } return orig.call(this); }; });
  const cardSel = await ex(() => { const c = document.querySelector('[data-beat-card-id]'); return c ? `[data-beat-card-id="${c.getAttribute('data-beat-card-id')}"]` : null; });
  const opened = await ex((s) => { const c = document.querySelector(s); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.y + 20 })); return new Promise((res) => setTimeout(() => { const m = [...document.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent.trim() === 'Download'); m?.click(); res(Boolean(m)); }, 250)); }, cardSel);
  await sleep(900); await shot('download-all-modal');
  const label = await ex(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /Download Everything|^MP3|^WAV|Full Project/.test(t)));
  await ex(() => { const b = [...document.querySelectorAll('button')].find((x) => /Download Everything/.test(x.textContent) && !x.disabled); b?.click(); });
  const saved = await waitFor(async () => { const s = await ex(() => window.__saved); return s.length >= 3 ? s : null; }, { timeout: 90000, msg: 'tres descargas' }).catch(async () => ex(() => window.__saved));
  const by = (re) => saved.find((s) => re.test(s.name));
  const mp = by(/\.mp3$/i), wv = by(/\.wav$/i), zp = by(/\.zip$/i);
  ok('DL-1-EVERYTHING-3-FILES', opened && Boolean(mp && wv && zp), { opened, options: label, saved: saved.map((s) => ({ name: s.name, size: s.size })) });
  ok('DL-2-SHA256-MP3', Boolean(mp) && mp.sha === expected.mp3 && mp.size === mp3.length, { size: mp?.size, expected: mp3.length });
  ok('DL-2-SHA256-WAV', Boolean(wv) && wv.sha === expected.wav && wv.size === wav.length, { size: wv?.size, expected: wav.length });
  ok('DL-2-SHA256-PROJECT', Boolean(zp) && zp.sha === expected.zip && zp.size === zip.length, { size: zp?.size, expected: zip.length });
} catch (e) { rec('DL-ERROR', 'ERROR', { message: String(e.message || e).slice(0, 200) }); await shot('download-all-error').catch(() => {}); }
await R.finish();
