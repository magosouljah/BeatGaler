import { WEB_FOUNDATION_CAPABILITIES } from "./capabilities";
import type { PlatformAdapter, PlatformEventHandler, PlatformUnlisten } from "./contracts";
import type { Beat } from "../types";
import { getWebClientId } from "./webClientId";
import { pickWebSlotFile, webImportPort } from "./webImport";
import { WebLibraryWindowConsumer, type WebLibraryWindowSnapshot } from "../features/library/webLibraryWindow";
import { clearWebLibraryNavigationState, publishWebLibraryNavigationState, readRequestedWebLibraryOffset } from "../features/library/webLibraryNavigation";
import type { WebPlaybackSourceManager } from "../features/playback/webPlaybackSource";
import { installBeatCardWarmObserver, type BeatCardWarmPriority } from "../features/playback/webVisiblePlaybackPrefetch";
import { playTrace, observePlayStep } from "../features/playback/playTrace";
import { beginWebPlaybackIntent, invalidateAllWebPlaybackIntents, invalidateWebPlaybackIntentForBeat, isCurrentWebPlaybackIntent, rememberPreparedWebPlaybackUrl, supersededWebPlaybackUrl } from "../features/playback/webPlaybackIntent";
import { deletePlaybackRoutes, readWebPlaybackRoutingCache, upsertPlaybackRouteFromBeat } from "../features/playback/webPlaybackRoutingCache";
import { WebDownloadsManager } from "../features/downloads/webDownloads";

let webCoordinator: Promise<import("../features/playback/webStartupPlaybackCoordinator").WebStartupPlaybackCoordinator> | null = null;
let webCloudTransport: Promise<import("../features/cloud/webGalerCloudTransport").WebGalerCloudTransport> | null = null;
let webLibraryWindow: WebLibraryWindowConsumer | null = null;
let webPlaybackSources: WebPlaybackSourceManager | null = null;
let webDownloads: WebDownloadsManager | null = null;
const webBeatRegistry = new Map<string, Beat>();
const playbackRouteRecoveries = new Map<string, Promise<number | null>>();
let stopVisiblePlaybackObserver: (() => void) | null = null;
let stopPlaybackRuntimeObserver: (() => void) | null = null;

