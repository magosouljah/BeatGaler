// E71 — Probe LAB: compatibilidad REAL de MSE `audio/mpeg` en Chrome con el código de streaming de producción (empaquetado con esbuild).
// Red SIMULADA dentro de la página (latencia + ancho de banda por petición); no es Telegram ni red real. Sin servicios externos.
// Caso mse-stream del humo V1. Salida: tmp/e71-mse/results.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { remote } from 'webdriverio';
import { Mp3Encoder } from '@breezystack/lamejs';
import { localChromeOptions } from './browser-common.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = path.join(ROOT, 'tmp', 'e71-mse');
fs.mkdirSync(OUT, { recursive: true });
await build({ entryPoints: [path.join(ROOT, 'scripts/catalog-lab/mse-probe-entry.ts')], bundle: true, format: 'iife', outfile: path.join(OUT, 'bundle.js'), platform: 'browser', target: 'es2020', logLevel: 'error',
  plugins: [{ name: 'stub-account', setup(b) { b.onResolve({ filter: /auth\/webSession$/ }, () => ({ path: path.join(ROOT, 'scripts/catalog-lab/mse-probe-accountgate-stub.ts') })); } }] });

// MP3 sintético CBR 128 kbps estéreo, 40 s (tono + ruido para que el codificador no colapse frames).
function synth(seconds = 40, rate = 44100) {
  const enc = new Mp3Encoder(2, rate, 128); const block = 1152; const parts = []; const n = seconds * rate;
  const l = new Int16Array(block); const r = new Int16Array(block); let seed = 7;
  for (let i = 0; i < n; i += block) {
    for (let j = 0; j < block; j++) { const t = (i + j) / rate; seed = (seed * 1103515245 + 12345) & 0x7fffffff; const noise = ((seed / 0x7fffffff) - 0.5) * 2000; l[j] = Math.round(Math.sin(2 * Math.PI * 220 * t) * 8000 + noise); r[j] = Math.round(Math.sin(2 * Math.PI * 330 * t) * 8000 - noise); }
    const b = enc.encodeBuffer(l, r); if (b.length) parts.push(Buffer.from(b));
  }
  const end = enc.flush(); if (end.length) parts.push(Buffer.from(end));
  return Buffer.concat(parts);
}
const files = { 'synth.mp3': synth() };
for (const f of ['beat-de-prueba.mp3', 'Galer E2E Beat.mp3']) { const p = path.join(ROOT, 'tmp', 'gallery-test', f); if (fs.existsSync(p)) files[f.replace(/ /g, '_')] = fs.readFileSync(p); }
const html = '<!doctype html><meta charset="utf-8"><title>mse</title><script src="/bundle.js"></script>';
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  if (name === '' ) { res.setHeader('content-type', 'text/html'); return res.end(html); }
  if (name === 'bundle.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(path.join(OUT, 'bundle.js'))); }
  if (files[name]) { res.setHeader('content-type', 'audio/mpeg'); return res.end(files[name]); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = path.join(ROOT, 'tmp', 'catalog-lab', 'state', 'e71-mse-profile');
const localChrome = process.env.CATALOG_LAB_SMOKE_CASE === '1' ? localChromeOptions() : null;
const caps = { browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless=new', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', `--disk-cache-dir=${path.join(profile, 'cache')}`] } };
if (localChrome) {
  caps['goog:chromeOptions'].binary = localChrome.chromeBinary;
  caps['wdio:chromedriverOptions'] = { binary: localChrome.chromedriver };
}
const browser = await remote({ logLevel: 'error', capabilities: caps });
try {
  await browser.url(base + '/');
  const net = { latencyMs: 250, bytesPerMs: 1000 }; // ≈ 250 ms por petición y ≈ 8 Mbit/s (simulado)
  const cases = [];
  for (const f of Object.keys(files)) {
    cases.push({ name: `${f} sin prefijo`, url: `/${f}`, usePrefix: false, ...net, seekTo: 0.7 });
    cases.push({ name: `${f} con prefijo local 128 KiB`, url: `/${f}`, usePrefix: true, ...net, seekTo: 0.7 });
    cases.push({ name: `${f} cortes impares (first 100003, chunk 77777)`, url: `/${f}`, usePrefix: false, ...net, firstBytes: 100003, chunkBytes: 77777 });
  }
  cases.push({ name: 'synth.mp3 byte corrupto → integridad', url: '/synth.mp3', usePrefix: false, ...net, corruptAt: 300000 });
  cases.push({ name: 'synth.mp3 cambio de canción a los 300 ms (cancelación)', url: '/synth.mp3', usePrefix: false, ...net, switchAfterMs: 300 });
  cases.push({ name: 'synth.mp3 legado (descarga completa antes de sonar, misma red)', url: '/synth.mp3', usePrefix: false, latencyMs: 250, bytesPerMs: 1000, firstBytes: files['synth.mp3'].length, chunkBytes: files['synth.mp3'].length });
  const results = await browser.executeAsync((cs, done) => { window.runCases(cs).then(done, (e) => done({ error: String(e) })); }, cases);
  const ua = await browser.execute(() => navigator.userAgent);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ userAgent: ua, network: 'SIMULADA en la página: 250 ms/petición + ~8 Mbit/s', results }, null, 1));
  console.log('ok', path.join(OUT, 'results.json'));
} finally { await browser.deleteSession().catch(() => {}); server.close(); }
