// E70 — Direct B (Web): puerto del plano de datos navegador ↔ Telegram para el catálogo PostgreSQL.
// El puerto es la ÚNICA costura entre el catálogo y el transporte Direct legacy (Worker mtcute + clave MTProto temporal): catalogTransfer
// (envío) y catalogMediaClient (lectura) solo conocen esta interfaz; las sesiones, recuperación, versiones y confirmaciones siguen en PostgreSQL.
// El navegador nunca recibe bot_token, api_hash ni la clave permanente: solo vincula una clave temporal propia (webTempAuth.ts, sin cambios).
import { Sha256 } from "./catalogTransfer";
import {
  DirectUnavailableError,
  type DirectPort,
  type DirectReadyOptions,
  isLate,
  settleWithin,
  type DirectReadOptions,
  type DirectReadRef,
  type DirectReadResult,
  type DirectSendRequest,
  type DirectSendResult,
} from "./catalogDirectTypes";
import { DirectSendError, RESUMABLE_MIN_BYTES, type DirectFailure } from "./catalogDirectCore";
import { WebTransportWorkerClient } from "../../cloud/webTransportWorkerClient";
import { getActiveWebAccountId } from "../../auth/activeWebAccount";
import { WebTransportController, type WebTransportControlApi, type WebTransportRuntime } from "../../cloud/webTransportController";
import {
  bindWebTransportSession,
  catalogDirectControlRequest,
  renewWebTransportSession,
  type WebTransportSession,
  type WebTransportSessionPublic,
} from "../../cloud/webTransportSession";
import { WEB_CATALOG_READ_MAX_BYTES, type WebTransportCatalogReadInput, type WebTransportCatalogReadResult, type WebTransportCatalogSendInput, type WebTransportCatalogSendResult } from "../../cloud/webTransportWorkerProtocol";

export const DIRECT_SESSION_PATH = "/catalog/v1/direct/session";
export const DIRECT_STOP_PATH = "/catalog/v1/direct/session/stop";

/** Runtime mínimo que necesita el puerto (WebTransportWorkerClient lo implementa; los tests inyectan un doble). */
export interface DirectRuntime extends WebTransportRuntime {
  catalogSend(input: WebTransportCatalogSendInput, onProgress?: (progress: { uploadedBytes: number; totalBytes: number }) => void): Promise<WebTransportCatalogSendResult>;
  catalogRead(input: WebTransportCatalogReadInput, requestId?: ReturnType<typeof crypto.randomUUID>): Promise<WebTransportCatalogReadResult>;
  cancelCatalogRead(targetRequestId: string): void;
}

export interface CatalogDirectPortOptions {
  /** Capacidad anunciada por /context (capabilities.direct) y entorno con Worker+WebSocket. */
  enabled: () => boolean;
  runtime?: () => DirectRuntime;
  api?: WebTransportControlApi;
  readyTimeoutMs?: number;
  /** Tras un fallo de sesión no se reintenta hasta pasado este tiempo (cada intento de login del bot cuenta contra Telegram). */
  retryAfterFailureMs?: number;
  now?: () => number;
  /** Solo laboratorio: antelación de la renovación de clave (por defecto 120 s). */
  renewMarginS?: number;
}
export const DIRECT_DEFAULTS = Object.freeze({ readyTimeoutMs: 25_000, retryAfterFailureMs: 60_000, readChunkAttempts: 4, renewMarginS: 120 });

