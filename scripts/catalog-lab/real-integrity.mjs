// LAB REAL: integridad de bytes por la API (Telegram real de pruebas). Importa archivos conocidos, descarga completo y por Range y compara SHA-256.
//   . /tmp/realenv.sh; node scripts/catalog-lab/real-integrity.mjs
import crypto from 'node:crypto';
import { login, importBeat, find, req, E, downloadFile, sha, rec, results } from './real-api.mjs';
await login();
const S = String(Date.now() % 1e6);
const mp3 = (frames) => { const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; return Buffer.concat(Array.from({ length: frames }, () => f)); };
const rnd = (n) => crypto.randomBytes(n);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const cases = [
  ['MP3-625KB-2chunks', [{ role: 'MASTER', bytes: Buffer.concat([mp3(1500), rnd(64)]), filename: 'a.mp3', mime: 'audio/mpeg' }, { role: 'ARTWORK', bytes: PNG, filename: 'c.png', mime: 'image/png' }]],
  ['WAV-3MB-random', [{ role: 'MASTER', bytes: mp3(300), filename: 'm.mp3', mime: 'audio/mpeg' }, { role: 'WAV', bytes: rnd(3 * 1024 * 1024 + 123), filename: 'hq.wav', mime: 'audio/wav' }]],
];
for (const [label, files] of cases) {
  const name = `Integridad ${label} ${S}`;
  const r = await importBeat(name, files);
  const ok = r.commit && r.commit.status < 300 && r.commit.body?.status === 'COMMITTED';
  rec(`INT-IMPORT-${label}`, ok, { commit: r.commit?.status, failed: ok ? undefined : JSON.stringify(r).slice(0, 300) });
  if (!ok) continue;
  const beat = await find(name);
  const fl = (await req('GET', `/catalog/v1/beats/${beat.id}/files`)).body;
  for (const f of files) {
    const meta = (fl.files || fl.items || []).find((x) => x.role === f.role);
    if (!meta) { rec(`INT-DOWNLOAD-${label}-${f.role}`, false, { error: 'sin fichero ' + JSON.stringify(fl).slice(0, 200) }); continue; }
    const d = await downloadFile(meta.fileId || meta.file_id);
    const got = d.parts && Buffer.concat(d.parts.map((p) => p.buf));
    rec(`INT-DOWNLOAD-${label}-${f.role}`, Boolean(got) && sha(got) === sha(f.bytes) && got.length === f.bytes.length, { size: got && got.length, expected: f.bytes.length, statuses: d.parts && d.parts.map((p) => p.status), access: d.access.status });
    if (f.bytes.length > 600000) { // Range desalineado: el segundo trozo debe coincidir byte a byte
      const a = 600001; const b = f.bytes.length - 17;
      const dr = await downloadFile(meta.fileId || meta.file_id, `bytes=${a}-${b}`);
      const gr = dr.parts && Buffer.concat(dr.parts.map((p) => p.buf));
      rec(`INT-RANGE-${label}-${f.role}`, Boolean(gr) && gr.equals(f.bytes.subarray(a, b + 1)), { statuses: dr.parts && dr.parts.map((p) => p.status), got: gr && gr.length, want: b - a + 1 });
    }
  }
}
console.log(`SUMMARY PASS=${results.filter(Boolean).length} FAIL=${results.filter((x) => !x).length}`);
