import { InputMedia, MemoryStorage, SessionConnection, TelegramClient, WebCryptoProvider, type FileDownloadLocation } from "@mtcute/web";
import mtcuteWasmUrl from "@mtcute/wasm/mtcute.wasm?url";
import { playTrace } from "../playback/playTrace";
import {
  WEB_DIRECT_MAX_FILE_BYTES,
  type WebTransportDownloadInput,
  type WebTransportDownloadResult,
  type WebTransportDeleteMessagesInput,
  type WebTransportDeleteMessagesResult,
  type WebTransportLibraryIndexResult,
  type WebTransportReplaceIndexInput,
  type WebTransportReplaceIndexResult,
  type WebTransportStreamInput,
  type WebTransportStreamResult,
  type WebTransportUploadResult,
  type WebTransportWorkerCommand,
  type WebTransportWorkerResponse,
} from "./webTransportWorkerProtocol";

type WorkerScope = {
  onmessage: ((event: MessageEvent<WebTransportWorkerCommand>) => void) | null;
  postMessage(message: WebTransportWorkerResponse, transfer?: Transferable[]): void;
};

type BoundTempLongJson = { low: number; high: number; unsigned: boolean };
type BoundTempSessionState = {
  seqNo: number;
  lastMessageId: BoundTempLongJson;
  timeOffset: number;
  serverSalt: BoundTempLongJson;
  queuedAcks: BoundTempLongJson[];
  bindMsgId: BoundTempLongJson;
  lastSessionCreatedUid: BoundTempLongJson;
};
type BoundTempSession = {
  initConnectionCalled: boolean;
  _sessionId?: any;
  _seqNo?: number;
  _lastMessageId?: any;
  _timeOffset?: number;
  _salts?: { currentSalt?: any };
  queuedAcks?: any[];
  recentOutgoingMsgIds?: { add(value: any): unknown };
  recentIncomingMsgIds?: { add(value: any): unknown };
  lastSessionCreatedUid?: any;
};
type BoundTempConnection = {
  params?: { isMainConnection?: boolean; isMainDcConnection?: boolean; dc?: { id?: number } };
  _session?: BoundTempSession;
  _salts?: { currentSalt?: any };
};
type BoundTempPool = { _connections?: BoundTempConnection[] };
type BoundTempDcManager = { main?: BoundTempPool };
type BoundTempNetwork = { _dcConnections?: Map<number, BoundTempDcManager> };

const scope = globalThis as unknown as WorkerScope;
let client: TelegramClient | null = null;
let chatId = 0;
let vaultVerified = false;
const activeStreams = new Map<string, {
  controller: AbortController;
  acknowledge: (() => void) | null;
}>();

const LIBRARY_INDEX_CAPTION = "BEATGALER_LIBRARY_INDEX_V1";

function isBoundTempLongJson(value: unknown): value is BoundTempLongJson {
  const row = value as Partial<BoundTempLongJson> | null;
  return Boolean(
    row &&
    Number.isInteger(row.low) &&
    Number.isInteger(row.high) &&
    typeof row.unsigned === "boolean"
  );
}

function isBoundTempSessionState(value: unknown): value is BoundTempSessionState {
  const row = value as Partial<BoundTempSessionState> | null;
  return Boolean(
    row &&
    Number.isInteger(row.seqNo) && Number(row.seqNo) >= 0 &&
    Number.isFinite(row.timeOffset) &&
    isBoundTempLongJson(row.lastMessageId) &&
    isBoundTempLongJson(row.serverSalt) &&
    Array.isArray(row.queuedAcks) && row.queuedAcks.every(isBoundTempLongJson) &&
    isBoundTempLongJson(row.bindMsgId) &&
    isBoundTempLongJson(row.lastSessionCreatedUid)
  );
}

function restoreLong(LongCtor: any, value: BoundTempLongJson): any {
  return new LongCtor(value.low, value.high, value.unsigned);
}

