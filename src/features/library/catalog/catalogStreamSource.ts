// E71 — Streaming progresivo de MP3 para la Playbar del catálogo (Documento Maestro §7.3), sobre Direct B (navegador ← Telegram; el Cloud no sirve bytes).
//  - Empieza con el prefijo local (si existe y coincide con la versión exacta: clave = SHA-256 del archivo completo) y pide SOLO el resto.
//  - Sin prefijo, la primera lectura es de 128 KiB (arranque rápido) y el resto llega en rangos crecientes; siempre se lee un rango por delante.
//  - SHA-256 progresivo de TODOS los bytes en orden (prefijo incluido): no bloquea el inicio; al final, una discrepancia detiene el audio,
//    borra el prefijo local y se informa (integridad). El audio original en Telegram nunca se toca.
//  - MSE `audio/mpeg`: el analizador del navegador re-sincroniza frames, así que un corte en un byte arbitrario es válido SOLO si los trozos se
//    añaden en orden y contiguos (comprobado en Chrome real: E71). Nunca se añaden trozos fuera de orden ni de otra versión.
//  - Sin MSE para MP3 → el llamador usa la descarga completa (fallback funcional).
import { Sha256 } from "./catalogTransfer";

export interface StreamSink {
  append(bytes: Uint8Array): Promise<void>;
  end(): Promise<void>;
  fail(error: Error): void;
  setDuration?(seconds: number): void;
}
export interface FeedOptions {
  size: number;
  fileSha256: string | null;
  prefix: Uint8Array | null;
  read: (offset: number, length: number, signal: AbortSignal) => Promise<Uint8Array>;
  sink: StreamSink;
  signal: AbortSignal;
  firstBytes?: number;
  chunkBytes?: number;
  maxChunkBytes?: number;
  onPrefix?: (bytes: Uint8Array) => void;
  onIntegrity?: (ok: boolean, actual: string | null) => void;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  durationOf?: (head: Uint8Array) => number | null;
}
export interface FeedResult { requests: number; networkBytes: number; prefixUsed: boolean; verified: boolean | null; firstAppendMs: number; totalMs: number }

export const STREAM_DEFAULTS = Object.freeze({ firstBytes: 128 * 1024, chunkBytes: 256 * 1024, maxChunkBytes: 2 * 1024 * 1024 });
const aborted = () => Object.assign(new Error("stream cancelled"), { name: "AbortError" });

