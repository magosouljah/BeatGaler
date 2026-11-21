// E70 — Direct B (Web): núcleo puro del envío directo navegador → Telegram y de la clasificación de fallos.
// Se ejecuta DENTRO del Worker de datos existente (mtcute 0.31.0, identidad de bot con clave temporal) pero no importa mtcute: recibe el
// cliente y los constructores, de modo que las reglas (identidad de envío, orden subida→envío, clasificación fail-closed) se prueban con dobles.
//
// Reglas (espejo de CONTRATO C7.3–C7.8 y del ERROR_TABLE de cloud-server/catalog/transport-gateway.js):
//  - la subida del archivo (`uploadFile`) NO crea mensajes: cualquier fallo allí es «sin efecto» (UPLOAD_FAILED, reintentable);
//  - el envío (`sendMedia`) lleva el `randomId` y el caption que fijó el servidor en el ticket (persistidos ANTES del efecto);
//  - un error RPC explícito en el envío es la respuesta a esa petición (sin efecto): FLOOD/SLOWMODE/…→ REJECTED; permisos → PERMANENT;
//    clave/sesión revocada → REVOKED; TODO lo demás (red, timeout, respuesta sin id, error desconocido) → UNCERTAIN: el efecto pudo ocurrir y
//    NUNCA se reenvía por iniciativa del cliente (RESEND_POLICY.uncertain = BLOCKED; reconcilia el servidor).

export type DirectFailureKind = "REJECTED" | "UPLOAD_FAILED" | "PERMANENT" | "REVOKED" | "UNCERTAIN";
export interface DirectFailure { kind: DirectFailureKind; code: string; retryAfterMs: number }
export class DirectSendError extends Error {
  constructor(readonly failure: DirectFailure, message?: string) {
    super(message ?? `${failure.kind}: ${failure.code}`);
    this.name = "DirectSendError";
  }
}

const REJECTED_RE = /^(FLOOD_WAIT_(\d+)|SLOWMODE_WAIT_(\d+)|FILE_REFERENCE_EXPIRED|FILE_PART_\d+_MISSING|FILE_PARTS_INVALID|FILE_PART_INVALID|FILE_PART_SIZE_INVALID|MEDIA_EMPTY|[A-Z_]+_MIGRATE_\d+)$/;
const PERMANENT_RE = /^(CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|CHAT_SEND_MEDIA_FORBIDDEN|CHAT_RESTRICTED|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|CHAT_ID_INVALID|INPUT_USER_DEACTIVATED|MESSAGE_TOO_LONG|MEDIA_INVALID|DOCUMENT_INVALID|MEDIA_CAPTION_TOO_LONG|TOPIC_CLOSED|TOPIC_DELETED|MSG_ID_INVALID|MESSAGE_ID_INVALID)$/;
const REVOKED_RE = /^(AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_PERM_EMPTY|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|USER_DEACTIVATED_BAN|API_ID_INVALID|ACTIVE_USER_REQUIRED|BOT_INVALID|TEMP_AUTH_KEY_EMPTY)$/;
const DEFAULT_WAIT_MS = 5_000;

function rpcText(error: unknown): string {
  const e = error as { text?: unknown; errorMessage?: unknown; code?: unknown; message?: unknown } | null;
  for (const candidate of [e?.text, e?.errorMessage, e?.message]) if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return "";
}

/** `stage`: en `upload` ningún fallo tiene efecto; en `send` solo un error RPC explícito prueba la ausencia de efecto. */
export function classifyDirectError(error: unknown, stage: "upload" | "send"): DirectFailure {
  const text = rpcText(error);
  const token = /[A-Z][A-Z0-9_]{3,}/.exec(text)?.[0] ?? "";
  if (REVOKED_RE.test(token)) return { kind: "REVOKED", code: token, retryAfterMs: 0 };
  if (stage === "upload") {
    if (PERMANENT_RE.test(token)) return { kind: "PERMANENT", code: token, retryAfterMs: 0 };
    const wait = /^FLOOD_WAIT_(\d+)$/.exec(token);
    return { kind: "UPLOAD_FAILED", code: token || "UPLOAD_ERROR", retryAfterMs: wait ? Math.max(1_000, Number(wait[1]) * 1_000) : DEFAULT_WAIT_MS };
  }
  const rejected = REJECTED_RE.exec(token);
  if (rejected) {
    const seconds = Number(rejected[2] ?? rejected[3] ?? 0);
    return { kind: "REJECTED", code: token, retryAfterMs: seconds > 0 ? Math.max(1_000, seconds * 1_000) : DEFAULT_WAIT_MS };
  }
  if (PERMANENT_RE.test(token)) return { kind: "PERMANENT", code: token, retryAfterMs: 0 };
  // RANDOM_ID_DUPLICATE significa que ya existe un efecto con esta identidad: conciliar, no reenviar.
  return { kind: "UNCERTAIN", code: token || "UNKNOWN", retryAfterMs: 60_000 };
}

