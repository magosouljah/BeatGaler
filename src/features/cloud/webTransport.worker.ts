import { InputMedia, MemoryStorage, SessionConnection, TelegramClient, WebCryptoProvider, type FileDownloadLocation } from "@mtcute/web";
import mtcuteWasmUrl from "@mtcute/wasm/mtcute.wasm?url";
import { measureMp3PlayablePrefix } from "../audio/mp3PlayablePrefix";
import { playTrace, playTraceSpan, observePlayStep } from "../playback/playTrace";
import {
  STARTUP_PREFIX_BYTES,
  WEB_DIRECT_MAX_FILE_BYTES,
  WEB_PLAYBACK_DATA_LANES,
  WEB_PLAYBACK_FIRST_CHUNK_BYTES,
  WEB_PLAYBACK_FIRST_CHUNK_KB,
  type WebTransportDownloadInput,
  type WebTransportDownloadResult,
  type WebTransportDeleteMessagesInput,
  type WebTransportDeleteMessagesResult,
  type WebTransportLibraryIndexResult,
  type WebTransportPrefetchBatchInput,
  type WebTransportPrefetchBatchItemResult,
  type WebTransportPrefetchBatchResult,
  type WebTransportPrefetchInput,
  type WebTransportPrefetchResult,
  type WebTransportReplaceIndexInput,
  type WebTransportReplaceIndexResult,
  type WebTransportStreamInput,
  type WebTransportStreamResult,
  type WebTransportUploadResult,
  type WebTransportWorkerCommand,
  type WebTransportWorkerResponse,
} from "./webTransportWorkerProtocol";

playTrace("WORKER_MODULE_READY");

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

type CachedPlaybackMedia = {
  media: FileDownloadLocation;
  totalBytes: number;
  mimeType: string | null;
};

type ResolvedPlaybackMedia = {
  media: FileDownloadLocation;
  totalBytes: number;
  sourceMime: string | null;
  cacheHit: boolean;
};

type PlaybackMediaBatchResolution = {
  resolved: Map<number, ResolvedPlaybackMedia>;
  missing: Map<number, Error>;
};

type PrefetchBatchControl = {
  cancelAll: boolean;
  cancelledMessageIds: Set<number>;
};

type BatchPrefetchState = {
  messageId: number;
  requestedMimeType: string | null;
  offsetBytes: number;
  media: FileDownloadLocation | null;
  totalBytes: number;
  mimeType: string;
  chunks: Uint8Array[];
  downloadedBytes: number;
  playableSeconds: number;
  targetMet: boolean;
  done: boolean;
  error: Error | null;
};

type DataLanePriority = "foreground" | "warm";

const scope = globalThis as unknown as WorkerScope;
let client: TelegramClient | null = null;
let chatId = 0;
let vaultVerified = false;
const activeStreams = new Map<string, {
  controller: AbortController;
  acknowledge: (() => void) | null;
}>();
const activePrefetchBatches = new Map<string, PrefetchBatchControl>();
const playbackMediaCache = new Map<number, CachedPlaybackMedia>();
const MAX_PLAYBACK_MEDIA_CACHE_ENTRIES = 256;
const LIBRARY_INDEX_CAPTION = "BEATGALER_LIBRARY_INDEX_V1";
const MAX_CONFIGURABLE_DATA_LANES = 16;
const STARTUP_MEDIA_BATCH_RETRY_DELAY_MS = 70;

let activeDataLanes = 0;
let dataLaneLimit = WEB_PLAYBACK_DATA_LANES;
const foregroundLaneWaiters: Array<() => void> = [];
const warmLaneWaiters: Array<() => void> = [];

function configureDataLaneLimit(value: unknown): number {
  const next = Math.max(1, Math.min(MAX_CONFIGURABLE_DATA_LANES, Math.trunc(Number(value) || WEB_PLAYBACK_DATA_LANES)));
  dataLaneLimit = next;
  return next;
}