/** API de control del catálogo: misma máquina de sesión/Worker del legacy, con rutas del catálogo y sin lease, INDEX ni activación. */
export function createCatalogControlApi({ busy, renewMarginS = DIRECT_DEFAULTS.renewMarginS }: { /** Hay un envío NO reanudable (archivo pequeño) en curso. */ busy?: () => boolean; /** Antelación de la renovación (el LAB la sube para forzar renovaciones durante una transferencia). */ renewMarginS?: number } = {}): WebTransportControlApi {
  const startPath = { startPath: DIRECT_SESSION_PATH };
  const unsupported = async (): Promise<never> => { throw new Error("Operation leases are not used by the catalog direct transport."); };
  return {
    reserve: () => catalogDirectControlRequest<WebTransportSessionPublic>(DIRECT_SESSION_PATH, {}),
    bind: (bootstrap) => bindWebTransportSession(bootstrap, startPath),
    // El bot ya es miembro del vault (es el mismo del gateway): no hay MASTER ni invitación; el Worker adquiere el peer por sí mismo.
    activate: async () => ({ activated: true as const, membership: null }),
    heartbeat: async (session: WebTransportSession) => {
      const renewBefore = session.temp_auth.expires_at - renewMarginS;
      // Renovar sustituye el cliente MTProto del Worker. E78: las transferencias largas lo SOPORTAN (subida por partes reanudable; lecturas
      // reanudables por trozo), así que la renovación ocurre a su hora. Solo se aplaza unos segundos mientras hay un envío pequeño (no reanudable).
      const needsRenewal = Math.floor(Date.now() / 1000) >= renewBefore && busy?.() !== true;
      return { expired: false, credentialRefresh: needsRenewal ? await renewWebTransportSession(session, startPath) : null };
    },
    authorize: unsupported,
    begin: unsupported,
    end: async () => {},
    stop: async () => { await catalogDirectControlRequest(DIRECT_STOP_PATH, {}).catch(() => {}); },
  };
}

const abortError = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