export async function feedStream(o: FeedOptions): Promise<FeedResult> {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  const firstBytes = o.firstBytes ?? STREAM_DEFAULTS.firstBytes;
  let chunk = o.chunkBytes ?? STREAM_DEFAULTS.chunkBytes; const maxChunk = o.maxChunkBytes ?? STREAM_DEFAULTS.maxChunkBytes;
  const hasher = o.fileSha256 ? new Sha256() : null;
  let pos = 0; let requests = 0; let networkBytes = 0; let firstAppendMs = -1;
  const prefixUsed = Boolean(o.prefix && o.prefix.byteLength > 0 && o.prefix.byteLength <= o.size);
  const push = async (bytes: Uint8Array) => {
    if (o.signal.aborted) throw aborted();
    hasher?.update(bytes);
    await o.sink.append(bytes);
    if (firstAppendMs < 0) firstAppendMs = clock();
    pos += bytes.byteLength; o.onProgress?.(pos, o.size);
  };
  const fetchRange = async (offset: number, length: number) => {
    const b = await o.read(offset, length, o.signal);
    requests++; networkBytes += b.byteLength;
    if (b.byteLength !== length) throw Object.assign(new Error(`short read at ${offset}: ${b.byteLength} of ${length}`), { code: "MEDIA_SHORT_READ" });
    return b;
  };
  try {
    if (prefixUsed) {
      const d = o.durationOf?.(o.prefix!); if (d && Number.isFinite(d) && d > 0) o.sink.setDuration?.(d);
      await push(o.prefix!);
    } else {
      const head = await fetchRange(0, Math.min(firstBytes, o.size));
      const d = o.durationOf?.(head); if (d && Number.isFinite(d) && d > 0) o.sink.setDuration?.(d);
      o.onPrefix?.(head);
      await push(head);
    }
    // Un rango por delante: mientras el navegador decodifica el trozo n, ya se descarga el n+1.
    let next: Promise<Uint8Array> | null = pos < o.size ? fetchRange(pos, Math.min(chunk, o.size - pos)) : null;
    while (next) {
      const bytes = await next;
      const after = pos + bytes.byteLength;
      chunk = Math.min(maxChunk, chunk * 2);
      next = after < o.size ? fetchRange(after, Math.min(chunk, o.size - after)) : null;
      next?.catch(() => {}); // si el actual falla, el siguiente no queda como rechazo sin manejar
      await push(bytes);
    }
    let verified: boolean | null = null;
    if (hasher) {
      const actual = hasher.digestHex(); verified = actual === o.fileSha256;
      o.onIntegrity?.(verified, actual);
      if (!verified) { const e = Object.assign(new Error("audio hash differs from the declared hash"), { code: "MEDIA_HASH_MISMATCH" }); o.sink.fail(e); throw e; }
    }
    await o.sink.end();
    return { requests, networkBytes, prefixUsed, verified, firstAppendMs, totalMs: clock() };
  } catch (error) {
    if ((error as { name?: string }).name !== "AbortError" && (error as { code?: string }).code !== "MEDIA_HASH_MISMATCH") o.sink.fail(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export function mseSupportsMp3(): boolean {
  return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function" && MediaSource.isTypeSupported("audio/mpeg");
}

/** Sumidero MSE: URL de objeto inmediata; los trozos se añaden en orden; cuota llena → espera a que el navegador libere lo ya reproducido. */
export function createMseSink({ createURL = (ms: MediaSource) => URL.createObjectURL(ms), revokeURL = (u: string) => URL.revokeObjectURL(u), quotaRetries = 120, quotaWaitMs = 500 } = {}): StreamSink & { url: string; close(): void } {
  const ms = new MediaSource(); const url = createURL(ms);
  let sb: SourceBuffer | null = null; let closed = false; let pendingDuration: number | null = null;
  const opened = new Promise<void>((resolve) => ms.addEventListener("sourceopen", () => resolve(), { once: true }));
  const ready = opened.then(() => { if (closed) throw aborted(); sb = ms.addSourceBuffer("audio/mpeg"); if (pendingDuration) { try { ms.duration = pendingDuration; } catch { /* ignorar */ } } return sb; });
  const idle = (b: SourceBuffer) => (b.updating ? new Promise<void>((r) => b.addEventListener("updateend", () => r(), { once: true })) : Promise.resolve());
  async function appendOnce(b: SourceBuffer, bytes: Uint8Array) {
    await idle(b);
    await new Promise<void>((resolve, reject) => {
      const done = () => { b.removeEventListener("error", err); resolve(); };
      const err = () => { b.removeEventListener("updateend", done); reject(new Error("SourceBuffer append error")); };
      b.addEventListener("updateend", done, { once: true }); b.addEventListener("error", err, { once: true });
      try { b.appendBuffer(bytes as unknown as BufferSource); } catch (e) { b.removeEventListener("updateend", done); b.removeEventListener("error", err); reject(e); }
    });
  }
  return {
    url,
    setDuration(seconds: number) { if (sb && ms.readyState === "open" && !sb.updating) { try { ms.duration = seconds; } catch { /* ignorar */ } } else pendingDuration = seconds; },
    async append(bytes: Uint8Array) {
      const b = await ready;
      for (let attempt = 0; ; attempt++) {
        if (closed || ms.readyState !== "open") throw aborted();
        try { await appendOnce(b, bytes); return; } catch (e) {
          if ((e as { name?: string }).name !== "QuotaExceededError" || attempt >= quotaRetries) throw e;
          await new Promise((r) => setTimeout(r, quotaWaitMs)); // el algoritmo de expulsión de MSE libera lo reproducido en el siguiente append
        }
      }
    },
    async end() { const b = await ready; await idle(b); if (ms.readyState === "open") ms.endOfStream(); },
    fail() { try { if (ms.readyState === "open") ms.endOfStream("decode"); } catch { /* ignorar */ } },
    close() { closed = true; try { if (ms.readyState === "open") ms.endOfStream(); } catch { /* ignorar */ } revokeURL(url); },
  };
}