function wakeNextDataLane(): void {
  const next = foregroundLaneWaiters.shift() || warmLaneWaiters.shift();
  next?.();
}

async function withDataLane<T>(operation: () => Promise<T>, priority: DataLanePriority = "foreground"): Promise<T> {
  if (activeDataLanes >= dataLaneLimit) {
    await new Promise<void>(resolve => {
      (priority === "foreground" ? foregroundLaneWaiters : warmLaneWaiters).push(resolve);
    });
  }
  activeDataLanes += 1;
  try {
    return await operation();
  } finally {
    activeDataLanes -= 1;
    wakeNextDataLane();
  }
}

function schedulerYield(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

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
  for (const value of state.queuedAcks) session.recentIncomingMsgIds?.add(restoreLong(LongCtor, value));
  session.lastSessionCreatedUid = restoreLong(LongCtor, state.lastSessionCreatedUid);
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
  for (const control of activePrefetchBatches.values()) control.cancelAll = true;
  activePrefetchBatches.clear();
  playbackMediaCache.clear();
  foregroundLaneWaiters.splice(0).forEach(resolve => resolve());
  warmLaneWaiters.splice(0).forEach(resolve => resolve());
  activeDataLanes = 0;
  dataLaneLimit = WEB_PLAYBACK_DATA_LANES;
  const current = client;
  client = null;
  vaultVerified = false;
  chatId = 0;
  if (current) await current.destroy().catch(() => {});
}

function downloadableMedia(message: Awaited<ReturnType<TelegramClient["getMessages"]>>[number]): FileDownloadLocation {
  const media = message?.media;
  if (!media || !["document", "audio", "video", "voice", "photo", "sticker"].includes(media.type)) {
    throw new Error("Galer Cloud stored object is not downloadable.");
  }
  return media as FileDownloadLocation;
}

function cachedPlaybackMedia(messageId: number): ResolvedPlaybackMedia | null {
  const cached = playbackMediaCache.get(messageId);
  if (!cached) return null;
  touchPlaybackMedia(messageId, cached);
  return { media: cached.media, totalBytes: cached.totalBytes, sourceMime: cached.mimeType, cacheHit: true };
}

function touchPlaybackMedia(messageId: number, value: CachedPlaybackMedia): void {
  playbackMediaCache.delete(messageId);
  playbackMediaCache.set(messageId, value);
  while (playbackMediaCache.size > MAX_PLAYBACK_MEDIA_CACHE_ENTRIES) {
    const oldest = playbackMediaCache.keys().next().value as number | undefined;
    if (oldest === undefined) break;
    playbackMediaCache.delete(oldest);
  }
}

function resolvedMediaFromMessage(
  message: Awaited<ReturnType<TelegramClient["getMessages"]>>[number],
): ResolvedPlaybackMedia {
  const media = downloadableMedia(message);
  const totalBytes = Math.max(0, Number((media as { fileSize?: number }).fileSize || 0));
  const sourceMime = String((media as { mimeType?: string }).mimeType || "").trim() || null;
  return { media, totalBytes, sourceMime, cacheHit: false };
}

function nonRetryableMediaResolutionError(error: unknown): boolean {
  const message = String((error as any)?.message || error || "");
  return /AUTH_KEY|SESSION_REVOKED|CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|PEER_ID_INVALID|FORBIDDEN|not a member|USER_DEACTIVATED/i.test(message);
}

async function getMessagesBatchWithRetry(
  active: TelegramClient,
  targetChatId: number,
  messageIds: number[],
): Promise<Awaited<ReturnType<TelegramClient["getMessages"]>>> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      playTrace("WORKER_PLAYBACK_MEDIA_BATCH_RPC", { count: messageIds.length, attempt });
      return await active.getMessages(targetChatId, messageIds);
    } catch (error) {
      lastError = error;
      playTrace("WORKER_PLAYBACK_MEDIA_BATCH_RETRY", {
        count: messageIds.length,
        attempt,
        error_name: error instanceof Error ? error.name : "unknown",
      });
      if (attempt >= 2 || nonRetryableMediaResolutionError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, STARTUP_MEDIA_BATCH_RETRY_DELAY_MS));
    }
  }
  throw lastError || new Error("Galer Cloud could not resolve playback media.");
}

