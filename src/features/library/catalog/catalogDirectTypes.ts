// E70 — Direct B (Web): tipos y fachada LIGERA del puerto navegador ↔ Telegram.
// Este módulo no importa mtcute, el Worker ni el control de sesión: catalogTransfer y catalogMediaClient solo lo conocen a él, de modo que la
// Gallery no paga ningún coste de arranque. La implementación real (catalogDirectPort.ts) se carga con `import()` en el primer uso.

export interface DirectSendRequest {
  blob: Blob;
  filename: string;
  mime: string;
  caption: string;
  randomId: string;
  chatId: string;
  size: number;
}
export interface DirectSendResult { messageId: number; documentId: string | null; size: number; senderId: string; chatId: string }
export interface DirectReadRef { chatId: string; messageId: number; size: number; mime?: string | null }
export interface DirectReadOptions { offset?: number; length?: number; hash?: boolean; signal?: AbortSignal; onProgress?: (loadedBytes: number, totalBytes: number) => void }
export interface DirectReadResult { blob: Blob; /** SHA-256 de los bytes REALMENTE recibidos (solo si se pidió y se leyó la parte completa). */ sha256: string | null }
export type DirectUnavailableReason = "UNSUPPORTED" | "SESSION" | "CLOSED";

export class DirectUnavailableError extends Error {
  constructor(readonly reason: DirectUnavailableReason, message?: string) { super(message ?? `direct transport unavailable (${reason})`); this.name = "DirectUnavailableError"; }
}

/**
 * Espera máxima a la sesión Direct ANTES de iniciar una operación. E77: Direct B es el ÚNICO transporte de archivos; si la sesión no está lista
 * en el plazo, la operación falla con un error claro (DIRECT_UNAVAILABLE) y sin efectos: nunca se usa el Cloud para mover bytes. La apertura
 * sigue en segundo plano y jamás se interrumpe una transferencia ya iniciada. Sin `maxWaitMs` espera la apertura completa.
 */
export interface DirectReadyOptions { maxWaitMs?: number }
export const DIRECT_WAIT = Object.freeze({ readMs: 15_000, sendMs: 30_000 });
export const DIRECT_UNAVAILABLE_MESSAGE = "No se pudo conectar con Telegram desde este navegador. Comprueba tu conexión e inténtalo de nuevo; no se ha transferido nada.";
const LATE = Symbol("late");
/** Resuelve con el valor de `p` o con LATE si pasa `ms`; no cancela `p`. */
export function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof LATE> {
  return new Promise<T | typeof LATE>((resolve, reject) => {
    const timer = setTimeout(() => resolve(LATE), Math.max(0, ms));
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
export const isLate = (v: unknown): v is typeof LATE => v === LATE;

export interface DirectPort {
  /** true si hay sesión Direct verificada para el vault; false → la operación no puede hacerse ahora (sin efectos externos previos). */
  ready(signal?: AbortSignal, options?: DirectReadyOptions): Promise<boolean>;
  send(input: DirectSendRequest, options?: { signal?: AbortSignal; onProgress?: (uploadedBytes: number, totalBytes: number) => void }): Promise<DirectSendResult>;
  read(ref: DirectReadRef, options?: DirectReadOptions): Promise<DirectReadResult>;
  close(): Promise<void>;
}

export function directEnvironmentSupported(): boolean {
  return typeof Worker === "function" && typeof WebSocket === "function" && typeof WebAssembly === "object";
}

/** Fachada que difiere la carga del transporte real hasta que haga falta (y solo si el servidor anuncia el plano directo). */
export function createLazyDirectPort({ enabled, load }: { enabled: () => boolean; load: () => Promise<DirectPort> }): DirectPort {
  let real: Promise<DirectPort> | null = null;
  const port = () => (real ??= load());
  // E73: una sola apertura compartida por todos los llamadores (preconexión, subida, lectura, prefijos). Tras una espera vencida, las siguientes
  // esperas acotadas no vuelven a pagar el plazo mientras esa misma apertura siga pendiente (p. ej. cada rango de un streaming).
  let inflight: Promise<boolean> | null = null; let missed = false;
  return Object.freeze({
    async ready(signal?: AbortSignal, options?: DirectReadyOptions) {
      if (!enabled() || !directEnvironmentSupported()) return false;
      if (signal?.aborted) throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
      if (!inflight) {
        const run: Promise<boolean> = (async () => { try { return await (await port()).ready(); } catch { real = null; return false; } })();
        inflight = run;
        void run.then(() => { if (inflight === run) { inflight = null; missed = false; } });
      }
      const pending = inflight;
      if (options?.maxWaitMs == null) return pending;
      if (missed) return false;
      const settled = await settleWithin(pending, options.maxWaitMs);
      if (isLate(settled)) { missed = true; return false; }
      return settled;
    },
    async send(input: DirectSendRequest, options?: { signal?: AbortSignal; onProgress?: (uploadedBytes: number, totalBytes: number) => void }) { return (await port()).send(input, options); },
    async read(ref: DirectReadRef, options?: DirectReadOptions) { return (await port()).read(ref, options); },
    async close() { const p = real; real = null; inflight = null; missed = false; if (p) await (await p).close().catch(() => {}); },
  });
}