export function createCatalogDirectPort(options: CatalogDirectPortOptions): DirectPort {
  const readyTimeoutMs = options.readyTimeoutMs ?? DIRECT_DEFAULTS.readyTimeoutMs;
  const retryAfterFailureMs = options.retryAfterFailureMs ?? DIRECT_DEFAULTS.retryAfterFailureMs;
  const now = options.now ?? (() => Date.now());
  let runtime: DirectRuntime | null = null;
  let controller: WebTransportController | null = null;
  let session: WebTransportSession | null = null;
  let opening: Promise<boolean> | null = null;
  let failedAt = 0;
  let closed = false;
  let smallSends = 0; // envíos no reanudables en curso (los únicos que aplazan la renovación de la clave)

  function build(): { controller: WebTransportController; runtime: DirectRuntime } {
    if (!runtime || !controller) {
      const make = options.runtime;
      if (!make) throw new DirectUnavailableError("UNSUPPORTED", "no direct runtime configured");
      runtime = make();
      controller = new WebTransportController(runtime, options.api ?? createCatalogControlApi({ busy: () => smallSends > 0, renewMarginS: options.renewMarginS }), { startupMessageIds: [] });
    }
    return { controller, runtime };
  }

  async function open(): Promise<boolean> {
    const { controller: c } = build();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DirectUnavailableError("SESSION", "direct session timed out")), readyTimeoutMs); });
      session = await Promise.race([c.connect(), guard]);
      await Promise.race([c.waitForVaultPeerReady(), guard]);
      return true;
    } catch {
      failedAt = now();
      session = null;
      // La sesión a medias no se reutiliza: el siguiente intento (tras la espera) empieza limpio.
      await c.disconnect().catch(() => {});
      runtime = null; controller = null;
      return false;
    } finally { if (timer) clearTimeout(timer); }
  }

  async function ready(signal?: AbortSignal, readyOptions?: DirectReadyOptions): Promise<boolean> {
    if (closed || !options.enabled()) return false;
    if (signal?.aborted) throw abortError();
    if (session && controller) return true;
    if (failedAt && now() - failedAt < retryAfterFailureMs) return false;
    if (!opening) opening = open().finally(() => { opening = null; });
    if (readyOptions?.maxWaitMs == null) return opening;
    // Espera acotada: la apertura continúa en segundo plano; el llamador informa del error (nunca hay otro transporte).
    const settled = await settleWithin(opening, readyOptions.maxWaitMs);
    return isLate(settled) ? false : settled;
  }

  async function requireSession(): Promise<{ runtime: DirectRuntime; session: WebTransportSession }> {
    if (!(await ready())) throw new DirectUnavailableError("SESSION");
    if (!runtime || !session) throw new DirectUnavailableError("SESSION");
    return { runtime, session };
  }

  async function send(input: DirectSendRequest, opts: { signal?: AbortSignal; onProgress?: (uploadedBytes: number, totalBytes: number) => void } = {}): Promise<DirectSendResult> {
    const { runtime: r, session: s } = await requireSession();
    // El chat del ticket debe ser el del vault de la sesión: nunca se envía a otro destino por un valor del servidor mal formado.
    if (String(s.chat_id) !== String(input.chatId)) throw new DirectSendError({ kind: "PERMANENT", code: "CHAT_MISMATCH", retryAfterMs: 0 });
    if (opts.signal?.aborted) throw abortError();
    const small = input.size < RESUMABLE_MIN_BYTES; // los grandes suben por partes reanudables y no necesitan aplazar la renovación
    if (small) smallSends++;
    try {
      return await r.catalogSend({ file: input.blob, filename: input.filename, mime: input.mime, caption: input.caption, randomId: input.randomId, size: input.size },
        opts.onProgress ? (p) => opts.onProgress!(p.uploadedBytes, p.totalBytes) : undefined);
    } catch (error) {
      const failure = (error as { failure?: DirectFailure } | null)?.failure;
      if (failure) throw new DirectSendError(failure, error instanceof Error ? error.message : undefined);
      // El Worker murió o se perdió la respuesta: el efecto pudo ocurrir. Fail-closed.
      throw new DirectSendError({ kind: "UNCERTAIN", code: "WORKER_LOST", retryAfterMs: 60_000 }, error instanceof Error ? error.message : undefined);
    } finally { if (small) smallSends--; }
  }

  async function read(ref: DirectReadRef, opts: DirectReadOptions = {}): Promise<DirectReadResult> {
    const { runtime: r, session: s } = await requireSession();
    if (String(s.chat_id) !== String(ref.chatId)) throw new DirectUnavailableError("SESSION", "reference belongs to another chat");
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const length = opts.length == null ? ref.size - offset : Math.min(Math.floor(opts.length), ref.size - offset);
    if (length <= 0) return { blob: new Blob([]), sha256: null };
    const wantHash = opts.hash === true && offset === 0 && length === ref.size;
    const hasher = wantHash ? new Sha256() : null;
    // E77: el resultado se acumula como Blob encadenado (trozo a trozo), no como una lista de búferes: un archivo grande (PROJECT) no queda
    // entero en la memoria de JavaScript; el navegador puede respaldarlo en disco.
    let acc = new Blob([]); let got = 0;
    // El Worker exige desplazamientos alineados a 4 KiB: se pide desde el límite inferior y se recorta el inicio.
    let position = Math.floor(offset / 4096) * 4096; let skip = offset - position;
    const activeIds = new Set<string>();
    const onAbort = () => { for (const id of activeIds) r.cancelCatalogRead(id); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (got < length) {
        if (opts.signal?.aborted) throw abortError();
        const ask = Math.min(WEB_CATALOG_READ_MAX_BYTES, length - got + skip);
        const requestId = crypto.randomUUID(); activeIds.add(requestId);
        let result: WebTransportCatalogReadResult | null = null;
        // E78: un trozo que falla (corte de red o sustitución del cliente por renovación de clave) se REPITE tras esperar a que la sesión vuelva
        // a estar lista; la lectura continúa donde iba (nunca se vuelve a pedir lo ya recibido).
        for (let attempt = 1; result === null; attempt++) {
          try { result = await r.catalogRead({ messageId: ref.messageId, offset: position, length: ask }, requestId); } catch (error) {
            if (opts.signal?.aborted) { activeIds.delete(requestId); throw abortError(); }
            if (attempt >= DIRECT_DEFAULTS.readChunkAttempts || !controller) { activeIds.delete(requestId); throw error; }
            await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
            await controller.waitForVaultPeerReady().catch(() => {});
          }
        }
        activeIds.delete(requestId);
        const returned = result.buffer.byteLength;
        let bytes = new Uint8Array(result.buffer);
        if (skip) { bytes = bytes.subarray(Math.min(skip, bytes.length)); skip = 0; }
        if (bytes.length > length - got) bytes = bytes.subarray(0, length - got);
        if (!bytes.length) break;
        acc = new Blob([acc, bytes as BlobPart]); hasher?.update(bytes); got += bytes.length; position += returned; opts.onProgress?.(got, length);
        if (returned < ask) break; // el Worker devolvió menos de lo pedido (fin de objeto): lo que falte se detecta abajo como lectura corta
      }
    } finally { opts.signal?.removeEventListener("abort", onAbort); }
    if (got < length) throw new DirectUnavailableError("SESSION", `short read: ${got} of ${length} bytes`);
    return { blob: acc, sha256: hasher ? hasher.digestHex() : null };
  }

  async function close(): Promise<void> {
    closed = true;
    const c = controller; const r = runtime;
    controller = null; runtime = null; session = null; opening = null;
    await c?.disconnect().catch(() => {});
    await r?.shutdown().catch(() => {});
  }

  return Object.freeze({ ready, send, read, close });
}