export interface DirectSendInput {
  file: Blob;
  filename: string;
  mime: string;
  caption: string;
  /** int64 con signo, en texto decimal, fijado por el servidor. */
  randomId: string;
  size: number;
}
export interface DirectSendReceipt { messageId: number; documentId: string | null; size: number }

export interface DirectSendDeps {
  client: {
    uploadFile(params: { file: Blob; fileName: string; fileSize: number; fileMime: string; progressCallback?: (uploaded: number, total: number) => void }): Promise<unknown>;
    sendMedia(chatId: number, media: unknown, params: { silent: boolean; randomId: unknown; progressCallback?: (uploaded: number, total: number) => void }): Promise<unknown>;
  };
  /** Construye InputMedia.document(uploaded, …) con el SDK real (inyectado). */
  makeMedia(uploaded: unknown, options: { fileName: string; fileMime: string; fileSize: number; caption: string }): unknown;
  /** Texto decimal → Long con signo (SDK real). */
  toLong(decimal: string): unknown;
  chatId: number;
  onProgress?(uploadedBytes: number, totalBytes: number): void;
  /** E78: subida por partes reanudable para archivos grandes (≥ RESUMABLE_MIN_BYTES). Sin ella, todo va por `uploadFile`. */
  resumable?: ResumableUploadDeps & {
    /** Progreso conservado entre intentos del MISMO envío (misma identidad random_id): un reintento continúa, no empieza de cero. */
    load(randomId: string): ResumableUploadState | null;
    save(randomId: string, state: ResumableUploadState | null): void;
    /** InputFile del SDK para un archivo ya subido por partes. */
    makeInputFile(state: ResumableUploadState, fileName: string): unknown;
  };
}

// ---------- E78: subida por partes reanudable ----------
// Evidencia de proveedor (E77, sandbox real): Telegram acepta partes de un mismo archivo subidas con claves de autorización distintas del mismo
// bot y permite publicarlo con otra clave. Por eso una renovación de la clave temporal (que sustituye el cliente MTProto del Worker) no obliga a
// empezar de cero: se conserva la identidad del archivo (file_id) y las partes confirmadas, se repite solo la parte en curso y se continúa.
// Subir partes nunca crea mensajes: cualquier fallo aquí es SIN efecto. El archivo se lee por trozos (jamás entero en memoria).
export const RESUMABLE_MIN_BYTES = 10 * 1024 * 1024; // por debajo, la subida simple termina en segundos
export const UPLOAD_PART_BYTES = 512 * 1024;
export const UPLOAD_MAX_PARTS = 4000; // límite del proveedor (≈ 2000 MiB con partes de 512 KiB; el tope de PROJECT del plan es 1,9 GB)
export interface ResumableUploadState { fileId: unknown; size: number; partBytes: number; totalParts: number; done: Set<number> }
export interface ResumableUploadDeps {
  /** Sube UNA parte con el cliente vigente en ese momento (tras una renovación de clave es otro cliente). */
  savePart(args: { fileId: unknown; index: number; totalParts: number; bytes: Uint8Array }): Promise<void>;
  /** Espera a que vuelva a haber cliente listo (renovación de clave en curso). Rechaza si no vuelve en plazo. */
  waitReady(): Promise<void>;
  newFileId(): unknown;
  sleep?(ms: number): Promise<void>;
  concurrency?: number;
  maxAttemptsPerPart?: number;
}
export async function uploadResumable(deps: ResumableUploadDeps, file: Blob, previous: ResumableUploadState | null, onProgress?: (uploadedBytes: number, totalBytes: number) => void): Promise<ResumableUploadState> {
  const totalParts = Math.ceil(file.size / UPLOAD_PART_BYTES);
  if (file.size <= 0 || totalParts > UPLOAD_MAX_PARTS) throw new DirectSendError({ kind: "PERMANENT", code: "FILE_TOO_LARGE", retryAfterMs: 0 });
  // El progreso anterior solo vale para el mismo archivo (mismo tamaño y troceado); si no, identidad nueva.
  const state: ResumableUploadState = previous && previous.size === file.size && previous.partBytes === UPLOAD_PART_BYTES && previous.totalParts === totalParts
    ? previous : { fileId: deps.newFileId(), size: file.size, partBytes: UPLOAD_PART_BYTES, totalParts, done: new Set<number>() };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const maxAttempts = deps.maxAttemptsPerPart ?? 6;
  const uploadedBytes = () => Math.min(file.size, state.done.size * UPLOAD_PART_BYTES);
  onProgress?.(uploadedBytes(), file.size);
  let next = 0; let failure: unknown = null;
  const take = (): number | null => { while (next < totalParts && state.done.has(next)) next++; return next < totalParts ? next++ : null; };
  async function worker(): Promise<void> {
    for (let index = take(); index !== null && failure === null; index = take()) {
      const bytes = new Uint8Array(await file.slice(index * UPLOAD_PART_BYTES, Math.min(file.size, (index + 1) * UPLOAD_PART_BYTES)).arrayBuffer());
      for (let attempt = 1; failure === null; attempt++) {
        try { await deps.savePart({ fileId: state.fileId, index, totalParts, bytes }); state.done.add(index); onProgress?.(uploadedBytes(), file.size); break; } catch (error) {
          const c = classifyDirectError(error, "upload");
          if (c.kind === "PERMANENT" || c.kind === "REVOKED" || attempt >= maxAttempts) { failure = error; return; }
          // Rechazo temporal, corte de red o sustitución del cliente: se espera a que haya cliente listo y se REPITE la misma parte (idempotente).
          await sleep(Math.min(5_000, c.retryAfterMs > 0 && c.kind === "REJECTED" ? c.retryAfterMs : 300 * attempt));
          try { await deps.waitReady(); } catch (notReady) { failure = notReady; return; }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(deps.concurrency ?? 3, totalParts)) }, () => worker()));
  if (failure !== null) throw failure; // el progreso queda en `state` (el llamador lo conserva para el siguiente intento)
  return state;
}