function applyBoundTempSessionState(
  connection: BoundTempConnection | undefined,
  sessionId: BoundTempLongJson,
  state: BoundTempSessionState,
): void {
  const session = connection?._session;
  const LongCtor = session?._sessionId?.constructor;
  if (!connection || !session || typeof LongCtor !== "function") {
    throw new Error("Galer Cloud Web transport could not restore its temporary session.");
  }

  session._sessionId = restoreLong(LongCtor, sessionId);
  session._seqNo = state.seqNo;
  session._lastMessageId = restoreLong(LongCtor, state.lastMessageId);
  session._timeOffset = state.timeOffset;
  const salts = connection._salts || session._salts;
  if (!salts) throw new Error("Galer Cloud Web transport could not restore its temporary server salt.");
  salts.currentSalt = restoreLong(LongCtor, state.serverSalt);
  session.queuedAcks = state.queuedAcks.map(value => restoreLong(LongCtor, value));
  session.recentOutgoingMsgIds?.add(restoreLong(LongCtor, state.bindMsgId));
  for (const value of state.queuedAcks) {
    session.recentIncomingMsgIds?.add(restoreLong(LongCtor, value));
  }
  session.lastSessionCreatedUid = restoreLong(LongCtor, state.lastSessionCreatedUid);

  // Telegram requires initConnection again after auth.bindTempAuthKey. The
  // browser receives only the numeric application id needed by initConnection;
  // API hash, bot token and permanent authorization never enter this Worker.
  session.initConnectionCalled = false;
}

function installBoundTempConnectHook(
  sessionId: BoundTempLongJson,
  state: BoundTempSessionState,
  dcId: number,
): () => void {
  const prototype = SessionConnection.prototype as any;
  const originalConnect = prototype.connect;
  if (typeof originalConnect !== "function") {
    throw new Error("Galer Cloud Web transport could not prepare its temporary session.");
  }
  const wrappedConnect = function (this: BoundTempConnection, ...args: any[]) {
    if (
      this?.params?.isMainConnection === true &&
      this?.params?.isMainDcConnection === true &&
      Number(this?.params?.dc?.id || 0) === dcId
    ) {
      applyBoundTempSessionState(this, sessionId, state);
    }
    return originalConnect.apply(this, args);
  };
  prototype.connect = wrappedConnect;
  return () => {
    if (prototype.connect === wrappedConnect) prototype.connect = originalConnect;
  };
}

function assertBoundTempPrimarySession(
  next: TelegramClient,
  sessionId: BoundTempLongJson,
  dcId: number,
): void {
  const base = (next as any)._client || next;
  const network = base?.mt?.network as BoundTempNetwork | undefined;
  const connection = network?._dcConnections?.get(dcId)?.main?._connections?.[0];
  const current = connection?._session?._sessionId;
  if (
    !current ||
    current.low !== sessionId.low ||
    current.high !== sessionId.high ||
    Boolean(current.unsigned) !== sessionId.unsigned
  ) {
    throw new Error("Galer Cloud Web transport did not retain the bound temporary session.");
  }
}

async function closeClient(): Promise<void> {
  for (const stream of activeStreams.values()) {
    stream.controller.abort();
    stream.acknowledge?.();
  }
  activeStreams.clear();
  const current = client;
  client = null;
  vaultVerified = false;
  chatId = 0;
  if (current) await current.destroy().catch(() => {});
}

async function initialize(command: Extract<WebTransportWorkerCommand, { op: "initialize" }>): Promise<void> {
  const started = Date.now();
  playTrace("WORKER_INITIALIZE_BEGIN");
  await closeClient();
  const {
    chat_id,
    expected_bot_id,
    temp_api_id,
    temp_auth_key,
    temp_session_id,
    temp_session_state,
    temp_primary_dcs,
  } = command.session;
  const primaryDcId = Number((temp_primary_dcs as any)?.main?.id || 0);
  if (
    !chat_id ||
    !expected_bot_id ||
    !Number.isInteger(temp_api_id) || temp_api_id <= 0 ||
    !(temp_auth_key instanceof Uint8Array) ||
    temp_auth_key.byteLength !== 256 ||
    !isBoundTempLongJson(temp_session_id) ||
    !isBoundTempSessionState(temp_session_state) ||
    !Number.isInteger(primaryDcId) ||
    primaryDcId < 1 ||
    primaryDcId > 5 ||
    !temp_primary_dcs
  ) {
    throw new Error("Galer Cloud returned incomplete temporary transport authorization.");
  }

  const next = new TelegramClient({
    // initConnection needs the public numeric application id. The API hash is
    // needed for authorization/login only and intentionally never enters Web.
    apiId: temp_api_id,
    apiHash: "",
    storage: new MemoryStorage(),
    crypto: new WebCryptoProvider({ wasmInput: mtcuteWasmUrl }),
    disableUpdates: true,
  });
  try {
    await next.importSession({
      primaryDcs: temp_primary_dcs as any,
      self: {
        userId: Number(expected_bot_id),
        isBot: true,
        isPremium: false,
        usernames: [],
      } as any,
      authKey: temp_auth_key.slice(),
    }, true);

    // The bind happened on a short-lived SessionConnection in the main thread.
    // Continue that exact MTProto Session in the primary Worker connection by
    // restoring its protocol state before the socket opens. Do not monkeypatch
    // resetState: a genuine reset must create a new id rather than destroy and
    // then immediately reuse the old bound id.
    const restoreConnect = installBoundTempConnectHook(temp_session_id, temp_session_state, primaryDcId);
    try {
      await next.connect();
    } finally {
      restoreConnect();
    }
    assertBoundTempPrimarySession(next, temp_session_id, primaryDcId);

    const self = await next.getMe();
    if (!self?.isBot || String(self.id) !== String(expected_bot_id)) {
      throw new Error("Temporary authorization resolved to the wrong transport identity.");
    }
  } catch (error) {
    await next.destroy().catch(() => {});
    throw error;
  } finally {
    // Worker owns a structured-cloned copy. mtcute has imported it into MemoryStorage.
    temp_auth_key.fill(0);
  }
  const numericChatId = Number(chat_id);
  if (!Number.isSafeInteger(numericChatId) || numericChatId === 0) {
    await next.destroy().catch(() => {});
    throw new Error("Galer Cloud returned an invalid vault identifier.");
  }
  client = next;
  chatId = numericChatId;
  playTrace("WORKER_INITIALIZE_DONE", { elapsed_ms: Date.now() - started });
}

