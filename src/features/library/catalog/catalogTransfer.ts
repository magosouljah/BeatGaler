// T12 — Cliente de transferencias por capacidad (NATIVO r2.1 §8.6; CONTRATO C7; api-manifest v5 `delivered` T12).
// El navegador nunca recibe chat, message_id, random_id ni credenciales: pide una capacidad opaca por parte y sube los bytes al gateway
// con PUT en streaming. Reglas fail-closed del cliente:
//  - rechazo sin efecto (503 SEND_REJECTED / UPLOAD_FAILED / TRANSFER_BUSY) → esperar Retry-After y pedir OTRA capacidad para la MISMA
//    parte (el servidor conserva la identidad random_id); número de intentos acotado;
//  - 202 UNCERTAIN o 409 PART_UNCERTAIN → nunca reenviar: la reconciliación la hace el worker; el cliente solo observa la operación;
//  - 409 PART_BYTES_MISMATCH → el archivo reseleccionado no es el declarado: se pide reselección (C7.9), sin efecto en el proveedor;
//  - 403 (capacidad inválida/expirada, permanente, cerco) → error visible; no se improvisa otra identidad.
// Los hashes declarados se calculan en streaming (SHA-256 incremental, sin cargar el archivo completo en memoria).
import { CatalogApiError } from "./catalogApi";
import { catalogHttpError, createCatalogHttp, readCatalogJson } from "./catalogHttp";
import { DirectSendError, type DirectFailure } from "./catalogDirectCore";
import { DIRECT_UNAVAILABLE_MESSAGE, DIRECT_WAIT, DirectUnavailableError, type DirectPort } from "./catalogDirectTypes";

export type TransferKind = "IMPORT" | "REPLACE";
export type TransferRole = "MASTER" | "WAV" | "ARTWORK" | "PROJECT" | "SAMPLES" | "STEMS" | "LOOP";
export interface TransferPartSpec {
  partKey: string;
  slotKey: string;
  role: TransferRole;
  partIndex: number;
  size: number;
  sha256: string | null;
  filename?: string | null;
  mime?: string | null;
}
export interface TransferIntent {
  kind: TransferKind;
  parts: TransferPartSpec[];
  metadata?: Record<string, unknown> | null;
  beatId?: string;
  expectedVersion?: string;
}
export type TransferOperationStatus = "PREPARED" | "TRANSFERRING" | "VERIFYING" | "READY" | "COMMITTED" | "RECONCILE" | "CONFLICT" | "CANCELED" | "FAILED" | "BLOCKED";
export interface TransferPartDto { partKey: string; slotKey: string; role: string; partIndex: number; dispatchState: "PENDING" | "DISPATCHED" | "RECEIPT" | "VERIFIED" | "FAILED"; verified: boolean; attempts: number }
export interface TransferOperationDto {
  operationId: string;
  kind: TransferKind;
  status: TransferOperationStatus;
  beatId: string;
  parts: TransferPartDto[];
  progress: { total: number; verified: number; receipts: number };
  reservation: { state: string; expiresAt: string } | null;
  result: { beatId: string; version: string; revision: string } | null;
  lastError: string | null;
  replay?: boolean;
  created?: boolean;
  upload?: UploadOutcome;
}
// El navegador envió a Telegram; el recibo es un candidato (nivel CLIENT) que el worker verifica con el proveedor.
export type UploadOutcome = { state: "RECEIPT"; partKey: string; attempt: number; level: "CLIENT"; verification: "PENDING_PROVIDER" };
/** Ticket de envío directo (E70): identidad persistida por el servidor ANTES del efecto. */
export interface SendTicket { operationId: string; partKey: string; attempt: number; randomId: string; caption: string; chatId: string; botId: string; filename: string | null; mime: string; size: number; declaredSha256: string | null; level: "CLIENT" }
export type UploadPartResult = { state: "RECEIPT"; attempt: number; operation: TransferOperationDto } | { state: "UNCERTAIN"; attempt: number; operation: TransferOperationDto | null };
export type CommitResult = { status: "COMMITTED"; operation: TransferOperationDto } | { status: "CONFLICT" | "BLOCKED" | "CANCELED" | "FAILED" | "RECONCILE"; operation: TransferOperationDto; error: CatalogApiError | null } | { status: "TIMEOUT"; operation: TransferOperationDto | null };