async function resolvePlaybackMediaBatch(
  active: TelegramClient,
  targetChatId: number,
  rawMessageIds: readonly number[],
  publishCache = true,
): Promise<PlaybackMediaBatchResolution> {
  const messageIds = Array.from(new Set(rawMessageIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0)));
  const resolved = new Map<number, ResolvedPlaybackMedia>();
  const missing = new Map<number, Error>();
  const misses: number[] = [];

  for (const messageId of messageIds) {
    const cached = cachedPlaybackMedia(messageId);
    if (cached) {
      resolved.set(messageId, cached);
      playTrace("WORKER_PLAYBACK_MEDIA_CACHE_HIT", { message_id: messageId });
    } else {
      misses.push(messageId);
    }
  }
  if (misses.length === 0) return { resolved, missing };

  const messages = await getMessagesBatchWithRetry(active, targetChatId, misses);
  const byId = new Map<number, Awaited<ReturnType<TelegramClient["getMessages"]>>[number]>();
  for (const message of messages) {
    const id = Number(message?.id || 0);
    if (Number.isSafeInteger(id) && id > 0) byId.set(id, message);
  }

  for (const messageId of misses) {
    const message = byId.get(messageId);
    if (!message) {
      missing.set(messageId, new Error("Galer Cloud object no longer exists."));
      continue;
    }
    try {
      const value = resolvedMediaFromMessage(message);
      resolved.set(messageId, value);
      if (publishCache) {
        touchPlaybackMedia(messageId, {
          media: value.media,
          totalBytes: value.totalBytes,
          mimeType: value.sourceMime,
        });
      }
    } catch (error) {
      missing.set(messageId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return { resolved, missing };
}

async function resolvePlaybackMedia(
  active: TelegramClient,
  messageId: number,
): Promise<ResolvedPlaybackMedia> {
  const cached = cachedPlaybackMedia(messageId);
  if (cached) {
    playTrace("WORKER_PLAYBACK_MEDIA_CACHE_HIT", { message_id: messageId });
    return cached;
  }
  playTrace("WORKER_PLAYBACK_MEDIA_CACHE_MISS", { message_id: messageId });
  const batch = await resolvePlaybackMediaBatch(active, chatId, [messageId]);
  const resolved = batch.resolved.get(messageId);
  if (resolved) return resolved;
  throw batch.missing.get(messageId) || new Error("Galer Cloud object no longer exists.");
}

function startupRouteMessageIds(routes: Record<string, number> | undefined): number[] {
  return Array.from(new Set(Object.values(routes || {})
    .map(Number)
    .filter(id => Number.isSafeInteger(id) && id > 0)))
    .slice(0, 14);
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
    startup_routes,
  } = command.session;
  const primaryDcId = Number((temp_primary_dcs as any)?.main?.id || 0);
  const numericChatId = Number(chat_id);
  if (
    !chat_id ||
    !Number.isSafeInteger(numericChatId) || numericChatId === 0 ||
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

    const restoreConnect = installBoundTempConnectHook(temp_session_id, temp_session_state, primaryDcId);
    const endConnectTrace = playTraceSpan("WORKER_MTPROTO_CONNECT");
    try {
      await next.connect();
      endConnectTrace();
    } catch (error) {
      endConnectTrace("error");
      throw error;
    } finally {
      restoreConnect();
    }
    assertBoundTempPrimarySession(next, temp_session_id, primaryDcId);

    const startupMessageIds = startupRouteMessageIds(startup_routes);
    playTrace("WORKER_POST_CONNECT_PARALLEL_BEGIN", { startup_messages: startupMessageIds.length });
    const identityPromise = observePlayStep("WORKER_GET_ME", () => next.getMe());
    const startupMediaPromise = startupMessageIds.length > 0
      ? resolvePlaybackMediaBatch(next, numericChatId, startupMessageIds, false)
      : Promise.resolve<PlaybackMediaBatchResolution>({ resolved: new Map(), missing: new Map() });

    const [identityResult, mediaResult] = await Promise.allSettled([identityPromise, startupMediaPromise]);
    if (identityResult.status === "rejected") throw identityResult.reason;
    const self = identityResult.value;
    if (!self?.isBot || String(self.id) !== String(expected_bot_id)) {
      throw new Error("Temporary authorization resolved to the wrong transport identity.");
    }

    // Fail closed: media resolved in parallel is not published until getMe has
    // proven that the temporary key belongs to the expected transport bot.
    if (mediaResult.status === "fulfilled") {
      for (const [messageId, value] of mediaResult.value.resolved) {
        touchPlaybackMedia(messageId, {
          media: value.media,
          totalBytes: value.totalBytes,
          mimeType: value.sourceMime,
        });
      }
      playTrace("WORKER_STARTUP_MEDIA_BATCH_READY", {
        requested: startupMessageIds.length,
        resolved: mediaResult.value.resolved.size,
        missing: mediaResult.value.missing.size,
      });
    } else {
      // A media-resolution failure is not allowed to invalidate the Direct
      // identity/session; the warm request can retry the batch after verify.
      playTrace("WORKER_STARTUP_MEDIA_BATCH_DEFERRED", {
        requested: startupMessageIds.length,
        error_name: mediaResult.reason instanceof Error ? mediaResult.reason.name : "unknown",
      });
    }
  } catch (error) {
    await next.destroy().catch(() => {});
    throw error;
  } finally {
    temp_auth_key.fill(0);
  }

  client = next;
  chatId = numericChatId;
  playTrace("WORKER_INITIALIZE_DONE", { elapsed_ms: Date.now() - started });
}

async function verifyReady(): Promise<void> {
  if (!client || !chatId) throw new Error("Galer Cloud Web transport is not initialized.");
  const started = Date.now();
  playTrace("WORKER_VERIFY_BEGIN");
  // Deliberately retained until a real negative-membership probe demonstrates
  // that getMessages(vault,[knownMessage]) fails with an unambiguous no-access error.
  await client.getChat(chatId);
  vaultVerified = true;
  playTrace("WORKER_VERIFY_DONE", { elapsed_ms: Date.now() - started });
}

function requireReady(): TelegramClient {
  if (!client || !vaultVerified || !chatId) throw new Error("Galer Cloud Web transport is not ready.");
  return client;
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

async function prefetch(input: WebTransportPrefetchInput): Promise<WebTransportPrefetchResult> {
  const started = Date.now();
  playTrace("WORKER_PREFETCH_BEGIN", { message_id: input.messageId });
  const active = requireReady();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud object reference is invalid.");
  const resolved = await resolvePlaybackMedia(active, messageId);
  const offsetBytes = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));
  if (offsetBytes % 4096 !== 0) throw new Error("Galer Cloud playback offset must be aligned to 4 KiB.");
  const remaining = resolved.totalBytes > 0 ? Math.max(0, resolved.totalBytes - offsetBytes) : WEB_PLAYBACK_FIRST_CHUNK_BYTES;
  const limit = Math.min(WEB_PLAYBACK_FIRST_CHUNK_BYTES, remaining || WEB_PLAYBACK_FIRST_CHUNK_BYTES);
  const bytes = await withDataLane(() => active.downloadChunk({
    location: resolved.media,
    offset: offsetBytes,
    limit,
  }), "foreground");
  if (bytes.byteLength <= 0) throw new Error("Galer Cloud returned an empty playback prefix.");
  const prefix = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const mimeType = downloadMime(input.mimeType || resolved.sourceMime);
  const measurement = offsetBytes === 0 ? measureMp3PlayablePrefix(prefix) : null;
  playTrace("WORKER_PREFETCH_READY", {
    message_id: messageId,
    bytes: prefix.byteLength,
    elapsed_ms: Date.now() - started,
    media_cache_hit: resolved.cacheHit,
  });
  return {
    messageId,
    totalBytes: resolved.totalBytes || offsetBytes + prefix.byteLength,
    mimeType,
    prefix,
    playableSeconds: measurement?.playableSeconds || 0,
    targetMet: true,
  };
}

