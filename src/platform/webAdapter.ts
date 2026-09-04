import { WEB_FOUNDATION_CAPABILITIES } from "./capabilities";
import type { PlatformAdapter, PlatformEventHandler, PlatformUnlisten } from "./contracts";
import type { Beat } from "../types";
import { getWebClientId } from "./webClientId";
import { pickWebSlotFile, webImportPort } from "./webImport";
import { WebLibraryWindowConsumer, type WebLibraryWindowSnapshot } from "../features/library/webLibraryWindow";
import {
  clearWebLibraryNavigationState,
  publishWebLibraryNavigationState,
  readRequestedWebLibraryOffset,
} from "../features/library/webLibraryNavigation";
import {
  WebPlaybackSourceManager,
  type WebPlaybackPrefetchCandidate,
} from "../features/playback/webPlaybackSource";
import {
  installVisibleAndNearbyBeatCardObserver,
  type BeatCardPrefetchSnapshot,
} from "../features/playback/webVisiblePlaybackPrefetch";
import { playTrace, observePlayStep } from "../features/playback/playTrace";
import { WebDownloadsManager } from "../features/downloads/webDownloads";

let webCloudTransport: Promise<import("../features/cloud/webGalerCloudTransport").WebGalerCloudTransport> | null = null;
let webLibraryWindow: WebLibraryWindowConsumer | null = null;
let webPlaybackSources: WebPlaybackSourceManager | null = null;
let webDownloads: WebDownloadsManager | null = null;
const webBeatRegistry = new Map<string, Beat>();
let stopVisiblePlaybackObserver: (() => void) | null = null;

async function resolveWebCloudTransport() {
  if (!webCloudTransport) {
    webCloudTransport = observePlayStep("DIRECT_CODE_IMPORT", () => import("../features/cloud/webGalerCloudTransport"))
      .then(({ WebGalerCloudTransport }) => new WebGalerCloudTransport());
  }
  return webCloudTransport;
}

function prewarmAuthenticatedWebTransport(): void {
  if (typeof window === "undefined") return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  // Authentication owns this trigger. The durable marker is only a final guard
  // so session-expiry/logout syncs cannot import Direct for a signed-out page.
  try {
    if (window.localStorage.getItem("beatgaler:web-session-present:v1") !== "1") return;
  } catch {
    return;
  }

  playTrace("ADAPTER_TRANSPORT_PREWARM_BEGIN");
  void resolveWebCloudTransport().then(
    () => playTrace("ADAPTER_TRANSPORT_PREWARM_DISPATCHED"),
    error => playTrace("ADAPTER_TRANSPORT_PREWARM_DEFERRED", {
      error_name: error instanceof Error ? error.name : "unknown",
    }),
  );
}

async function resolveWebLibraryWindow(): Promise<WebLibraryWindowConsumer> {
  if (!webLibraryWindow) webLibraryWindow = new WebLibraryWindowConsumer(await resolveWebCloudTransport());
  return webLibraryWindow;
}

function directMessageId(value: string | null | undefined): number | null {
  const match = /^direct:(\d+)$/.exec(String(value || "").trim());
  const messageId = Number(match?.[1] || 0);
  return Number.isInteger(messageId) && messageId > 0 ? messageId : null;
}

function webBeatMessageId(beat: Beat): number | null {
  const explicit = Number(beat.telegram_message_id || 0);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return directMessageId(beat.assets?.master?.object_id) || directMessageId(beat.telegram_file_id);
}

function playbackCandidate(beatId: string): WebPlaybackPrefetchCandidate | null {
  const beat = webBeatRegistry.get(beatId);
  if (!beat) return null;
  const messageId = webBeatMessageId(beat);
  if (!messageId) return null;
  return {
    beatId: beat.id,
    messageId,
    mimeType: beat.assets?.master?.mime_type || "audio/mpeg",
  };
}