export interface CatalogTransferOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: () => string;
  token?: () => string | null;
  csrf?: () => string | null;
  /** Cabeceras C5 de la biblioteca (era/época del contexto resuelto). */
  headers: () => { era: string; epoch: string };
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Intentos máximos por parte ante rechazos sin efecto (cada uno pide un ticket nuevo con la misma identidad). */
  maxSendAttempts?: number;
  pollIntervalMs?: number;
  maxPollMs?: number;
  idempotencyKey?: () => string;
  /** Direct B: puerto navegador ↔ Telegram. E77: único transporte de archivos; sin él (o sin sesión) la subida falla con DIRECT_UNAVAILABLE. */
  direct?: DirectPort | null;
}

const INFLIGHT: ReadonlySet<string> = new Set(["PREPARED", "TRANSFERRING", "VERIFYING", "READY"]);
export const TRANSFER_DEFAULTS = Object.freeze({ timeoutMs: 20_000, maxSendAttempts: 5, pollIntervalMs: 1500, maxPollMs: 10 * 60_000, hashChunkBytes: 4 * 1024 * 1024 });

// ---------- SHA-256 incremental (FIPS 180-4) ----------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly w = new Uint32Array(64);
  private readonly buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;
  private done = false;

  update(bytes: Uint8Array): this {
    if (this.done) throw new Error("Sha256 already finalized");
    let off = 0;
    this.total += bytes.length;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, bytes.length);
      this.buf.set(bytes.subarray(0, take), this.bufLen);
      this.bufLen += take; off = take;
      if (this.bufLen === 64) { this.block(this.buf, 0); this.bufLen = 0; }
    }
    for (; off + 64 <= bytes.length; off += 64) this.block(bytes, off);
    if (off < bytes.length) { this.buf.set(bytes.subarray(off), 0); this.bufLen = bytes.length - off; }
    return this;
  }
  digestHex(): string {
    if (this.done) throw new Error("Sha256 already finalized");
    this.done = true;
    const bitLen = this.total * 8;
    const pad = new Uint8Array(this.bufLen < 56 ? 64 : 128);
    pad.set(this.buf.subarray(0, this.bufLen), 0);
    pad[this.bufLen] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bitLen / 0x100000000), false);
    view.setUint32(pad.length - 4, bitLen >>> 0, false);
    for (let off = 0; off < pad.length; off += 64) this.block(pad, off);
    let out = "";
    for (let i = 0; i < 8; i++) out += this.h[i].toString(16).padStart(8, "0");
    return out;
  }
  private block(bytes: Uint8Array, off: number): void {
    const w = this.w; const h = this.h;
    for (let i = 0; i < 16; i++) w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]; const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
}
// Lectura de un trozo de Blob: Blob.arrayBuffer() en navegadores modernos; FileReader como respaldo (entornos sin arrayBuffer, p. ej. jsdom).
function readBlob(part: Blob): Promise<ArrayBuffer> {
  if (typeof part.arrayBuffer === "function") return part.arrayBuffer();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Blob read failed"));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(part);
  });
}
/** SHA-256 hex de un Blob o bytes, leyendo por trozos (memoria acotada por chunkBytes). */
export async function sha256Hex(data: Blob | Uint8Array, chunkBytes = TRANSFER_DEFAULTS.hashChunkBytes): Promise<string> {
  const h = new Sha256();
  // Detección estructural (no instanceof): en entornos con varios realms (jsdom/vitest) Uint8Array y Blob pueden no compartir constructor.
  const blob = data as Blob;
  const isBlob = typeof blob.size === "number" && typeof blob.slice === "function";
  if (!isBlob) return h.update(data as Uint8Array).digestHex();
  for (let off = 0; off < blob.size; off += chunkBytes) h.update(new Uint8Array(await readBlob(blob.slice(off, Math.min(blob.size, off + chunkBytes)))));
  return h.digestHex();
}
/** Especificación de parte a partir de un archivo del navegador: tamaño y hash declarados por el cliente (nunca autorizan nada; C7.4). */
export async function describePart(blob: Blob, spec: { partKey: string; slotKey: string; role: TransferRole; partIndex?: number; filename?: string | null; mime?: string | null }): Promise<TransferPartSpec> {
  return { partKey: spec.partKey, slotKey: spec.slotKey, role: spec.role, partIndex: spec.partIndex ?? 0, size: blob.size, sha256: await sha256Hex(blob), filename: spec.filename ?? null, mime: spec.mime ?? (blob.type || null) };
}