function normalizeBatchState(input: WebTransportPrefetchInput): BatchPrefetchState {
  const messageId = Number(input.messageId || 0);
  const offsetBytes = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));
  return {
    messageId,
    requestedMimeType: String(input.mimeType || "").trim() || null,
    offsetBytes,
    media: null,
    totalBytes: 0,
    mimeType: downloadMime(input.mimeType),
    chunks: [],
    downloadedBytes: 0,
    playableSeconds: 0,
    targetMet: false,
    done: false,
    error: null,
  };
}

async function resolveBatchStates(active: TelegramClient, states: BatchPrefetchState[]): Promise<void> {
  const valid: BatchPrefetchState[] = [];
  for (const state of states) {
    if (!Number.isInteger(state.messageId) || state.messageId <= 0) {
      state.error = new Error("Galer Cloud object reference is invalid.");
      state.done = true;
      continue;
    }
    if (state.offsetBytes % 4096 !== 0) {
      state.error = new Error("Galer Cloud playback offset must be aligned to 4 KiB.");
      state.done = true;
      continue;
    }
    valid.push(state);
  }
  if (valid.length === 0) return;

  let batch: PlaybackMediaBatchResolution;
  try {
    batch = await resolvePlaybackMediaBatch(active, chatId, valid.map(state => state.messageId));
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const state of valid) {
      state.error = failure;
      state.done = true;
    }
    return;
  }

  for (const state of valid) {
    const resolved = batch.resolved.get(state.messageId);
    if (!resolved) {
      state.error = batch.missing.get(state.messageId) || new Error("Galer Cloud object no longer exists.");
      state.done = true;
      continue;
    }
    state.media = resolved.media;
    state.totalBytes = resolved.totalBytes;
    state.mimeType = downloadMime(state.requestedMimeType || resolved.sourceMime);
    if (state.totalBytes > 0 && state.offsetBytes >= state.totalBytes) {
      state.done = true;
      state.targetMet = true;
    }
  }
}

