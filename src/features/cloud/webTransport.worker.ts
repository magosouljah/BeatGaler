import { InputMedia, MemoryStorage, SessionConnection, TelegramClient, WebCryptoProvider, type FileDownloadLocation } from "@mtcute/web";
import mtcuteWasmUrl from "@mtcute/wasm/mtcute.wasm?url";
import { measureMp3PlayablePrefix } from "../audio/mp3PlayablePrefix";
import { playTrace, playTraceSpan } from "../playback/playTrace";
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
type ResolvedPlaybackMedia = CachedPlaybackMedia & { sourceMime: string | null; cacheHit: boolean };
type PlaybackMediaBatchResolution = {
  resolved: Map<number, ResolvedPlaybackMedia>;
  missing: Map<number, Error>;
};

type WarmState = "queued" | "active" | "preempted" | "ready" | "failed";
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
  warmState: WarmState;
  controller: AbortController | null;
  cancelled: boolean;
};
type PrefetchBatchControl = {
  requestId: string;
  cancelAll: boolean;
  cancelledMessageIds: Set<number>;
  states: BatchPrefetchState[];
  pendingWarm: BatchPrefetchState[];
  maxConcurrency: number;
};
type DataLanePriority = "foreground" | "warm";
type PlaybackSchedulerState = "IDLE" | "PLAY_CRITICAL" | "PLAY_STABLE";

const scope = globalThis as unknown as WorkerScope;
let client: TelegramClient | null = null;
let chatId = 0;
let expectedBotId = "";
let vaultVerified = false;
const activeStreams = new Map<string, { controller: AbortController; acknowledge: (() => void) | null }>();
const activePrefetchBatches = new Map<string, PrefetchBatchControl>();
const activeWarmTransfers = new Map<number, AbortController>();
const playbackMediaCache = new Map<number, CachedPlaybackMedia>();
const MAX_PLAYBACK_MEDIA_CACHE_ENTRIES = 256;
const LIBRARY_INDEX_CAPTION = "BEATGALER_LIBRARY_INDEX_V1";
const MAX_CONFIGURABLE_DATA_LANES = 16;
const STARTUP_MEDIA_BATCH_RETRY_DELAY_MS = 70;

let activeDataLanes = 0;
let dataLaneLimit = WEB_PLAYBACK_DATA_LANES;
const foregroundLaneWaiters: Array<() => void> = [];
const warmLaneWaiters: Array<() => void> = [];
let playbackSchedulerState: PlaybackSchedulerState = "IDLE";
let playbackMessageId: number | null = null;
let activeIndexAbortController: AbortController | null = null;
let schedulerEpoch = 0;
const schedulerWaiters = new Set<() => void>();

function notifyScheduler(): void {
  schedulerEpoch += 1;
  const waiters = Array.from(schedulerWaiters);
  schedulerWaiters.clear();
  for (const resolve of waiters) resolve();
}

function waitForSchedulerChange(epoch: number): Promise<void> {
  if (epoch !== schedulerEpoch) return Promise.resolve();
  return new Promise(resolve => schedulerWaiters.add(resolve));
}

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

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError") ||
    /abort/i.test(String((error as any)?.message || ""));
}

function isBoundTempLongJson(value: unknown): value is BoundTempLongJson {
  const row = value as Partial<BoundTempLongJson> | null;
  return Boolean(row && Number.isInteger(row.low) && Number.isInteger(row.high) && typeof row.unsigned === "boolean");
}