async function prefetchViewportSnapshot(snapshot: BeatCardPrefetchSnapshot): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const visible = snapshot.visible.map(playbackCandidate).filter((value): value is WebPlaybackPrefetchCandidate => value !== null);
  const visibleIds = new Set(visible.map(candidate => candidate.beatId));
  const nearby = snapshot.nearby
    .map(playbackCandidate)
    .filter((value): value is WebPlaybackPrefetchCandidate => value !== null && !visibleIds.has(value.beatId));
  try {
    const sources = await resolveWebPlaybackSources();
    await sources.setPrefetchSnapshot({ visible, nearby });
  } catch (error) {
    playTrace("ADAPTER_VIEWPORT_PREFETCH_DEFERRED", {
      visible_candidates: visible.length,
      nearby_candidates: nearby.length,
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }
}

function ensureVisiblePlaybackObserver(): void {
  if (stopVisiblePlaybackObserver || typeof window === "undefined") return;
  stopVisiblePlaybackObserver = installVisibleAndNearbyBeatCardObserver(snapshot => {
    playTrace("ADAPTER_VIEWPORT_PREFETCH_SNAPSHOT", {
      visible_candidates: snapshot.visible.length,
      nearby_candidates: snapshot.nearby.length,
    });
    void prefetchViewportSnapshot(snapshot);
  });
}

function rememberWebBeats(beats: readonly Beat[]): void {
  for (const beat of beats) webBeatRegistry.set(beat.id, beat);
  // Observation can happen before a fast library load has populated metadata.
  // Reinstall after registry growth so the current viewport snapshot is emitted
  // again with resolvable MASTER message ids.
  stopVisiblePlaybackObserver?.();
  stopVisiblePlaybackObserver = null;
  ensureVisiblePlaybackObserver();
}

function forgetWebBeats(ids: readonly string[]): void {
  for (const id of ids) webBeatRegistry.delete(id);
}

function resetVisiblePlaybackPrefetch(): void {
  stopVisiblePlaybackObserver?.();
  stopVisiblePlaybackObserver = null;
  webBeatRegistry.clear();
}

function reportLibraryWindow(page: WebLibraryWindowSnapshot, reason: string): void {
  rememberWebBeats(page.beats);
  publishWebLibraryNavigationState({
    offset: page.offset,
    previousOffset: page.previousOffset,
    nextOffset: page.nextOffset,
    pageSize: page.evidence.pageSize,
    materializedCount: page.materializedCount,
    totalVisible: page.totalVisible,
  });
  console.info(
    `[web/library-window] ${reason} offset=${page.offset} materialized=${page.materializedCount}/${page.totalVisible} ` +
    `max=${page.evidence.maxMaterializedCount} avoided=${page.evidence.avoidedRichMaterializations} ratio=${page.evidence.richMaterializationRatio.toFixed(4)}`,
  );
}

async function resolveWebPlaybackSources(): Promise<WebPlaybackSourceManager> {
  if (webPlaybackSources) return webPlaybackSources;
  const transport = await resolveWebCloudTransport();
  // Re-check after the await so all viewport snapshots share one manager, one
  // prefix cache and one visible-before-nearby scheduler.
  if (!webPlaybackSources) webPlaybackSources = new WebPlaybackSourceManager(transport);
  return webPlaybackSources;
}

function resolveWebDownloads(): WebDownloadsManager {
  if (!webDownloads) webDownloads = new WebDownloadsManager(resolveWebCloudTransport());
  return webDownloads;
}

const WEB_INCOMPLETE_WARNINGS_KEY = "beatgaler:web-incomplete-warnings:v1";
const WEB_CUSTOM_CURSOR_KEY = "beatgaler:web-custom-cursor:v1";

function readBooleanPreference(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function writeBooleanPreference(key: string, value: boolean): void {
  try { window.localStorage.setItem(key, String(value)); } catch {}
}

function unavailable(feature: string): never {
  throw new Error(`${feature} is not available in BeatGaler Web yet.`);
}

const webClientId = getWebClientId();

export const webAdapter: PlatformAdapter = {
  kind: "web",
  capabilities: WEB_FOUNDATION_CAPABILITIES,
  clientId: webClientId,
  library: {
    async load() {
      try {
        const windowConsumer = await resolveWebLibraryWindow();
        const requestedOffset = readRequestedWebLibraryOffset();
        const page = requestedOffset > 0
          ? await windowConsumer.at(requestedOffset)
          : await windowConsumer.currentOrFirst();
        reportLibraryWindow(page, requestedOffset > 0 ? "cursor" : "load");
        return page.beats;
      } catch (error) {
        console.error("[web/library] authoritative load failed", error);
        throw new Error("Galer Cloud could not load your library. Please retry.");
      }
    },
    async loadOffline() { return []; },
    async restoreAuthoritative() {
      const windowConsumer = await resolveWebLibraryWindow();
      const page = await windowConsumer.refresh();
      reportLibraryWindow(page, "refresh");
    },
    async commitSnapshot() { return unavailable("Galer Cloud library writes"); },
    async flushOfflineTrashIntents() { return 0; },
  },
  preferences: {
    async load() {
      return {
        beats_folder: null,
        incomplete_warnings_enabled: readBooleanPreference(WEB_INCOMPLETE_WARNINGS_KEY, true),
        custom_cursor_enabled: readBooleanPreference(WEB_CUSTOM_CURSOR_KEY, true),
        beatgaler_user_id: webClientId,
        telegram_cloud_connected: true,
        telegram_cloud_username: null,
      };
    },
    async setIncompleteWarnings(enabled) {
      writeBooleanPreference(WEB_INCOMPLETE_WARNINGS_KEY, enabled);
    },
    async setCustomCursor(enabled) {
      writeBooleanPreference(WEB_CUSTOM_CURSOR_KEY, enabled);
    },
  },
  trash: {
    async moveBeats(ids) {
      const transport = await resolveWebCloudTransport();
      const moved = await transport.moveBeatsToTrash(ids, webClientId);
      forgetWebBeats(moved);
      return moved;
    },
    async listBeats() {
      const transport = await resolveWebCloudTransport();
      return transport.listTrashItems();
    },
    async restoreBeat(id) {
      const transport = await resolveWebCloudTransport();
      const restored = await transport.restoreBeatFromTrash(id, webClientId);
      rememberWebBeats([restored]);
      return restored;
    },
    async purgeBeats() {
      const transport = await resolveWebCloudTransport();
      return transport.purgeTrash(webClientId);
    },
    async listPresets() { return []; },
    async restorePreset(id) { void id; return unavailable("Preset restore"); },
    async purgePresets() { return unavailable("Preset deletion"); },
  },
  playbackCache: {
    async status() { return { used_bytes: 0, limit_mb: 0 }; },
    async setLimitMb(limitMb) { return { used_bytes: 0, limit_mb: Math.max(0, limitMb) }; },
    async clear() { return { used_bytes: 0, limit_mb: 0 }; },
  },
  system: {
    async getLogDirectory() { return ""; },
    async getTemplatesDirectory() { return ""; },
    async revealPath(path) { void path; return unavailable("Local file reveal"); },
    async checkForUpdate() { return unavailable("Native app updates"); },
    async installUpdate() { return unavailable("Native app updates"); },
  },
  startup: {
    async loadAuthenticatedShell() {
      const settings = await webAdapter.preferences.load();
      const beats = await webAdapter.library.load();
      const online = typeof navigator === "undefined" || navigator.onLine !== false;
      return {
        settings,
        beats,
        connectionState: online ? "online" : "offline",
        libraryVerified: true,
      };
    },
  },
  media: {
    resolveUrl(source) { return source; },
    async preparePlayback(beat) {
      const master = beat.assets?.master;
      const messageId = webBeatMessageId(beat);
      rememberWebBeats([beat]);
      // A blob: URL is valid only for the document that created it. Cached Web
      // manifests can outlive that document, so cloud-backed beats must always
      // obtain a fresh session-owned playback URL from WebPlaybackSourceManager.
      if (messageId) {
        playTrace("ADAPTER_PREPARE_ENTER", { beat_id: beat.id, mime_type: master?.mime_type || "audio/mpeg" });
        const sources = await resolveWebPlaybackSources();
        playTrace("ADAPTER_SOURCE_MANAGER_READY", { beat_id: beat.id });
        const prepared = await sources.prepare(beat.id, messageId, master?.mime_type || "audio/mpeg");
        playTrace("ADAPTER_PREPARE_READY", { beat_id: beat.id });
        return prepared;
      }
      // Keep the direct blob path only for a browser-local import that has not
      // been committed to Galer Cloud yet.
      if (beat.playback_path.startsWith("blob:")) {
        playTrace("ADAPTER_LOCAL_BLOB", { beat_id: beat.id });
        return { url: beat.playback_path, completed: Promise.resolve() };
      }
      throw new Error("This MASTER must be migrated before it can play on Web.");
    },
    async loadArtwork(beat) {
      const artwork = beat.assets?.artwork;
      const messageId = directMessageId(artwork?.object_id);
      if (!messageId) return null;

      const transport = await resolveWebCloudTransport();
      const [result] = await transport.downloadFiles([{
        messageId,
        mimeType: artwork?.mime_type || "image/jpeg",
      }]);

      return result?.dataUrl ?? null;
    },
    releasePlayback(beatId) {
      webPlaybackSources?.release(beatId);
    },
  },
  events: {
    async listen<T>(event: string, handler: PlatformEventHandler<T>): Promise<PlatformUnlisten> {
      const listener = (message: Event) => {
        handler((message as CustomEvent<T>).detail);
      };
      window.addEventListener(event, listener);
      return () => window.removeEventListener(event, listener);
    },
  },
  external: {
    async openUrl(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  },
  account: {
    async getInstallationId() {
      return webClientId;
    },
  },
  cloud: {
    async status() {
      const reachable = typeof navigator === "undefined" || navigator.onLine !== false;
      return { connected: true, reachable, username: null };
    },
  },
  cloudData: {
    async upload(input, onProgress) {
      const transport = await resolveWebCloudTransport();
      return transport.upload(input, onProgress);
    },
    async commitImportedBeat(beat, onProgress) {
      const slots = webImportPort.slotFilesForBeat(beat.id);
      const master = slots.MASTER;
      if (!master) throw new Error("Add a MASTER MP3 before saving this beat.");
      const transport = await resolveWebCloudTransport();
      try {
        const committed = await transport.commitImportedBeat(beat, {
          master,
          wav: slots.WAV,
          project: slots.PROJECT,
        }, webClientId, onProgress);
        rememberWebBeats([committed]);
        webImportPort.releaseBeat(beat.id);
        return committed;
      } catch (error) {
        console.error("[web/import] durable commit failed", error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("changed on another device")) throw new Error(message);
        throw new Error("Galer Cloud could not save this beat. Your file is still available for retry.");
      }
    },
    async disconnect() {
      resetVisiblePlaybackPrefetch();
      webPlaybackSources?.releaseAll();
      webPlaybackSources = null;
      webDownloads?.cancelAll();
      webDownloads = null;
      webLibraryWindow = null;
      clearWebLibraryNavigationState();
      if (!webCloudTransport) return;
      const transport = await webCloudTransport;
      webCloudTransport = null;
      await transport.disconnect();
    },
  },
  downloads: {
    start(beat, kind, onProgress) {
      return resolveWebDownloads().start(beat, kind, onProgress);
    },
    cancelAll() {
      webDownloads?.cancelAll();
    },
  },
  editor: {
    pickFile: pickWebSlotFile,
    async commit(original, updated, files, onProgress) {
      const transport = await resolveWebCloudTransport();
      try {
        const committed = await transport.commitBeatEdit(original, updated, files, webClientId, onProgress);
        rememberWebBeats([committed]);
        return committed;
      } catch (error) {
        console.error("[web/edit] durable commit failed", error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("changed on another device") || message.includes("no longer in your")) throw new Error(message);
        throw new Error("Galer Cloud could not save these changes. Your selections are still available for retry.");
      }
    },
  },
  cloudAuth: {
    async syncSession() {
      prewarmAuthenticatedWebTransport();
    },
  },
  diagnostics: {
    reviewPerformance() {},
    async audioEvent() {},
  },
  importer: webImportPort,
};