async function downloadStartupPrefix(
  requestId: string,
  state: BatchPrefetchState,
): Promise<void> {
  if (state.done || state.error || !state.media) return;
  const absoluteOffset = state.offsetBytes;
  if (state.totalBytes > 0 && absoluteOffset >= state.totalBytes) {
    state.done = true;
    state.targetMet = true;
    return;
  }
  const remainingFile = state.totalBytes > 0 ? Math.max(0, state.totalBytes - absoluteOffset) : STARTUP_PREFIX_BYTES;
  const limit = Math.min(STARTUP_PREFIX_BYTES, remainingFile || STARTUP_PREFIX_BYTES);
  if (limit <= 0) {
    state.done = true;
    state.targetMet = true;
    return;
  }

  try {
    const active = requireReady();
    const bytes = await withDataLane(() => active.downloadChunk({
      location: state.media!,
      offset: absoluteOffset,
      limit,
    }), "warm");
    if (bytes.byteLength <= 0) throw new Error("Galer Cloud returned an empty playback prefix.");

    const stored = bytes.slice();
    state.chunks = [stored];
    state.downloadedBytes = stored.byteLength;
    state.targetMet = true;
    state.done = true;
    const downloadedAbsolute = absoluteOffset + stored.byteLength;
    const transferable = stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength) as ArrayBuffer;
    scope.postMessage({
      requestId,
      event: "prefetch-chunk",
      progress: {
        messageId: state.messageId,
        totalBytes: state.totalBytes || downloadedAbsolute,
        mimeType: state.mimeType,
        offsetBytes: absoluteOffset,
        chunk: transferable,
        downloadedBytes: downloadedAbsolute,
        playableSeconds: 0,
        targetMet: true,
      },
    }, [transferable]);
    playTrace("WORKER_PREFETCH_PREFIX_READY", {
      message_id: state.messageId,
      bytes: stored.byteLength,
      offset_bytes: absoluteOffset,
    });
  } catch (error) {
    state.error = error instanceof Error ? error : new Error(String(error));
    state.done = true;
  }
}