async function verifyReady(): Promise<void> {
  if (!client || !chatId) throw new Error("Galer Cloud Web transport is not initialized.");
  const started = Date.now();
  playTrace("WORKER_VERIFY_BEGIN");
  await client.getChat(chatId);
  vaultVerified = true;
  playTrace("WORKER_VERIFY_DONE", { elapsed_ms: Date.now() - started });
}

function requireReady(): TelegramClient {
  if (!client || !vaultVerified || !chatId) throw new Error("Galer Cloud Web transport is not ready.");
  return client;
}

function downloadableMedia(message: Awaited<ReturnType<TelegramClient["getMessages"]>>[number]): FileDownloadLocation {
  const media = message?.media;
  if (!media || !["document", "audio", "video", "voice", "photo", "sticker"].includes(media.type)) {
    throw new Error("Galer Cloud stored object is not downloadable.");
  }
  return media as FileDownloadLocation;
}

async function getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {
  const started = Date.now();
  playTrace("WORKER_GET_INDEX_BEGIN");
  const active = requireReady();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fullChat = await active.getFullChat(chatId);
      playTrace("WORKER_GET_INDEX_FULL_CHAT", { attempt: attempt + 1 });
      const pinnedId = Number(fullChat.pinnedMsgId || 0);
      if (!Number.isInteger(pinnedId) || pinnedId <= 0) {
        throw new Error("Galer Cloud library index is still synchronizing.");
      }
      const [message] = await active.getMessages(chatId, [pinnedId]);
      playTrace("WORKER_GET_INDEX_MESSAGE", { attempt: attempt + 1 });
      if (!message || !message.text.startsWith(LIBRARY_INDEX_CAPTION)) {
        throw new Error("Galer Cloud library index is not available.");
      }
      const bytes = await active.downloadAsBuffer(downloadableMedia(message), { stallTimeout: 20_000 });
      playTrace("WORKER_GET_INDEX_BYTES", { attempt: attempt + 1, bytes: bytes.byteLength });
      if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) {
        throw new Error("Galer Cloud library index has an invalid size.");
      }
      playTrace("WORKER_GET_INDEX_DONE", { attempt: attempt + 1, elapsed_ms: Date.now() - started });
      return { manifest: JSON.parse(new TextDecoder().decode(bytes)), messageId: pinnedId };
    } catch (error) {
      playTrace("WORKER_GET_INDEX_RETRY", { attempt: attempt + 1, error_name: error instanceof Error ? error.name : "unknown" });
      lastError = error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, Math.min(1000, 80 * (2 ** attempt))));
    }
  }
  throw lastError || new Error("Galer Cloud library index could not be read.");
}

