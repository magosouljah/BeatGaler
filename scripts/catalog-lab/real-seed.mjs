// LAB REAL: siembra N beats desechables por la API (MP3 sintético) para sondas que necesitan tarjetas.   node scripts/catalog-lab/real-seed.mjs [N]
import crypto from 'node:crypto'; import { login, importBeat, rec, results } from './real-api.mjs';
await login(); const N = Number(process.argv[2] || 6); const S = String(Date.now() % 1e6);
for (let i = 0; i < N; i++) { const f = Buffer.alloc(417); f[0] = 0xff; f[1] = 0xfb; f[2] = 0x90; const b = Buffer.concat([...Array.from({ length: 200 + i }, () => f), crypto.randomBytes(8)]); const r = await importBeat(`Seed ${S} ${i}`, [{ role: 'MASTER', bytes: b, filename: `s${i}.mp3`, mime: 'audio/mpeg' }]); rec(`SEED-${i}`, r.commit?.status === 200, {}); }
console.log(`SUMMARY PASS=${results.filter(Boolean).length} FAIL=${results.filter((x) => !x).length}`);