async function prefetchBatch(requestId: string, input: WebTransportPrefetchBatchInput): Promise<WebTransportPrefetchBatchResult> {
  const started = Date.now();
  const active = requireReady();
  const deduped = new Map<number, WebTransportPrefetchInput>();
  for (const candidate of Array.isArray(input.inputs) ? input.inputs : []) {
    const messageId = Number(candidate?.messageId || 0);
    if (!deduped.has(messageId)) deduped.set(messageId, candidate);
  }
  const states = Array.from(deduped.values(), normalizeBatchState);
  const maxConcurrency = configureDataLaneLimit(input.maxConcurrency);
  const control: PrefetchBatchControl = { cancelAll: false, cancelledMessageIds: new Set() };
  activePrefetchBatches.set(requestId, control);

  playTrace("WORKER_PREFETCH_BATCH_BEGIN", {
    count: states.length,
    prefix_bytes: STARTUP_PREFIX_BYTES,
    lanes: maxConcurrency,
  });

  try {
    // One real Telegram RPC resolves all uncached MASTER messages. A missing or
    // invalid individual message is recorded on only that state.
    await resolveBatchStates(active, states);

    const queue = states.filter(state => !state.done && !state.error);
    let cursor = 0;
    const laneLoop = async (lane: number) => {
      while (!control.cancelAll) {
        let state: BatchPrefetchState | undefined;
        while (cursor < queue.length && !state) {
          const candidate = queue[cursor++];
          if (!control.cancelledMessageIds.has(candidate.messageId)) state = candidate;
        }
        if (!state) return;
        playTrace("WORKER_PREFETCH_LANE_TAKE", { lane, message_id: state.messageId });
        await downloadStartupPrefix(requestId, state);
        await schedulerYield();
      }
    };

    const laneCount = Math.min(maxConcurrency, Math.max(1, queue.length));
    await Promise.all(Array.from({ length: laneCount }, (_, index) => laneLoop(index + 1)));

    const results: WebTransportPrefetchBatchItemResult[] = states.map(state => {
      if (state.error) {
        return { ok: false as const, messageId: state.messageId, error: state.error.message };
      }
      const prefixBytes = concatBytes(state.chunks);
      const prefix = prefixBytes.buffer.slice(prefixBytes.byteOffset, prefixBytes.byteOffset + prefixBytes.byteLength) as ArrayBuffer;
      return {
        ok: true as const,
        result: {
          messageId: state.messageId,
          totalBytes: state.totalBytes || state.offsetBytes + state.downloadedBytes,
          mimeType: state.mimeType,
          prefix,
          playableSeconds: 0,
          targetMet: state.targetMet,
        },
      };
    });
    playTrace("WORKER_PREFETCH_BATCH_DONE", {
      count: states.length,
      elapsed_ms: Date.now() - started,
      failures: results.filter(result => !result.ok).length,
    });
    return { results };
  } finally {
    activePrefetchBatches.delete(requestId);
  }
}

function cancelPrefetchBatch(targetRequestId: string, messageId?: number): { cancelled: boolean } {
  const control = activePrefetchBatches.get(String(targetRequestId || ""));
  if (!control) return { cancelled: false };
  if (Number.isInteger(messageId) && Number(messageId) > 0) control.cancelledMessageIds.add(Number(messageId));
  else control.cancelAll = true;
  return { cancelled: true };
}