function libraryIdentityIds(manifest: unknown): Set<string> {
  const root = manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? manifest as Record<string, unknown>
    : {};
  const ids = new Set<string>();
  for (const value of Array.isArray(root.beats) ? root.beats : []) {
    const id = String((value as Record<string, unknown>)?.id || "").trim();
    if (id) ids.add(id);
  }
  for (const value of Array.isArray(root.trash) ? root.trash : []) {
    const row = value as Record<string, unknown>;
    const beat = row?.beat && typeof row.beat === "object" ? row.beat as Record<string, unknown> : row;
    const id = String(beat?.id || "").trim();
    if (id) ids.add(id);
  }
  for (const value of Array.isArray(root.deleted) ? root.deleted : []) {
    const row = value as Record<string, unknown>;
    const id = String(row?.beat_id || row?.id || "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

async function replaceLibraryIndex(input: WebTransportReplaceIndexInput): Promise<WebTransportReplaceIndexResult> {
  const active = requireReady();
  const root = input.manifest && typeof input.manifest === "object" && !Array.isArray(input.manifest)
    ? input.manifest as Record<string, unknown>
    : null;
  if (!root || root.schema !== "beatgaler.telegram.library" || Number(root.version) !== 2) {
    throw new Error("Galer Cloud refused an invalid library update.");
  }
  const current = await getLibraryIndex();
  if (current.messageId !== input.expectedMessageId) {
    throw new Error("Your library changed on another device. Retry Save to use the latest version.");
  }
  const candidateIds = libraryIdentityIds(root);
  const missing = Array.from(libraryIdentityIds(current.manifest)).filter(id => !candidateIds.has(id));
  if (missing.length > 0) throw new Error("Galer Cloud blocked a stale library update.");
  const bytes = new TextEncoder().encode(JSON.stringify(root));
  if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) {
    throw new Error("Galer Cloud library update has an invalid size.");
  }
  const file = new File([bytes], `beatgaler-library-${Date.now()}.json`, { type: "application/json" });
  const sent = await active.sendMedia(chatId, InputMedia.document(file, {
    fileName: file.name,
    fileMime: file.type,
    fileSize: file.size,
    caption: LIBRARY_INDEX_CAPTION,
  }), { silent: true });
  const messageId = Number(sent?.id || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud returned incomplete library information.");
  try {
    await active.pinMessage({ chatId, message: messageId, notify: false });
    let pinned = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const full = await active.getFullChat(chatId);
      if (Number(full.pinnedMsgId || 0) === messageId) { pinned = true; break; }
      await new Promise(resolve => setTimeout(resolve, 80 * (attempt + 1)));
    }
    if (!pinned) throw new Error("Galer Cloud could not verify the library update.");
  } catch (error) {
    await active.deleteMessagesById(chatId, [messageId]).catch(() => {});
    throw error;
  }
  if (current.messageId && current.messageId !== messageId) {
    await active.deleteMessagesById(chatId, [current.messageId]).catch(() => {});
  }
  return {
    messageId,
    previousMessageId: current.messageId,
    beatCount: Array.isArray(root.beats) ? root.beats.length : 0,
  };
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && new TextDecoder().decode(bytes.subarray(0, 6)).startsWith("GIF8")) return "image/gif";
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return "image/png";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

async function download(input: WebTransportDownloadInput): Promise<WebTransportDownloadResult> {
  const active = requireReady();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud object reference is invalid.");
  const [message] = await active.getMessages(chatId, [messageId]);
  if (!message) throw new Error("Galer Cloud object no longer exists.");
  const bytes = await active.downloadAsBuffer(downloadableMedia(message), { stallTimeout: 20_000 });
  if (bytes.byteLength <= 0) throw new Error("Galer Cloud returned an empty object.");
  const declaredMime = String(input.mimeType || "").trim().toLowerCase();
  const mimeType = /^image\/(?:png|jpe?g|gif|webp|bmp|avif)$/.test(declaredMime) ? declaredMime : sniffImageMime(bytes);
  return { messageId, dataUrl: `data:${mimeType};base64,${bytesToBase64(bytes)}` };
}

async function deleteMessages(input: WebTransportDeleteMessagesInput): Promise<WebTransportDeleteMessagesResult> {
  const active = requireReady();
  const ids = Array.from(new Set(input.messageIds.map(Number).filter(id => Number.isInteger(id) && id > 0)));
  let deleted = 0;
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    await active.deleteMessagesById(chatId, batch);
    deleted += batch.length;
  }
  return { deleted };
}

function downloadMime(value: unknown): string {
  const mime = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mime) ? mime : "application/octet-stream";
}