function isBoundTempSessionState(value: unknown): value is BoundTempSessionState {
  const row = value as Partial<BoundTempSessionState> | null;
  return Boolean(
    row && Number.isInteger(row.seqNo) && Number(row.seqNo) >= 0 && Number.isFinite(row.timeOffset) &&
    isBoundTempLongJson(row.lastMessageId) && isBoundTempLongJson(row.serverSalt) &&
    Array.isArray(row.queuedAcks) && row.queuedAcks.every(isBoundTempLongJson) &&
    isBoundTempLongJson(row.bindMsgId) && isBoundTempLongJson(row.lastSessionCreatedUid)
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
  if (typeof originalConnect !== "function") throw new Error("Galer Cloud Web transport could not prepare its temporary session.");
  const wrappedConnect = function (this: BoundTempConnection, ...args: any[]) {
    if (this?.params?.isMainConnection === true && this?.params?.isMainDcConnection === true && Number(this?.params?.dc?.id || 0) === dcId) {
      applyBoundTempSessionState(this, sessionId, state);
    }
    return originalConnect.apply(this, args);
  };
  prototype.connect = wrappedConnect;
  return () => { if (prototype.connect === wrappedConnect) prototype.connect = originalConnect; };
}

function assertBoundTempPrimarySession(next: TelegramClient, sessionId: BoundTempLongJson, dcId: number): void {
  const base = (next as any)._client || next;
  const network = base?.mt?.network as BoundTempNetwork | undefined;
  const connection = network?._dcConnections?.get(dcId)?.main?._connections?.[0];
  const current = connection?._session?._sessionId;
  if (!current || current.low !== sessionId.low || current.high !== sessionId.high || Boolean(current.unsigned) !== sessionId.unsigned) {
    throw new Error("Galer Cloud Web transport did not retain the bound temporary session.");
  }
}

async function closeClient(): Promise<void> {
  for (const stream of activeStreams.values()) {
    stream.controller.abort();
    stream.acknowledge?.();
  }
  activeStreams.clear();
  for (const control of activePrefetchBatches.values()) {
    control.cancelAll = true;
    for (const state of control.states) state.controller?.abort();
  }
  activePrefetchBatches.clear();
  activeWarmTransfers.clear();
  activeIndexAbortController?.abort();
  activeIndexAbortController = null;
  playbackMediaCache.clear();
  foregroundLaneWaiters.splice(0).forEach(resolve => resolve());
  warmLaneWaiters.splice(0).forEach(resolve => resolve());
  activeDataLanes = 0;
  dataLaneLimit = WEB_PLAYBACK_DATA_LANES;
  playbackSchedulerState = "IDLE";
  playbackMessageId = null;
  notifyScheduler();
  const current = client;
  client = null;
  chatId = 0;
  expectedBotId = "";
  vaultVerified = false;
  if (current) await current.destroy().catch(() => {});
}

function downloadableMedia(message: Awaited<ReturnType<TelegramClient["getMessages"]>>[number]): FileDownloadLocation {
  const media = message?.media;
  if (!media || !["document", "audio", "video", "voice", "photo", "sticker"].includes(media.type)) {
    throw new Error("Galer Cloud stored object is not downloadable.");
  }
  return media as FileDownloadLocation;
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

function cachedPlaybackMedia(messageId: number): ResolvedPlaybackMedia | null {
  const cached = playbackMediaCache.get(messageId);
  if (!cached) return null;
  touchPlaybackMedia(messageId, cached);
  return { media: cached.media, totalBytes: cached.totalBytes, mimeType: cached.mimeType, sourceMime: cached.mimeType, cacheHit: true };
}

function resolvedMediaFromMessage(message: Awaited<ReturnType<TelegramClient["getMessages"]>>[number]): ResolvedPlaybackMedia {
  const media = downloadableMedia(message);
  const totalBytes = Math.max(0, Number((media as { fileSize?: number }).fileSize || 0));
  const sourceMime = String((media as { mimeType?: string }).mimeType || "").trim() || null;
  return { media, totalBytes, mimeType: sourceMime, sourceMime, cacheHit: false };
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
      playTrace("WORKER_PLAYBACK_MEDIA_BATCH_RETRY", { count: messageIds.length, attempt, error_name: error instanceof Error ? error.name : "unknown" });
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
    } else misses.push(messageId);
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
      if (publishCache) touchPlaybackMedia(messageId, { media: value.media, totalBytes: value.totalBytes, mimeType: value.sourceMime });
    } catch (error) {
      missing.set(messageId, error instanceof Error ? error : new Error(String(error)));
    }
  }
  return { resolved, missing };
}