export * from "./catalogDirectTypes";

let prewarmedRuntime: { owner: { accountId: string | null }; client: WebTransportWorkerClient } | null = null;

/** El Worker se crea sin sesión. El login completa la identidad cuando Cloud la confirma. */
export function prewarmDirectRuntime(owner: { accountId: string | null }): void {
  // Un nuevo intento puede retomar el Worker de un login fallido, sin reasignar una cuenta ya confirmada.
  if (prewarmedRuntime?.owner.accountId) return;
  const client = prewarmedRuntime?.client ?? new WebTransportWorkerClient();
  client.prewarm();
  prewarmedRuntime = { owner, client };
}

export async function discardPrewarmedDirectRuntime(): Promise<void> {
  const pending = prewarmedRuntime;
  prewarmedRuntime = null;
  await pending?.client.shutdown();
}

/** Puerto real del navegador: Worker mtcute existente + control de sesión del catálogo. Se carga de forma diferida (catalogDirectTypes.createLazyDirectPort). */
export function createWebDirectPort(): DirectPort {
  // Solo desarrollo (LAB): VITE_CATALOG_LAB_RENEW_MARGIN_S adelanta la renovación de la clave para ejercitar la reanudación con archivos pequeños.
  // (también `localStorage["bg:lab:renew-margin-s"]`, para que una sonda la fije solo en su propio perfil de navegador).
  const labStored = (() => { try { return localStorage.getItem("bg:lab:renew-margin-s"); } catch { return null; } })();
  const labMargin = import.meta.env.DEV ? Number(import.meta.env.VITE_CATALOG_LAB_RENEW_MARGIN_S ?? labStored) : NaN;
  return createCatalogDirectPort({
    enabled: () => true,
    runtime: () => {
      const pending = prewarmedRuntime;
      if (pending?.owner.accountId && pending.owner.accountId === getActiveWebAccountId()) {
        prewarmedRuntime = null;
        return pending.client as unknown as DirectRuntime;
      }
      void discardPrewarmedDirectRuntime().catch(() => {});
      return new WebTransportWorkerClient() as unknown as DirectRuntime;
    },
    ...(Number.isFinite(labMargin) && labMargin > 0 ? { renewMarginS: labMargin } : {}),
  });
}