const retryAfterMs = (error: CatalogApiError, header: string | null): number => {
  const fromDetail = Number(error.detail.retry_after_ms);
  if (Number.isFinite(fromDetail) && fromDetail > 0) return fromDetail;
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader * 1000;
  return 5000;
};
const defaultKey = (): string => (globalThis.crypto && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function createCatalogTransfer(options: CatalogTransferOptions) {
  const http = createCatalogHttp(options, TRANSFER_DEFAULTS.timeoutMs);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxSendAttempts = options.maxSendAttempts ?? TRANSFER_DEFAULTS.maxSendAttempts;
  const pollIntervalMs = options.pollIntervalMs ?? TRANSFER_DEFAULTS.pollIntervalMs;
  const maxPollMs = options.maxPollMs ?? TRANSFER_DEFAULTS.maxPollMs;
  const newKey = options.idempotencyKey ?? defaultKey;

  interface Reply<T> { status: number; body: T; headers: Headers }
  // Política: toda escritura lleva CSRF y era/época; Content-Type si hay cuerpo; cabeceras propias del comando (Idempotency-Key…).
  // Un 429/503 con Retry-After lo expone como detail.retry_after_ms (salvo que el servidor ya lo envíe) y la respuesta conserva cabeceras.
  async function request<T>(method: "GET" | "POST" | "PUT", path: string, { body, signal, extraHeaders = {} }: { body?: unknown; signal?: AbortSignal; extraHeaders?: Record<string, string> } = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (method !== "GET") {
      const c = http.csrf();
      if (c) headers["X-BeatGaler-CSRF"] = c;
      const h = options.headers();
      headers["X-Catalog-Era"] = h.era; headers["X-Catalog-Epoch"] = h.epoch;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await http.send(method, path, { headers, body, signal });
    const payload = await readCatalogJson(response);
    if (!response.ok) {
      const detail = { ...((payload.detail as Record<string, unknown>) ?? {}) };
      const ra = response.headers.get("retry-after");
      if (ra && detail.retry_after_ms === undefined) detail.retry_after_ms = Number(ra) * 1000;
      throw catalogHttpError(response, payload, detail);
    }
    return { status: response.status, body: payload as T, headers: response.headers };
  }

  async function createOperation(intent: TransferIntent, { idempotencyKey = newKey(), signal }: { idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<TransferOperationDto> {
    return (await request<TransferOperationDto>("POST", "/catalog/v1/operations", { body: intent, signal, extraHeaders: { "Idempotency-Key": idempotencyKey } })).body;
  }
  async function getOperation(operationId: string, signal?: AbortSignal): Promise<TransferOperationDto> {
    return (await request<TransferOperationDto>("GET", `/catalog/v1/operations/${encodeURIComponent(operationId)}`, { signal })).body;
  }
  /**
   * E70 — envío directo de una parte: ticket (identidad persistida y despacho ANTES del efecto) → envío del navegador a Telegram → recibo.
   *  - Fallo sin efecto (rechazo, flood, subida) → se informa y se pide otro ticket con la MISMA identidad (random_id), tras la espera.
   *  - Incierto (respuesta perdida, error desconocido, Worker perdido) → se informa y NO se reenvía: reconcilia el servidor (C7.8).
   *  - PERMANENT/REVOKED → error visible. El recibo es un candidato; el commit exige la verificación del proveedor.
   */
  async function uploadPartDirect(direct: DirectPort, { operationId, partKey, blob, signal, onProgress }: { operationId: string; partKey: string; blob: Blob; signal?: AbortSignal; onProgress?: (uploadedBytes: number) => void }): Promise<UploadPartResult> {
    const base = `/catalog/v1/operations/${encodeURIComponent(operationId)}/parts/${encodeURIComponent(partKey)}`;
    const uncertain = async (attempt: number): Promise<UploadPartResult> => ({ state: "UNCERTAIN", attempt, operation: await getOperation(operationId, signal).catch(() => null) });
    let lastError: CatalogApiError | null = null;
    for (let attempt = 1; attempt <= maxSendAttempts; attempt++) {
      let ticket: SendTicket;
      try { ticket = (await request<SendTicket>("POST", `${base}/send-ticket`, { signal })).body; } catch (error) {
        if (error instanceof CatalogApiError && error.code === "PART_UNCERTAIN") return uncertain(attempt);
        throw error;
      }
      const report = async (outcome: DirectFailure["kind"], code: string, retryMs: number): Promise<boolean> => {
        try { await request("POST", `${base}/send-report`, { body: { attempt: ticket.attempt, outcome, code, retryAfterMs: retryMs || null } }); return true; } catch { return false; }
      };
      if (Number(ticket.size) !== blob.size) {
        await report("UPLOAD_FAILED", "BYTES_MISMATCH", 0);
        throw new CatalogApiError(409, "PART_BYTES_MISMATCH", "El archivo seleccionado no coincide con el tamaño declarado; vuelve a seleccionar el mismo archivo.", { declared: ticket.size, received: blob.size });
      }
      let sent;
      try {
        if (signal?.aborted) throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
        // E80: el avance son los bytes que el transporte Direct B confirma haber enviado (eventos del propio envío, sin estimaciones).
        sent = await direct.send({ blob, filename: ticket.filename || partKey, mime: ticket.mime, caption: ticket.caption, randomId: ticket.randomId, chatId: ticket.chatId, size: blob.size }, { signal, onProgress: onProgress ? (uploaded) => onProgress(Math.max(0, Math.min(blob.size, uploaded))) : undefined });
      } catch (error) {
        // Sin efecto posible: sesión no disponible o cancelación ANTES del envío. Todo lo demás desconocido es incierto (fail-closed).
        const failure: DirectFailure = error instanceof DirectSendError ? error.failure
          : error instanceof DirectUnavailableError || (error as { name?: string } | null)?.name === "AbortError" ? { kind: "UPLOAD_FAILED", code: error instanceof DirectUnavailableError ? "DIRECT_UNAVAILABLE" : "ABORTED", retryAfterMs: 5_000 }
          : { kind: "UNCERTAIN", code: "UNKNOWN", retryAfterMs: 60_000 };
        const reported = await report(failure.kind, failure.code, failure.retryAfterMs);
        if (!reported || failure.kind === "UNCERTAIN") return uncertain(ticket.attempt);
        if (signal?.aborted) throw error;
        if (failure.kind === "PERMANENT") throw new CatalogApiError(403, "SEND_REJECTED_PERMANENT", "Telegram rechazó el envío de forma permanente.", { rpc: failure.code, partKey });
        if (failure.kind === "REVOKED") throw new CatalogApiError(503, "CREDENTIAL_REVOKED", "La sesión directa fue revocada; vuelve a intentarlo.", { rpc: failure.code, partKey });
        lastError = new CatalogApiError(503, failure.kind === "UPLOAD_FAILED" ? "UPLOAD_FAILED" : "SEND_REJECTED", `Envío rechazado sin efecto (${failure.code}).`, { retry_after_ms: failure.retryAfterMs, same_identity: true, rpc: failure.code });
        if (attempt < maxSendAttempts) await sleep(failure.retryAfterMs || 5_000);
        continue;
      }
      // Recibo candidato: se reintenta ante fallos de red (idempotente por hash); si no se logra persistir, el servidor lo conciliará.
      const receipt = { messageId: sent.messageId, documentId: sent.documentId, size: sent.size, senderId: sent.senderId, chatId: sent.chatId };
      for (let tries = 1; ; tries++) {
        try {
          const r = await request<TransferOperationDto>("PUT", `${base}/direct-receipt`, { body: { attempt: ticket.attempt, receipt }, signal });
          return { state: "RECEIPT", attempt: ticket.attempt, operation: r.body };
        } catch (error) {
          if (error instanceof CatalogApiError && !(error.status >= 500)) throw error; // RECEIPT_CONFLICT, OPERATION_TRANSITION_INVALID…: visible
          if (tries >= 3) return uncertain(ticket.attempt);
          await sleep(Math.min(5_000, 500 * 2 ** tries));
        }
      }
    }
    throw lastError ?? new CatalogApiError(503, "SEND_REJECTED", "La transferencia no pudo completarse tras varios intentos.", {});
  }

  /**
   * Sube una parte (MASTER, WAV, portada o PROJECT): SIEMPRE navegador → Telegram por Direct B; el Cloud nunca recibe bytes (E77).
   * La disponibilidad se decide UNA vez y antes de cualquier efecto: sin sesión directa en un plazo razonable → error claro y nada enviado.
   */
  async function uploadPart({ operationId, partKey, blob, signal, onProgress }: { operationId: string; partKey: string; blob: Blob; signal?: AbortSignal; /** E80: bytes de ESTA parte ya enviados por Direct B. */ onProgress?: (uploadedBytes: number) => void }): Promise<UploadPartResult> {
    const direct = options.direct ?? null;
    const available = direct ? await direct.ready(signal, { maxWaitMs: DIRECT_WAIT.sendMs }).catch((error) => { if (signal?.aborted) throw error; return false; }) : false;
    if (!direct || !available) throw new CatalogApiError(503, "DIRECT_UNAVAILABLE", DIRECT_UNAVAILABLE_MESSAGE, { reason: direct ? "SESSION_NOT_READY" : "NO_DIRECT", partKey });
    return uploadPartDirect(direct, { operationId, partKey, blob, signal, onProgress });
  }

  /** Commit idempotente: 200 → COMMITTED; 202 → observar hasta un estado terminal o agotar el tiempo (sin reenviar nada). */
  async function commit(operationId: string, { signal }: { signal?: AbortSignal } = {}): Promise<CommitResult> {
    const started = Date.now();
    const terminal = (op: TransferOperationDto, error: CatalogApiError | null): CommitResult | null => {
      if (op.status === "COMMITTED") return { status: "COMMITTED", operation: op };
      if (!INFLIGHT.has(op.status)) return { status: op.status as "CONFLICT" | "BLOCKED" | "CANCELED" | "FAILED" | "RECONCILE", operation: op, error };
      return null;
    };
    let op: TransferOperationDto | null = null;
    try {
      const r = await request<TransferOperationDto>("POST", `/catalog/v1/operations/${encodeURIComponent(operationId)}/commit`, { signal });
      op = r.body;
      const t = terminal(op, null); if (t) return t;
    } catch (error) {
      if (!(error instanceof CatalogApiError) || !["VERSION_CONFLICT", "OPERATION_TRANSITION_INVALID", "RESERVATION_EXPIRED", "RESERVATION_INVALID", "QUOTA_EXCEEDED", "NAME_TAKEN"].includes(error.code)) throw error;
      const current = await getOperation(operationId, signal);
      return terminal(current, error) ?? { status: current.status === "READY" ? "FAILED" : "RECONCILE", operation: current, error };
    }
    while (Date.now() - started < maxPollMs) {
      if (signal?.aborted) break;
      await sleep(pollIntervalMs);
      op = await getOperation(operationId, signal);
      const t = terminal(op, null); if (t) return t;
      if (op.status === "READY") {
        try { const r = await request<TransferOperationDto>("POST", `/catalog/v1/operations/${encodeURIComponent(operationId)}/commit`, { signal }); const t2 = terminal(r.body, null); if (t2) return t2; } catch (error) {
          if (!(error instanceof CatalogApiError)) throw error;
          const current = await getOperation(operationId, signal);
          const t3 = terminal(current, error); if (t3) return t3;
        }
      }
    }
    return { status: "TIMEOUT", operation: op };
  }
  async function cancel(operationId: string, signal?: AbortSignal): Promise<TransferOperationDto> {
    return (await request<TransferOperationDto>("POST", `/catalog/v1/operations/${encodeURIComponent(operationId)}/cancel`, { signal })).body;
  }
  async function renewReservation(operationId: string, signal?: AbortSignal): Promise<TransferOperationDto> {
    return (await request<TransferOperationDto>("POST", `/catalog/v1/operations/${encodeURIComponent(operationId)}/reservation/renew`, { signal })).body;
  }

  return Object.freeze({ createOperation, getOperation, uploadPart, commit, cancel, renewReservation });
}
export type CatalogTransfer = ReturnType<typeof createCatalogTransfer>;