async function resolvePlaybackMedia(active: TelegramClient, messageId: number): Promise<ResolvedPlaybackMedia> {
  const cached = cachedPlaybackMedia(messageId);
  if (cached) return cached;
  playTrace("WORKER_PLAYBACK_MEDIA_CACHE_MISS", { message_id: messageId });
  const batch = await resolvePlaybackMediaBatch(active, chatId, [messageId]);
  const resolved = batch.resolved.get(messageId);
  if (resolved) return resolved;
  throw batch.missing.get(messageId) || new Error("Galer Cloud object no longer exists.");
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
  const startupMessageIds = Array.from(new Set(
    (command.startupMessageIds || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0),
  )).slice(0, 14);
  const primaryDcId = Number((temp_primary_dcs as any)?.main?.id || 0);
  const numericChatId = Number(chat_id);
  if (!chat_id || !Number.isSafeInteger(numericChatId) || numericChatId === 0 || !expected_bot_id ||
      !Number.isInteger(temp_api_id) || temp_api_id <= 0 || !(temp_auth_key instanceof Uint8Array) ||
      temp_auth_key.byteLength !== 256 || !isBoundTempLongJson(temp_session_id) ||
      !isBoundTempSessionState(temp_session_state) || !Number.isInteger(primaryDcId) || primaryDcId < 1 ||
      primaryDcId > 5 || !temp_primary_dcs) {
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
      self: { userId: Number(expected_bot_id), isBot: true, isPremium: false, usernames: [] } as any,
      authKey: temp_auth_key.slice(),
    }, true);
    const restoreConnect = installBoundTempConnectHook(temp_session_id, temp_session_state, primaryDcId);
    const endConnectTrace = playTraceSpan("WORKER_MTPROTO_CONNECT");
    try {
      await next.connect();
      endConnectTrace();
      playTrace("DIRECT_MTPROTO_READY", { elapsed_ms: Date.now() - started });
    } catch (error) {
      endConnectTrace("error");
      throw error;
    } finally {
      restoreConnect();
    }
    assertBoundTempPrimarySession(next, temp_session_id, primaryDcId);

    client = next;
    chatId = numericChatId;
    expectedBotId = String(expected_bot_id);
    vaultVerified = false;

    if (startupMessageIds.length > 0) {
      try {
        const mediaResult = await resolvePlaybackMediaBatch(next, numericChatId, startupMessageIds, false);
        for (const [messageId, value] of mediaResult.resolved) {
          touchPlaybackMedia(messageId, { media: value.media, totalBytes: value.totalBytes, mimeType: value.sourceMime });
        }
        playTrace("WORKER_STARTUP_MEDIA_BATCH_READY", {
          requested: startupMessageIds.length,
          resolved: mediaResult.resolved.size,
          missing: mediaResult.missing.size,
        });
      } catch (error) {
        playTrace("WORKER_STARTUP_MEDIA_BATCH_DEFERRED", {
          requested: startupMessageIds.length,
          error_name: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  } catch (error) {
    if (client === next) {
      client = null;
      chatId = 0;
      expectedBotId = "";
    }
    await next.destroy().catch(() => {});
    throw error;
  } finally {
    temp_auth_key.fill(0);
  }
  playTrace("WORKER_INITIALIZE_DONE", { elapsed_ms: Date.now() - started });
}

function requireConnected(): TelegramClient {
  if (!client || !chatId) throw new Error("Galer Cloud Web transport is not initialized.");
  return client;
}

function requireReady(): TelegramClient {
  const active = requireConnected();
  if (!vaultVerified) throw new Error("Galer Cloud Web transport is not ready.");
  return active;
}

async function verifyIdentity(): Promise<void> {
  const active = requireConnected();
  try {
    const self = await active.getMe();
    if (!self?.isBot || String(self.id) !== expectedBotId) {
      throw new Error("Temporary authorization resolved to the wrong transport identity.");
    }
    playTrace("DIRECT_BACKGROUND_GET_ME_OK");
  } catch (error) {
    playTrace("DIRECT_BACKGROUND_GET_ME_FAILED", { error_name: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

async function verifyReady(): Promise<void> {
  const active = requireConnected();
  try {
    await active.getChat(chatId);
    vaultVerified = true;
    playTrace("DIRECT_BACKGROUND_GET_CHAT_OK");
  } catch (error) {
    playTrace("DIRECT_BACKGROUND_GET_CHAT_FAILED", { error_name: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

function hasWarmWork(): boolean {
  for (const control of activePrefetchBatches.values()) {
    if (control.cancelAll) continue;
    if (control.states.some(state => !state.done && !state.cancelled && !state.error)) return true;
  }
  return activeWarmTransfers.size > 0;
}

function indexPriorityAllowed(): boolean {
  return playbackSchedulerState !== "PLAY_CRITICAL" && !hasWarmWork();
}

async function waitUntilIndexPriorityAllowed(): Promise<void> {
  while (!indexPriorityAllowed()) {
    const epoch = schedulerEpoch;
    if (indexPriorityAllowed()) return;
    await waitForSchedulerChange(epoch);
  }
}

function preemptActiveIndex(reason: "play" | "warm"): void {
  const controller = activeIndexAbortController;
  if (!controller || controller.signal.aborted) return;
  controller.abort();
  playTrace(reason === "play" ? "INDEX_PREEMPTED_PLAY" : "INDEX_PREEMPTED_WARM");
}

async function getLibraryIndex(): Promise<WebTransportLibraryIndexResult> {
  const active = requireConnected();
  const started = Date.now();
  let failures = 0;
  let resumed = false;
  while (failures < 5) {
    await waitUntilIndexPriorityAllowed();
    playTrace(resumed ? "INDEX_RESUMED" : "INDEX_BEGIN");
    let controller: AbortController | null = null;
    try {
      const fullChat = await active.getFullChat(chatId);
      if (!indexPriorityAllowed()) { resumed = true; continue; }
      const pinnedId = Number(fullChat.pinnedMsgId || 0);
      if (!Number.isInteger(pinnedId) || pinnedId <= 0) throw new Error("Galer Cloud library index is still synchronizing.");
      const [message] = await active.getMessages(chatId, [pinnedId]);
      if (!indexPriorityAllowed()) { resumed = true; continue; }
      if (!message || !message.text.startsWith(LIBRARY_INDEX_CAPTION)) throw new Error("Galer Cloud library index is not available.");
      controller = new AbortController();
      activeIndexAbortController = controller;
      const bytes = await active.downloadAsBuffer(downloadableMedia(message), {
        abortSignal: controller.signal,
        stallTimeout: 20_000,
      });
      if (controller.signal.aborted || !indexPriorityAllowed()) {
        resumed = true;
        continue;
      }
      if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) throw new Error("Galer Cloud library index has an invalid size.");
      playTrace("INDEX_DONE", { elapsed_ms: Date.now() - started, bytes: bytes.byteLength });
      return { manifest: JSON.parse(new TextDecoder().decode(bytes)), messageId: pinnedId };
    } catch (error) {
      if ((controller?.signal.aborted || isAbortError(error)) && !indexPriorityAllowed()) {
        resumed = true;
        continue;
      }
      failures += 1;
      playTrace("WORKER_GET_INDEX_RETRY", { attempt: failures, error_name: error instanceof Error ? error.name : "unknown" });
      if (failures < 5) await new Promise(resolve => setTimeout(resolve, Math.min(1000, 80 * (2 ** (failures - 1)))));
      else throw error;
    } finally {
      if (activeIndexAbortController === controller) activeIndexAbortController = null;
    }
  }
  throw new Error("Galer Cloud library index could not be read.");
}

function libraryIdentityIds(manifest: unknown): Set<string> {
  const root = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest as Record<string, unknown> : {};
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
    ? input.manifest as Record<string, unknown> : null;
  if (!root || root.schema !== "beatgaler.telegram.library" || Number(root.version) !== 2) throw new Error("Galer Cloud refused an invalid library update.");
  const current = await getLibraryIndex();
  if (current.messageId !== input.expectedMessageId) throw new Error("Your library changed on another device. Retry Save to use the latest version.");
  const candidateIds = libraryIdentityIds(root);
  const missing = Array.from(libraryIdentityIds(current.manifest)).filter(id => !candidateIds.has(id));
  if (missing.length > 0) throw new Error("Galer Cloud blocked a stale library update.");
  const bytes = new TextEncoder().encode(JSON.stringify(root));
  if (bytes.byteLength <= 0 || bytes.byteLength > 16 * 1024 * 1024) throw new Error("Galer Cloud library update has an invalid size.");
  const file = new File([bytes], `beatgaler-library-${Date.now()}.json`, { type: "application/json" });
  const sent = await active.sendMedia(chatId, InputMedia.document(file, {
    fileName: file.name, fileMime: file.type, fileSize: file.size, caption: LIBRARY_INDEX_CAPTION,
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
  if (current.messageId && current.messageId !== messageId) await active.deleteMessagesById(chatId, [current.messageId]).catch(() => {});
  return { messageId, previousMessageId: current.messageId, beatCount: Array.isArray(root.beats) ? root.beats.length : 0 };
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
  const active = requireConnected();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud object reference is invalid.");
  const resolved = await resolvePlaybackMedia(active, messageId);
  const offsetBytes = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));
  if (offsetBytes % 4096 !== 0) throw new Error("Galer Cloud playback offset must be aligned to 4 KiB.");
  const remaining = resolved.totalBytes > 0 ? Math.max(0, resolved.totalBytes - offsetBytes) : WEB_PLAYBACK_FIRST_CHUNK_BYTES;
  const limit = Math.min(WEB_PLAYBACK_FIRST_CHUNK_BYTES, remaining || WEB_PLAYBACK_FIRST_CHUNK_BYTES);
  const bytes = await withDataLane(() => active.downloadChunk({ location: resolved.media, offset: offsetBytes, limit }), "foreground");
  if (bytes.byteLength <= 0) throw new Error("Galer Cloud returned an empty playback prefix.");
  const prefix = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const mimeType = downloadMime(input.mimeType || resolved.sourceMime);
  const measurement = offsetBytes === 0 ? measureMp3PlayablePrefix(prefix) : null;
  playTrace("WORKER_PREFETCH_READY", { message_id: messageId, bytes: prefix.byteLength, elapsed_ms: Date.now() - started, media_cache_hit: resolved.cacheHit });
  return { messageId, totalBytes: resolved.totalBytes || offsetBytes + prefix.byteLength, mimeType, prefix, playableSeconds: measurement?.playableSeconds || 0, targetMet: true };
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
    warmState: "queued",
    controller: null,
    cancelled: false,
  };
}

async function resolveBatchStates(active: TelegramClient, states: BatchPrefetchState[]): Promise<void> {
  const valid: BatchPrefetchState[] = [];
  for (const state of states) {
    if (!Number.isInteger(state.messageId) || state.messageId <= 0) {
      state.error = new Error("Galer Cloud object reference is invalid."); state.done = true; state.warmState = "failed"; continue;
    }
    if (state.offsetBytes % 4096 !== 0) {
      state.error = new Error("Galer Cloud playback offset must be aligned to 4 KiB."); state.done = true; state.warmState = "failed"; continue;
    }
    valid.push(state);
  }
  if (valid.length === 0) return;
  let batch: PlaybackMediaBatchResolution;
  try {
    batch = await resolvePlaybackMediaBatch(active, chatId, valid.map(state => state.messageId));
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const state of valid) { state.error = failure; state.done = true; state.warmState = "failed"; }
    return;
  }
  for (const state of valid) {
    const resolved = batch.resolved.get(state.messageId);
    if (!resolved) {
      state.error = batch.missing.get(state.messageId) || new Error("Galer Cloud object no longer exists.");
      state.done = true; state.warmState = "failed"; continue;
    }
    state.media = resolved.media;
    state.totalBytes = resolved.totalBytes;
    state.mimeType = downloadMime(state.requestedMimeType || resolved.sourceMime);
    if (state.totalBytes > 0 && state.offsetBytes >= state.totalBytes) {
      state.done = true; state.targetMet = true; state.warmState = "ready";
    }
  }
}

function warmConcurrencyLimit(): number {
  const limit = playbackSchedulerState === "PLAY_CRITICAL" ? 0
    : playbackSchedulerState === "PLAY_STABLE" ? 6 : dataLaneLimit;
  return Math.max(0, Math.min(dataLaneLimit, limit));
}

function moveFocusedTargetToFront(control: PrefetchBatchControl, messageId: number): void {
  const index = control.pendingWarm.findIndex(state => state.messageId === messageId && !state.done && !state.cancelled);
  if (index <= 0) return;
  const [target] = control.pendingWarm.splice(index, 1);
  control.pendingWarm.unshift(target);
}

function takeNextWarm(control: PrefetchBatchControl): BatchPrefetchState | null {
  control.pendingWarm = control.pendingWarm.filter(state => !state.done && !state.cancelled && !state.error);
  if (control.pendingWarm.length === 0) return null;
  if (playbackSchedulerState === "PLAY_CRITICAL") {
    if (!playbackMessageId) return null;
    moveFocusedTargetToFront(control, playbackMessageId);
    const target = control.pendingWarm[0];
    if (target?.messageId !== playbackMessageId) return null;
    control.pendingWarm.shift();
    return target;
  }
  if (activeWarmTransfers.size >= warmConcurrencyLimit()) return null;
  return control.pendingWarm.shift() || null;
}

function batchTerminal(control: PrefetchBatchControl): boolean {
  return control.states.every(state => state.done || state.cancelled || state.error);
}

async function downloadStartupPrefix(requestId: string, state: BatchPrefetchState, control: PrefetchBatchControl): Promise<void> {
  if (state.done || state.error || state.cancelled || !state.media) return;
  const absoluteOffset = state.offsetBytes;
  const remainingFile = state.totalBytes > 0 ? Math.max(0, state.totalBytes - absoluteOffset) : STARTUP_PREFIX_BYTES;
  const limit = Math.min(STARTUP_PREFIX_BYTES, remainingFile || STARTUP_PREFIX_BYTES);
  if (limit <= 0) { state.done = true; state.targetMet = true; state.warmState = "ready"; return; }

  const controller = new AbortController();
  state.controller = controller;
  state.warmState = "active";
  activeWarmTransfers.set(state.messageId, controller);
  const promoted = playbackSchedulerState === "PLAY_CRITICAL" && playbackMessageId === state.messageId;
  try {
    const active = requireConnected();
    const bytes = await withDataLane(() => active.downloadChunk({
      location: state.media!,
      offset: absoluteOffset,
      limit,
      abortSignal: controller.signal,
    }), promoted ? "foreground" : "warm");
    if (bytes.byteLength <= 0) throw new Error("Galer Cloud returned an empty playback prefix.");
    const stored = bytes.slice();
    state.chunks = [stored];
    state.downloadedBytes = stored.byteLength;
    state.targetMet = true;
    state.done = true;
    state.warmState = "ready";
    const downloadedAbsolute = absoluteOffset + stored.byteLength;
    const transferable = stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength) as ArrayBuffer;
    scope.postMessage({ requestId, event: "prefetch-chunk", progress: {
      messageId: state.messageId,
      totalBytes: state.totalBytes || downloadedAbsolute,
      mimeType: state.mimeType,
      offsetBytes: absoluteOffset,
      chunk: transferable,
      downloadedBytes: downloadedAbsolute,
      playableSeconds: 0,
      targetMet: true,
    } }, [transferable]);
    playTrace("WARM_PREFIX_READY", { message_id: state.messageId, bytes: stored.byteLength, offset_bytes: absoluteOffset });
  } catch (error) {
    const cancelled = control.cancelAll || control.cancelledMessageIds.has(state.messageId) || state.cancelled;
    if (controller.signal.aborted && !cancelled) {
      state.warmState = "preempted";
      state.done = false;
      state.error = null;
      if (!control.pendingWarm.includes(state)) control.pendingWarm.push(state);
      playTrace("WORKER_WARM_PREEMPTED", { message_id: state.messageId });
    } else if (cancelled && isAbortError(error)) {
      state.cancelled = true;
      state.done = true;
    } else {
      state.error = error instanceof Error ? error : new Error(String(error));
      state.done = true;
      state.warmState = "failed";
    }
  } finally {
    if (activeWarmTransfers.get(state.messageId) === controller) activeWarmTransfers.delete(state.messageId);
    if (state.controller === controller) state.controller = null;
    notifyScheduler();
  }
}

async function prefetchBatch(requestId: string, input: WebTransportPrefetchBatchInput): Promise<WebTransportPrefetchBatchResult> {
  const started = Date.now();
  const active = requireConnected();
  const deduped = new Map<number, WebTransportPrefetchInput>();
  for (const candidate of Array.isArray(input.inputs) ? input.inputs : []) {
    const messageId = Number(candidate?.messageId || 0);
    if (!deduped.has(messageId)) deduped.set(messageId, candidate);
  }
  const states = Array.from(deduped.values(), normalizeBatchState);
  const maxConcurrency = configureDataLaneLimit(input.maxConcurrency);
  const control: PrefetchBatchControl = {
    requestId,
    cancelAll: false,
    cancelledMessageIds: new Set(),
    states,
    pendingWarm: [],
    maxConcurrency,
  };
  activePrefetchBatches.set(requestId, control);
  preemptActiveIndex("warm");
  playTrace("WARM_BATCH_BEGIN", { count: states.length, prefix_bytes: STARTUP_PREFIX_BYTES, lanes: maxConcurrency });
  try {
    await resolveBatchStates(active, states);
    control.pendingWarm = states.filter(state => !state.done && !state.error && !state.cancelled);
    if (playbackMessageId) moveFocusedTargetToFront(control, playbackMessageId);
    notifyScheduler();

    const laneLoop = async (lane: number) => {
      while (!control.cancelAll) {
        if (batchTerminal(control)) return;
        const epoch = schedulerEpoch;
        const state = takeNextWarm(control);
        if (!state) {
          if (batchTerminal(control)) return;
          await waitForSchedulerChange(epoch);
          continue;
        }
        playTrace("WORKER_PREFETCH_LANE_TAKE", { lane, message_id: state.messageId, scheduler: playbackSchedulerState });
        await downloadStartupPrefix(requestId, state, control);
        await schedulerYield();
      }
    };
    const laneCount = Math.min(maxConcurrency, Math.max(1, states.length));
    await Promise.all(Array.from({ length: laneCount }, (_, index) => laneLoop(index + 1)));

    const results: WebTransportPrefetchBatchItemResult[] = states.map(state => {
      if (state.error) return { ok: false as const, messageId: state.messageId, error: state.error.message };
      if (state.cancelled) return { ok: false as const, messageId: state.messageId, error: "Cancelled." };
      const prefixBytes = concatBytes(state.chunks);
      const prefix = prefixBytes.buffer.slice(prefixBytes.byteOffset, prefixBytes.byteOffset + prefixBytes.byteLength) as ArrayBuffer;
      return { ok: true as const, result: {
        messageId: state.messageId,
        totalBytes: state.totalBytes || state.offsetBytes + state.downloadedBytes,
        mimeType: state.mimeType,
        prefix,
        playableSeconds: 0,
        targetMet: state.targetMet,
      } };
    });
    playTrace("WORKER_PREFETCH_BATCH_DONE", { count: states.length, elapsed_ms: Date.now() - started, failures: results.filter(result => !result.ok).length });
    return { results };
  } finally {
    activePrefetchBatches.delete(requestId);
    notifyScheduler();
  }
}

function cancelPrefetchBatch(targetRequestId: string, messageId?: number): { cancelled: boolean } {
  const control = activePrefetchBatches.get(String(targetRequestId || ""));
  if (!control) return { cancelled: false };
  if (Number.isInteger(messageId) && Number(messageId) > 0) {
    const id = Number(messageId);
    control.cancelledMessageIds.add(id);
    const state = control.states.find(candidate => candidate.messageId === id);
    if (state) { state.cancelled = true; state.done = true; state.controller?.abort(); }
    control.pendingWarm = control.pendingWarm.filter(candidate => candidate.messageId !== id);
  } else {
    control.cancelAll = true;
    for (const state of control.states) {
      if (!state.done) { state.cancelled = true; state.done = true; state.controller?.abort(); }
    }
    control.pendingWarm.length = 0;
  }
  notifyScheduler();
  return { cancelled: true };
}

function playbackFocus(messageId: number): { focused: boolean } {
  const id = Number(messageId || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return { focused: false };
  playbackSchedulerState = "PLAY_CRITICAL";
  playbackMessageId = id;
  preemptActiveIndex("play");
  let aborted = 0;
  for (const [activeId, controller] of activeWarmTransfers) {
    if (activeId === id) continue;
    controller.abort();
    aborted += 1;
  }
  for (const control of activePrefetchBatches.values()) moveFocusedTargetToFront(control, id);
  playTrace("PLAY_WARM_PREEMPT_ALL", { message_id: id, aborted });
  notifyScheduler();
  return { focused: true };
}

function playbackStable(messageId: number): { stable: boolean } {
  const id = Number(messageId || 0);
  if (playbackMessageId !== id) return { stable: false };
  playbackSchedulerState = "PLAY_STABLE";
  playTrace("WARM_RESUME", { lanes: 6, message_id: id });
  notifyScheduler();
  return { stable: true };
}

function playbackRelease(messageId: number): { released: boolean } {
  const id = Number(messageId || 0);
  if (playbackMessageId !== id) return { released: false };
  playbackMessageId = null;
  playbackSchedulerState = "IDLE";
  playTrace("WARM_RESUME", { lanes: dataLaneLimit });
  notifyScheduler();
  return { released: true };
}

async function stream(requestId: string, input: WebTransportStreamInput): Promise<WebTransportStreamResult> {
  const started = Date.now();
  const active = requireConnected();
  const messageId = Number(input.messageId || 0);
  if (!Number.isInteger(messageId) || messageId <= 0) throw new Error("Galer Cloud object reference is invalid.");
  const resolved = await resolvePlaybackMedia(active, messageId);
  const media = resolved.media;
  const totalBytes = resolved.totalBytes;
  const mimeType = downloadMime(input.mimeType || resolved.sourceMime);
  const offsetBytes = Math.max(0, Math.floor(Number(input.offsetBytes) || 0));
  if (offsetBytes % 4096 !== 0) throw new Error("Galer Cloud playback offset must be aligned to 4 KiB.");
  if (totalBytes > 0 && offsetBytes >= totalBytes) return { messageId, totalBytes, mimeType };
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
  playTrace("PLAY_STREAM_BEGIN", { message_id: messageId, offset_bytes: offsetBytes });
  try {
    while (true) {
      if (controller.signal.aborted) throw new DOMException("Playback stream cancelled.", "AbortError");
      const next = await withDataLane(() => iterator.next(), "foreground");
      if (next.done) break;
      const chunk = next.value;
      downloadedBytes += chunk.byteLength;
      transferredBytes += chunk.byteLength;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        playTrace("PLAY_STREAM_FIRST_CHUNK", { elapsed_ms: Date.now() - started, bytes: chunk.byteLength, offset_bytes: offsetBytes });
      }
      const transferable = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
      scope.postMessage({ requestId, event: "download-chunk", chunk: transferable, downloadedBytes, totalBytes: totalBytes || downloadedBytes }, [transferable]);
      await new Promise<void>(resolve => { state.acknowledge = resolve; });
      state.acknowledge = null;
    }
    if (transferredBytes <= 0 && !(totalBytes > 0 && offsetBytes >= totalBytes)) throw new Error("Galer Cloud returned an empty object.");
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
  return { telegram_file_id: stored.telegram_file_id, telegram_message_id: messageId, filename: input.filename, original_size: input.file.size, parts: [stored], transport: "direct-web" };
}

async function handle(command: WebTransportWorkerCommand): Promise<unknown> {
  switch (command.op) {
    case "initialize": await initialize(command); return { ready: true };
    case "verify_identity": await verifyIdentity(); return { verified: true };
    case "verify": await verifyReady(); return { verified: true };
    case "get_index": return getLibraryIndex();
    case "replace_index": return replaceLibraryIndex(command.input);
    case "delete_messages": return deleteMessages(command.input);
    case "download": return download(command.input);
    case "prefetch": return prefetch(command.input);
    case "prefetch_batch": return prefetchBatch(command.requestId, command.input);
    case "prefetch_batch_cancel": return cancelPrefetchBatch(command.targetRequestId, command.messageId);
    case "playback_focus": return playbackFocus(command.messageId);
    case "playback_stable": return playbackStable(command.messageId);
    case "playback_release": return playbackRelease(command.messageId);
    case "stream": return stream(command.requestId, command.input);
    case "stream_ack": return acknowledgeStream(command.targetRequestId);
    case "cancel": return cancelStream(command.targetRequestId);
    case "upload": return upload(command.requestId, command.input);
    case "shutdown": await closeClient(); return { closed: true };
  }
}

scope.onmessage = event => {
  const command = event.data;
  if (command.op === "initialize" || command.op === "verify" || command.op === "verify_identity") {
    playTrace("WORKER_REQUEST_RECEIVED", { request_id: command.requestId, operation: command.op });
  }
  void handle(command).then(
    result => scope.postMessage({ requestId: command.requestId, ok: true, result }),
    error => scope.postMessage({ requestId: command.requestId, ok: false, error: String((error as any)?.message || error) }),
  );
};