async function resolveWebCoordinator() {
  if (!webCoordinator) webCoordinator = observePlayStep("DIRECT_CODE_IMPORT", () => import("../features/playback/webStartupPlaybackCoordinator")).then(({ getWebStartupPlaybackCoordinator }) => getWebStartupPlaybackCoordinator());
  return webCoordinator;
}
async function resolveWebCloudTransport() {
  if (!webCloudTransport) webCloudTransport = resolveWebCoordinator().then(coordinator => { void coordinator.start().catch(error => playTrace("ADAPTER_TRANSPORT_PREWARM_DEFERRED", { error_name: error instanceof Error ? error.name : "unknown" })); return coordinator.getTransport(); });
  return webCloudTransport;
}
function directMessageId(value: string | null | undefined): number | null { const match = /^direct:(\d+)$/.exec(String(value || "").trim()); const messageId = Number(match?.[1] || 0); return Number.isInteger(messageId) && messageId > 0 ? messageId : null; }
function webBeatMessageId(beat: Beat): number | null {
  const routing = readWebPlaybackRoutingCache(); const cached = routing.routes[beat.id]?.messageId; if (cached) return cached; if (routing.authoritative === true) return null;
  const explicit = Number(beat.telegram_message_id || 0); if (Number.isInteger(explicit) && explicit > 0) return explicit; return directMessageId(beat.assets?.master?.object_id) || directMessageId(beat.telegram_file_id);
}
function playbackErrorCode(error: unknown): string | null { const code = String((error as { code?: unknown } | null)?.code || "").trim(); return code || null; }
function isRecoverablePlaybackRouteError(error: unknown): boolean { const code = playbackErrorCode(error); return code === "ROUTE_MISSING" || code === "MEDIA_UNAVAILABLE"; }
function prewarmAuthenticatedWebTransport(): void {
  if (typeof window === "undefined" || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  playTrace("ADAPTER_TRANSPORT_PREWARM_BEGIN"); void resolveWebCoordinator().then(coordinator => coordinator.start()).then(() => playTrace("ADAPTER_TRANSPORT_PREWARM_DISPATCHED"), error => playTrace("ADAPTER_TRANSPORT_PREWARM_DEFERRED", { error_name: error instanceof Error ? error.name : "unknown" }));
}
async function resolveWebLibraryWindow(): Promise<WebLibraryWindowConsumer> { if (!webLibraryWindow) webLibraryWindow = new WebLibraryWindowConsumer(await resolveWebCloudTransport()); return webLibraryWindow; }
async function recoverPlaybackRoute(beatId: string, failedMessageId: number): Promise<number | null> {
  const existing = playbackRouteRecoveries.get(beatId); if (existing) return existing; let recovery!: Promise<number | null>;
  recovery = (async () => {
    playTrace("PLAY_ROUTE_SUSPECT", { beat_id: beatId, message_id: failedMessageId }); const windowConsumer = await resolveWebLibraryWindow(); const page = await windowConsumer.refresh(); reportLibraryWindow(page, "playback-route-recovery");
    const repaired = readWebPlaybackRoutingCache().routes[beatId]?.messageId || null;
    if (!repaired || repaired === failedMessageId) { if (repaired === failedMessageId) deletePlaybackRoutes([beatId]); playTrace("PLAY_ROUTE_RECOVERY_FAILED", { beat_id: beatId, failed_message_id: failedMessageId, repaired_message_id: repaired }); return null; }
    playTrace("PLAY_ROUTE_RECOVERED", { beat_id: beatId, failed_message_id: failedMessageId, repaired_message_id: repaired }); return repaired;
  })().finally(() => { if (playbackRouteRecoveries.get(beatId) === recovery) playbackRouteRecoveries.delete(beatId); }); playbackRouteRecoveries.set(beatId, recovery); return recovery;
}
async function updateBeatWarmPriority(beatId: string, priority: BeatCardWarmPriority): Promise<void> {
  if (priority !== "far" && typeof navigator !== "undefined" && navigator.onLine === false) return; const beat = webBeatRegistry.get(beatId); if (!beat) return; const messageId = webBeatMessageId(beat); if (!messageId) return; if (priority === "far" && !webPlaybackSources) return;
  try { const sources = await resolveWebPlaybackSources(); sources.setPrefetchPriority(beat.id, messageId, beat.assets?.master?.mime_type || "audio/mpeg", priority); } catch (error) { playTrace("ADAPTER_WARM_PRIORITY_DEFERRED", { beat_id: beat.id, message_id: messageId, priority, error_name: error instanceof Error ? error.name : "unknown" }); }
}
function ensureVisiblePlaybackObserver(): void { if (stopVisiblePlaybackObserver || typeof window === "undefined") return; stopVisiblePlaybackObserver = installBeatCardWarmObserver((beatId, priority) => { playTrace("ADAPTER_CARD_WARM_PRIORITY", { beat_id: beatId, priority }); void updateBeatWarmPriority(beatId, priority); }); }
function ensurePlaybackRuntimeObserver(): void {
  if (stopPlaybackRuntimeObserver || typeof window === "undefined") return;
  const listener = (message: Event) => { const detail = (message as CustomEvent<{ beatId?: string | null; currentTime?: number; playing?: boolean; waiting?: boolean }>).detail; const beatId = String(detail?.beatId || "").trim(); if (!beatId) return; webPlaybackSources?.updatePlaybackState({ beatId, currentTime: Math.max(0, Number(detail?.currentTime) || 0), playing: Boolean(detail?.playing), waiting: Boolean(detail?.waiting) }); };
  window.addEventListener("beatgaler:web-playback-state", listener); stopPlaybackRuntimeObserver = () => window.removeEventListener("beatgaler:web-playback-state", listener);
}
function rememberWebBeats(beats: readonly Beat[]): void { for (const beat of beats) webBeatRegistry.set(beat.id, beat); stopVisiblePlaybackObserver?.(); stopVisiblePlaybackObserver = null; ensureVisiblePlaybackObserver(); }
function forgetWebBeats(ids: readonly string[]): void { for (const id of ids) { webBeatRegistry.delete(id); invalidateWebPlaybackIntentForBeat(id); webPlaybackSources?.forget(id); } deletePlaybackRoutes(ids); }
function resetVisiblePlaybackPrefetch(): void { stopVisiblePlaybackObserver?.(); stopVisiblePlaybackObserver = null; stopPlaybackRuntimeObserver?.(); stopPlaybackRuntimeObserver = null; webBeatRegistry.clear(); }
function reportLibraryWindow(page: WebLibraryWindowSnapshot, reason: string): void {
  rememberWebBeats(page.beats); publishWebLibraryNavigationState({ offset: page.offset, previousOffset: page.previousOffset, nextOffset: page.nextOffset, pageSize: page.evidence.pageSize, materializedCount: page.materializedCount, totalVisible: page.totalVisible });
  console.info(`[web/library-window] ${reason} offset=${page.offset} materialized=${page.materializedCount}/${page.totalVisible} max=${page.evidence.maxMaterializedCount} avoided=${page.evidence.avoidedRichMaterializations} ratio=${page.evidence.richMaterializationRatio.toFixed(4)}`);
}
async function resolveWebPlaybackSources(): Promise<WebPlaybackSourceManager> { if (webPlaybackSources) return webPlaybackSources; const coordinator = await resolveWebCoordinator(); void coordinator.start().catch(() => {}); webPlaybackSources = coordinator.getPlaybackSources(); ensurePlaybackRuntimeObserver(); return webPlaybackSources; }
function resolveWebDownloads(): WebDownloadsManager { if (!webDownloads) webDownloads = new WebDownloadsManager(resolveWebCloudTransport()); return webDownloads; }
const WEB_INCOMPLETE_WARNINGS_KEY = "beatgaler:web-incomplete-warnings:v1"; const WEB_CUSTOM_CURSOR_KEY = "beatgaler:web-custom-cursor:v1";
function readBooleanPreference(key: string, fallback: boolean): boolean { try { const value = window.localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; } }
function writeBooleanPreference(key: string, value: boolean): void { try { window.localStorage.setItem(key, String(value)); } catch {} }
function unavailable(feature: string): never { throw new Error(`${feature} is not available in BeatGaler Web yet.`); }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError"; }
const webClientId = getWebClientId();

export const webAdapter: PlatformAdapter = {
  kind: "web", capabilities: WEB_FOUNDATION_CAPABILITIES, clientId: webClientId,
  library: {
    async load() { try { const windowConsumer = await resolveWebLibraryWindow(); const requestedOffset = readRequestedWebLibraryOffset(); const page = requestedOffset > 0 ? await windowConsumer.at(requestedOffset) : await windowConsumer.currentOrFirst(); reportLibraryWindow(page, requestedOffset > 0 ? "cursor" : "load"); return page.beats; } catch (error) { console.error("[web/library] authoritative load failed", error); throw new Error("Galer Cloud could not load your library. Please retry."); } },
    async loadOffline() { return []; }, async restoreAuthoritative() { const windowConsumer = await resolveWebLibraryWindow(); const page = await windowConsumer.refresh(); reportLibraryWindow(page, "refresh"); }, async commitSnapshot() { return unavailable("Galer Cloud library writes"); }, async flushOfflineTrashIntents() { return 0; },
  },
  preferences: {
    async load() { return { beats_folder: null, incomplete_warnings_enabled: readBooleanPreference(WEB_INCOMPLETE_WARNINGS_KEY, true), custom_cursor_enabled: readBooleanPreference(WEB_CUSTOM_CURSOR_KEY, true), beatgaler_user_id: webClientId, telegram_cloud_connected: true, telegram_cloud_username: null }; },
    async setIncompleteWarnings(enabled) { writeBooleanPreference(WEB_INCOMPLETE_WARNINGS_KEY, enabled); }, async setCustomCursor(enabled) { writeBooleanPreference(WEB_CUSTOM_CURSOR_KEY, enabled); },
  },
  trash: {
    async moveBeats(ids) { const transport = await resolveWebCloudTransport(); const moved = await transport.moveBeatsToTrash(ids, webClientId); forgetWebBeats(moved); return moved; },
    async listBeats() { return (await resolveWebCloudTransport()).listTrashItems(); },
    async restoreBeat(id) { const transport = await resolveWebCloudTransport(); const restored = await transport.restoreBeatFromTrash(id, webClientId); upsertPlaybackRouteFromBeat(restored); rememberWebBeats([restored]); return restored; },
    async purgeBeats() { return (await resolveWebCloudTransport()).purgeTrash(webClientId); }, async listPresets() { return []; }, async restorePreset(id) { void id; return unavailable("Preset restore"); }, async purgePresets() { return unavailable("Preset deletion"); },
  },
  playbackCache: { async status() { return webPlaybackSources?.cacheStatus() ?? { used_bytes: 0, limit_mb: 100 }; }, async setLimitMb(limitMb) { if (!webPlaybackSources) return { used_bytes: 0, limit_mb: Math.max(0, Math.round(limitMb)) }; return webPlaybackSources.setCacheLimitMb(limitMb); }, async clear() { return webPlaybackSources?.clearCache() ?? { used_bytes: 0, limit_mb: 100 }; } },
  system: { async getLogDirectory() { return ""; }, async getTemplatesDirectory() { return ""; }, async revealPath(path) { void path; return unavailable("Local file reveal"); }, async checkForUpdate() { return unavailable("Native app updates"); }, async installUpdate() { return unavailable("Native app updates"); } },
  startup: { async loadAuthenticatedShell() { const settings = await webAdapter.preferences.load(); const beats = await webAdapter.library.load(); const online = typeof navigator === "undefined" || navigator.onLine !== false; return { settings, beats, connectionState: online ? "online" : "offline", libraryVerified: true }; } },
  media: {
    resolveUrl(source) { return source; },
    async preparePlayback(beat) {
      const intent = beginWebPlaybackIntent(beat.id); const master = beat.assets?.master; const mimeType = master?.mime_type || "audio/mpeg"; let messageId = webBeatMessageId(beat); rememberWebBeats([beat]);
      const pendingRecovery = playbackRouteRecoveries.get(beat.id); if (pendingRecovery) { const repaired = await pendingRecovery; if (!isCurrentWebPlaybackIntent(intent)) return { url: supersededWebPlaybackUrl(intent), completed: Promise.resolve() }; messageId = repaired; }
      if (messageId) {
        playTrace("ADAPTER_PREPARE_ENTER", { beat_id: beat.id, message_id: messageId, mime_type: mimeType, intent_id: intent.id }); const sources = await resolveWebPlaybackSources(); if (!isCurrentWebPlaybackIntent(intent)) return { url: supersededWebPlaybackUrl(intent), completed: Promise.resolve() };
        playTrace("ADAPTER_SOURCE_MANAGER_READY", { beat_id: beat.id, intent_id: intent.id });
        const prepareOnce = async (targetMessageId: number) => { const warm = sources.prefetch(beat.id, targetMessageId, mimeType, "visible"); void warm.catch(() => {}); return sources.prepare(beat.id, targetMessageId, mimeType, intent.id); };
        try { const prepared = await prepareOnce(messageId); rememberPreparedWebPlaybackUrl(prepared.url, intent); playTrace("ADAPTER_PREPARE_READY", { beat_id: beat.id, intent_id: intent.id, current: isCurrentWebPlaybackIntent(intent) }); return prepared; }
        catch (error) {
          if (isAbortError(error) && !isCurrentWebPlaybackIntent(intent)) { const url = supersededWebPlaybackUrl(intent); playTrace("ADAPTER_PREPARE_SUPERSEDED", { beat_id: beat.id, intent_id: intent.id }); return { url, completed: Promise.resolve() }; }
          if (isRecoverablePlaybackRouteError(error) && isCurrentWebPlaybackIntent(intent)) { const repairedMessageId = await recoverPlaybackRoute(beat.id, messageId); if (!isCurrentWebPlaybackIntent(intent)) { const url = supersededWebPlaybackUrl(intent); playTrace("ADAPTER_PREPARE_SUPERSEDED", { beat_id: beat.id, intent_id: intent.id, phase: "route_reconcile" }); return { url, completed: Promise.resolve() }; } if (repairedMessageId && repairedMessageId !== messageId) { const prepared = await prepareOnce(repairedMessageId); rememberPreparedWebPlaybackUrl(prepared.url, intent); playTrace("ADAPTER_PREPARE_ROUTE_RETRY_READY", { beat_id: beat.id, intent_id: intent.id, failed_message_id: messageId, repaired_message_id: repairedMessageId }); return prepared; } }
          throw error;
        }
      }
      if (beat.playback_path.startsWith("blob:")) { playTrace("ADAPTER_LOCAL_BLOB", { beat_id: beat.id, intent_id: intent.id }); rememberPreparedWebPlaybackUrl(beat.playback_path, intent); return { url: beat.playback_path, completed: Promise.resolve() }; }
      throw new Error("This MASTER must be migrated before it can play on Web.");
    },
    async loadArtwork(beat) { const artwork = beat.assets?.artwork; const messageId = directMessageId(artwork?.object_id); if (!messageId) return null; const [result] = await (await resolveWebCloudTransport()).downloadFiles([{ messageId, mimeType: artwork?.mime_type || "image/jpeg", purpose: "artwork" }]); return result?.dataUrl ?? null; },
    releasePlayback(beatId) { invalidateWebPlaybackIntentForBeat(beatId); webPlaybackSources?.release(beatId); },
  },
  events: { async listen<T>(event: string, handler: PlatformEventHandler<T>): Promise<PlatformUnlisten> { const listener = (message: Event) => handler((message as CustomEvent<T>).detail); window.addEventListener(event, listener); return () => window.removeEventListener(event, listener); } },
  external: { async openUrl(url) { window.open(url, "_blank", "noopener,noreferrer"); } },
  account: { async getInstallationId() { return webClientId; } },
  cloud: { async status() { const reachable = typeof navigator === "undefined" || navigator.onLine !== false; return { connected: true, reachable, username: null }; } },
  cloudData: {
    async upload(input, onProgress) { return (await resolveWebCloudTransport()).upload(input, onProgress); },
    async commitImportedBeat(beat, onProgress) { const slots = webImportPort.slotFilesForBeat(beat.id); const master = slots.MASTER; if (!master) throw new Error("Add a MASTER MP3 before saving this beat."); const transport = await resolveWebCloudTransport(); try { const committed = await transport.commitImportedBeat(beat, { master, wav: slots.WAV, project: slots.PROJECT }, webClientId, onProgress); upsertPlaybackRouteFromBeat(committed); rememberWebBeats([committed]); webImportPort.releaseBeat(beat.id); return committed; } catch (error) { console.error("[web/import] durable commit failed", error); const message = error instanceof Error ? error.message : String(error); if (message.includes("changed on another device")) throw new Error(message); throw new Error("Galer Cloud could not save this beat. Your file is still available for retry."); } },
    async disconnect() { invalidateAllWebPlaybackIntents(); playbackRouteRecoveries.clear(); resetVisiblePlaybackPrefetch(); webPlaybackSources?.releaseAll(); webPlaybackSources = null; webDownloads?.cancelAll(); webDownloads = null; webLibraryWindow = null; clearWebLibraryNavigationState(); const module = await import("../features/playback/webStartupPlaybackCoordinator"); await module.disconnectWebStartupPlaybackCoordinator(); webCoordinator = null; webCloudTransport = null; },
  },
  downloads: { start(beat, kind, onProgress) { return resolveWebDownloads().start(beat, kind, onProgress); }, cancelAll() { webDownloads?.cancelAll(); } },
  editor: { pickFile: pickWebSlotFile, async commit(original, updated, files, onProgress) { const transport = await resolveWebCloudTransport(); try { const committed = await transport.commitBeatEdit(original, updated, files, webClientId, onProgress); upsertPlaybackRouteFromBeat(committed); rememberWebBeats([committed]); return committed; } catch (error) { console.error("[web/edit] durable commit failed", error); const message = error instanceof Error ? error.message : String(error); if (message.includes("changed on another device") || message.includes("no longer in your")) throw new Error(message); throw new Error("Galer Cloud could not save these changes. Your selections are still available for retry."); } } },
  cloudAuth: { async syncSession() { prewarmAuthenticatedWebTransport(); } }, diagnostics: { reviewPerformance() {}, async audioEvent() {} }, importer: webImportPort,
};
