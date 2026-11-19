// E71 — Entrada del probe MSE en navegador real: usa el código de producción (feedStream + createMseSink + mp3DeclaredDuration) sin cambios.
import { createMseSink, feedStream, mseSupportsMp3 } from "../../src/features/library/catalog/catalogStreamSource";
import { mp3DeclaredDuration } from "../../src/features/audio/mp3PlayablePrefix";
import { Sha256 } from "../../src/features/library/catalog/catalogTransfer";

type Case = { name: string; url: string; usePrefix: boolean; latencyMs: number; bytesPerMs: number; chunkBytes?: number; firstBytes?: number; seekTo?: number; switchAfterMs?: number; corruptAt?: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(c: Case) {
  const all = new Uint8Array(await (await fetch(c.url)).arrayBuffer());
  const sha = new Sha256().update(all).digestHex();
  const prefix = c.usePrefix ? all.slice(0, 128 * 1024) : null;
  const reads: Array<{ offset: number; length: number }> = [];
  const audio = new Audio(); audio.muted = true;
  const sink = createMseSink();
  const t0 = performance.now(); let playingAt = -1; let errors = 0; let stalls = 0;
  audio.addEventListener("playing", () => { if (playingAt < 0) playingAt = performance.now() - t0; });
  audio.addEventListener("error", () => { errors++; });
  audio.addEventListener("waiting", () => { stalls++; });
  audio.src = sink.url; void audio.play().catch(() => {});
  const controller = new AbortController();
  // Red simulada: latencia fija por petición + ancho de banda (bytes/ms). NO es red real.
  const read = async (offset: number, length: number) => { reads.push({ offset, length }); await sleep(c.latencyMs + length / c.bytesPerMs); const s = all.slice(offset, offset + length); if (c.corruptAt != null && c.corruptAt >= offset && c.corruptAt < offset + length) s[c.corruptAt - offset] ^= 0xff; return s; };
  const feed = feedStream({ size: all.length, fileSha256: sha, prefix, read, sink, signal: controller.signal, chunkBytes: c.chunkBytes, firstBytes: c.firstBytes, durationOf: (h) => mp3DeclaredDuration(h) });
  let feedResult: unknown = null; let feedError: string | null = null;
  const done = feed.then((r) => { feedResult = r; }, (e) => { feedError = String(e?.code || e?.message || e); });
  if (c.switchAfterMs) { await sleep(c.switchAfterMs); controller.abort(); sink.close(); await done; return { name: c.name, cancelled: true, readsAfterCancel: reads.length, feedError }; }
  await done;
  const waitPlaying = async (ms: number) => { const end = performance.now() + ms; while (playingAt < 0 && performance.now() < end) await sleep(20); };
  await waitPlaying(8000);
  let seek: unknown = null;
  if (c.seekTo != null) {
    const target = audio.duration * c.seekTo; const ts = performance.now();
    audio.currentTime = target; await new Promise((r) => { audio.addEventListener("seeked", r, { once: true }); setTimeout(r, 4000); });
    const t1 = audio.currentTime; await sleep(600); seek = { target: +target.toFixed(2), afterSeek: +t1.toFixed(2), advancing: audio.currentTime > t1, ms: Math.round(performance.now() - ts) };
  }
  const b = audio.buffered; const ranges: Array<[number, number]> = []; for (let i = 0; i < b.length; i++) ranges.push([+b.start(i).toFixed(3), +b.end(i).toFixed(3)]);
  const out = { name: c.name, bytes: all.length, mseMp3: mseSupportsMp3(), firstAudioMs: Math.round(playingAt), reads: reads.length, firstRead: reads[0] ?? null, readBytes: reads.reduce((n, r) => n + r.length, 0), declaredDuration: mp3DeclaredDuration(all.subarray(0, 128 * 1024)), duration: +audio.duration.toFixed(3), ranges, errors, stalls, mediaError: audio.error ? audio.error.code : null, feedResult, feedError, seek };
  audio.pause(); sink.close();
  return out;
}
(window as unknown as { runCases: (cs: Case[]) => Promise<unknown[]> }).runCases = async (cs: Case[]) => { const out = []; for (const c of cs) out.push(await run(c)); return out; };