const RANDOM_ID_RE = /^-?(0|[1-9][0-9]{0,18})$/;

export async function runDirectSend(deps: DirectSendDeps, input: DirectSendInput): Promise<DirectSendReceipt> {
  if (!RANDOM_ID_RE.test(input.randomId)) throw new DirectSendError({ kind: "PERMANENT", code: "RANDOM_ID_INVALID", retryAfterMs: 0 });
  if (!input.file || input.file.size !== input.size || input.size <= 0) throw new DirectSendError({ kind: "PERMANENT", code: "FILE_SIZE_MISMATCH", retryAfterMs: 0 });
  // Marcador de una parte de operación o del MAIN de prefijos (E75); ambos los fija el servidor en su ticket.
  if (!/^catalog:v1 (op=[A-Za-z0-9_-]{1,80} part=[A-Za-z0-9._:-]{1,64}|pack=pk-[A-Za-z0-9_-]{8,60})$/.test(input.caption)) throw new DirectSendError({ kind: "PERMANENT", code: "CAPTION_INVALID", retryAfterMs: 0 });
  const progress = (uploaded: number, total: number) => deps.onProgress?.(Math.min(input.size, Math.round(uploaded)), total || input.size);
  let uploaded: unknown;
  const resumable = input.size >= RESUMABLE_MIN_BYTES ? deps.resumable : undefined;
  let state: ResumableUploadState | null = resumable ? resumable.load(input.randomId) : null;
  try {
    if (resumable) {
      const keep = state ?? { fileId: resumable.newFileId(), size: input.size, partBytes: UPLOAD_PART_BYTES, totalParts: Math.ceil(input.size / UPLOAD_PART_BYTES), done: new Set<number>() };
      resumable.save(input.randomId, keep); // se guarda ANTES de subir: un fallo a mitad conserva lo confirmado
      state = await uploadResumable(resumable, input.file, keep, progress);
      await resumable.waitReady(); // el envío final usa el cliente vigente (pudo renovarse la clave durante la subida)
      uploaded = resumable.makeInputFile(state, input.filename);
    } else uploaded = await deps.client.uploadFile({ file: input.file, fileName: input.filename, fileSize: input.size, fileMime: input.mime, progressCallback: progress });
  } catch (error) {
    if (error instanceof DirectSendError) throw error;
    throw new DirectSendError(classifyDirectError(error, "upload"), `upload: ${rpcText(error) || "failed"}`);
  }
  const media = deps.makeMedia(uploaded, { fileName: input.filename, fileMime: input.mime, fileSize: input.size, caption: input.caption });
  let message: unknown;
  try {
    message = await deps.client.sendMedia(deps.chatId, media, { silent: true, randomId: deps.toLong(input.randomId) });
  } catch (error) {
    throw new DirectSendError(classifyDirectError(error, "send"), `send: ${rpcText(error) || "failed"}`);
  }
  const m = message as { id?: unknown; media?: { fileSize?: unknown; raw?: { id?: { toString(): string } } } } | null;
  const messageId = Number(m?.id);
  // Sin id de mensaje no se sabe si el efecto ocurrió: incierto.
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new DirectSendError({ kind: "UNCERTAIN", code: "NO_MESSAGE_ID", retryAfterMs: 60_000 });
  resumable?.save(input.randomId, null); // enviado: el progreso ya no hace falta
  const reported = Number(m?.media?.fileSize);
  const docId = m?.media?.raw?.id ? String(m.media.raw.id.toString()) : null;
  return { messageId, documentId: docId && /^-?[0-9]{1,20}$/.test(docId) ? docId : null, size: Number.isSafeInteger(reported) && reported > 0 ? reported : input.size };
}