async function stream(requestId: string, input: WebTransportStreamInput): Promise<WebTransportStreamResult> {
  const started = Date.now();
  playTrace("WORKER_STREAM_BEGIN");
  const active = requireReady();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud object reference is invalid.");
  const resolved = await resolvePlaybackMedia(active, messageId);
  playTrace("WORKER_STREAM_MESSAGE_READY", {
    elapsed_ms: Date.now() - started,
    media_cache_hit: resolved.cacheHit,
  });
  const media = resolved.media;
  const totalBytes = resolved.totalBytes;
  const mimeType = downloadMime(input.mimeType || resolved.sourceMime);
  const offsetBytes = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));
  if (offsetBytes % 4096 !== 0) throw new Error("Galer Cloud playback offset must be aligned to 4 KiB.");
  if (totalBytes > 0 && offsetBytes >= totalBytes) {
    playTrace("WORKER_STREAM_DONE", { elapsed_ms: Date.now() - started, bytes: offsetBytes, prefetched_only: true });
    return { messageId, totalBytes, mimeType };
  }
  const controller = new AbortController();
  const state = { controller, acknowledge: null as (() => void) | null };
  activeStreams.set(requestId, state);
  let downloadedBytes = offsetBytes;
  let transferredBytes = 0;
  let firstChunkLogged = false;
  const iterator = active.downloadAsIterable(media, {
    abortSignal: controller.signal,
    stallTimeout: 20_000,
    partSize: WEB_PLAYBACK_FIRST_CHUNK_KB,
    offset: offsetBytes,
  })[Symbol.asyncIterator]();
  try {
    while (true) {
      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");
      const next = await withDataLane(() => iterator.next(), "foreground");
      if (next.done) break;
      const chunk = next.value;
      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");
      downloadedBytes += chunk.byteLength;
      transferredBytes += chunk.byteLength;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        playTrace("WORKER_STREAM_FIRST_CHUNK", {
          elapsed_ms: Date.now() - started,
          bytes: chunk.byteLength,
          offset_bytes: offsetBytes,
          part_kb: WEB_PLAYBACK_FIRST_CHUNK_KB,
        });
      }
      const transferable = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      scope.postMessage({ requestId, event: "download-chunk", chunk: transferable, downloadedBytes, totalBytes: totalBytes || downloadedBytes }, [transferable]);
      await new Promise<void>(resolve => { state.acknowledge = resolve; });
      state.acknowledge = null;
      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");
    }
    if (transferredBytes <= 0 && !(totalBytes > 0 && offsetBytes >= totalBytes)) {
      throw new Error("Galer Cloud returned an empty object.");
    }
    playTrace("WORKER_STREAM_DONE", { elapsed_ms: Date.now() - started, bytes: downloadedBytes, offset_bytes: offsetBytes });
    return { messageId, totalBytes: totalBytes || downloadedBytes, mimeType };
  } finally {
    activeStreams.delete(requestId);
    if (typeof iterator.return === "function") await iterator.return().catch(() => {});
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
    case "prefetch": return prefetch(command.input);
    case "prefetch_batch": return prefetchBatch(command.requestId, command.input);
    case "prefetch_batch_cancel": return cancelPrefetchBatch(command.targetRequestId, command.messageId);
    case "stream": return stream(command.requestId, command.input);
    case "stream_ack": return acknowledgeStream(command.targetRequestId);
    case "cancel": return cancelStream(command.targetRequestId);
    case "upload": return upload(command.requestId, command.input);
    case "shutdown": await closeClient(); return { closed: true };
  }
}

scope.onmessage = event => {
  const command = event.data;
  if (command.op === "initialize" || command.op === "verify") {
    playTrace("WORKER_REQUEST_RECEIVED", { request_id: command.requestId, operation: command.op });
  }
  void handle(command).then(
    result => scope.postMessage({ requestId: command.requestId, ok: true, result }),
    error => scope.postMessage({ requestId: command.requestId, ok: false, error: String((error as any)?.message || error) }),
  );
};