async function stream(requestId: string, input: WebTransportStreamInput): Promise<WebTransportStreamResult> {
  const started = Date.now();
  playTrace("WORKER_STREAM_BEGIN");
  const active = requireReady();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud object reference is invalid.");
  const [message] = await active.getMessages(chatId, [messageId]);
  playTrace("WORKER_STREAM_MESSAGE_READY", { elapsed_ms: Date.now() - started });
  if (!message) throw new Error("Galer Cloud object no longer exists.");
  const media = downloadableMedia(message);
  const totalBytes = Math.max(0, Number((media as { fileSize?: number }).fileSize || 0));
  const mimeType = downloadMime(input.mimeType || (media as { mimeType?: string }).mimeType);
  const controller = new AbortController();
  const state = { controller, acknowledge: null as (() => void) | null };
  activeStreams.set(requestId, state);
  let downloadedBytes = 0;
  let firstChunkLogged = false;
  try {
    for await (const chunk of active.downloadAsIterable(media, { abortSignal: controller.signal, stallTimeout: 20_000, partSize: 256 })) {
      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");
      downloadedBytes += chunk.byteLength;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        playTrace("WORKER_STREAM_FIRST_CHUNK", { elapsed_ms: Date.now() - started, bytes: chunk.byteLength });
      }
      const transferable = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      scope.postMessage({ requestId, event: "download-chunk", chunk: transferable, downloadedBytes, totalBytes: totalBytes || downloadedBytes }, [transferable]);
      await new Promise<void>(resolve => { state.acknowledge = resolve; });
      state.acknowledge = null;
      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");
    }
    if (downloadedBytes <= 0) throw new Error("Galer Cloud returned an empty object.");
    playTrace("WORKER_STREAM_DONE", { elapsed_ms: Date.now() - started, bytes: downloadedBytes });
    return { messageId, totalBytes: totalBytes || downloadedBytes, mimeType };
  } finally {
    activeStreams.delete(requestId);
  }
}

function cancelStream(targetRequestId: string): { cancelled: boolean } {
  const stream = activeStreams.get(String(targetRequestId || ""));
  stream?.controller.abort();
  stream?.acknowledge?.();
  return { cancelled: Boolean(stream) };
}

function acknowledgeStream(targetRequestId: string): { acknowledged: boolean } {
  const stream = activeStreams.get(String(targetRequestId || ""));
  stream?.acknowledge?.();
  return { acknowledged: Boolean(stream) };
}

function validateFile(file: File): void {
  if (!(file instanceof File) || file.size <= 0) throw new Error("Upload source is missing or empty.");
  if (file.size > WEB_DIRECT_MAX_FILE_BYTES) throw new Error("This file exceeds the 1.9 GB Galer Cloud Web limit.");
}

async function upload(requestId: string, input: Extract<WebTransportWorkerCommand, { op: "upload" }>["input"]): Promise<WebTransportUploadResult> {
  const active = requireReady();
  validateFile(input.file);
  const message = await active.sendMedia(chatId, InputMedia.document(input.file, {
    fileName: input.filename,
    fileMime: input.file.type || "application/octet-stream",
    fileSize: input.file.size,
    caption: `BEATGALER_MEDIA_V1 kind=${input.kind} beat=${input.beatId}`,
  }), {
    silent: true,
    replyTo: input.threadId,
    threadId: input.threadId,
    progressCallback: uploadedBytes => scope.postMessage({
      requestId,
      event: "progress",
      progress: { uploadedBytes: Math.min(input.file.size, Math.round(uploadedBytes)), totalBytes: input.file.size },
    }),
  });
  const messageId = Number(message?.id || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud returned incomplete uploaded file information.");
  const stored = { telegram_file_id: `direct:${messageId}`, telegram_message_id: messageId, index: 0, size: input.file.size, filename: input.filename };
  return {
    telegram_file_id: stored.telegram_file_id,
    telegram_message_id: messageId,
    filename: input.filename,
    original_size: input.file.size,
    parts: [stored],
    transport: "direct-web",
  };
}

async function handle(command: WebTransportWorkerCommand): Promise<unknown> {
  switch (command.op) {
    case "initialize": await initialize(command); return { ready: true };
    case "verify": await verifyReady(); return { verified: true };
    case "get_index": return getLibraryIndex();
    case "replace_index": return replaceLibraryIndex(command.input);
    case "delete_messages": return deleteMessages(command.input);
    case "download": return download(command.input);
    case "stream": return stream(command.requestId, command.input);
    case "stream_ack": return acknowledgeStream(command.targetRequestId);
    case "cancel": return cancelStream(command.targetRequestId);
    case "upload": return upload(command.requestId, command.input);
    case "shutdown": await closeClient(); return { closed: true };
  }
}

scope.onmessage = event => {
  const command = event.data;
  void handle(command).then(
    result => scope.postMessage({ requestId: command.requestId, ok: true, result }),
    error => scope.postMessage({ requestId: command.requestId, ok: false, error: String((error as any)?.message || error) }),
  );
};
