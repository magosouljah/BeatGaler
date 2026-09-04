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
import { WebPlaybackSourceManager } from "../features/playback/webPlaybackSource";
import {
  installBeatCardWarmObserver,
  type BeatCardWarmPriority,
} from "../features/playback/webVisiblePlaybackPrefetch";
import { playTrace, observePlayStep } from "../features/playback/playTrace";
import { WebDownloadsManager } from "../features/downloads/webDownloads";

let webCloudTransport: Promise<import("../features/cloud/webGalerCloudTransport").WebGalerCloudTransport> | null = null;
let webLibraryWindow: WebLibraryWindowConsumer | null = null;
let webPlaybackSources: WebPlaybackSourceManager | null = null;
let webDownloads: WebDownloadsManager | null = null;
const webBeatRegistry = new Map<string, Beat>();
// Cloud routing is a startup hint that may be newer than the presentation cache.
// Keep it separate from Beat metadata and discard it as soon as Telegram's
// authoritative manifest materializes the beat again.
const webStartupRouteOverrides = new Map<string, number>();
let stopVisiblePlaybackObserver: (() => void) | null = null;
let stopPlaybackRuntimeObserver: (() => void) | null = null;

const WEB_PRESENTATION_LIBRARY_CACHE_KEY = "beatvault:library:v1";
const WEB_PRESENTATION_SORT_CACHE_KEY = "beatvault:sort:v2";
const WEB_STARTUP_WARM_BEATS = 14;

type StartupPresentationCandidate = {
  beat: Beat;
  beatId: string;
  messageId: number;
  mimeType: string;
};

async function resolveWebCloudTransport() {
  if (!webCloudTransport) {
    webCloudTransport = observePlayStep("DIRECT_CODE_IMPORT", () => import("../features/cloud/webGalerCloudTransport"))
      .then(({ WebGalerCloudTransport }) => new WebGalerCloudTransport());
  }
  return webCloudTransport;
}

function directMessageId(value: string | null | undefined): number | null {
  const match = /^direct:(\d+)$/.exec(String(value || "").trim());
  const messageId = Number(match?.[1] || 0);
  return Number.isInteger(messageId) && messageId > 0 ? messageId : null;
}

function webBeatMessageId(beat: Beat): number | null {
  const startupRoute = webStartupRouteOverrides.get(beat.id);
  if (startupRoute) return startupRoute;
  const explicit = Number(beat.telegram_message_id || 0);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return directMessageId(beat.assets?.master?.object_id) || directMessageId(beat.telegram_file_id);
}

function readStartupPresentationCandidates(): StartupPresentationCandidate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(WEB_PRESENTATION_LIBRARY_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const beats = parsed.filter((value): value is Beat => Boolean(value && typeof value === "object" && String(value.id || "").trim()));
    const manualIndex = new Map(beats.map((beat, index) => [beat.id, index]));
    const sortBy = String(window.localStorage.getItem(WEB_PRESENTATION_SORT_CACHE_KEY) || "rating");
    const ordered = beats.slice().sort((a, b) => {
      if (sortBy === "manual") return (manualIndex.get(a.id) ?? 0) - (manualIndex.get(b.id) ?? 0);
      if (sortBy === "bpm") return Number(a.bpm || 0) - Number(b.bpm || 0);
      if (sortBy === "name") return a.name.localeCompare(b.name);
      const ratingDiff = Number(b.rating || 0) - Number(a.rating || 0);
      return ratingDiff || (manualIndex.get(a.id) ?? 0) - (manualIndex.get(b.id) ?? 0);
    });
    const output: StartupPresentationCandidate[] = [];
    for (const beat of ordered) {
      const messageId = webBeatMessageId(beat);
      if (!messageId) continue;
      output.push({
        beat,
        beatId: beat.id,
        messageId,
        mimeType: beat.assets?.master?.mime_type || "audio/mpeg",
      });
      if (output.length >= WEB_STARTUP_WARM_BEATS) break;
    }
    return output;
  } catch {
    return [];
  }
}

function prewarmAuthenticatedWebTransport(): void {
  if (typeof window === "undefined") return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;

  try {
    if (window.localStorage.getItem("beatgaler:web-session-present:v1") !== "1") return;
  } catch {
    return;
  }

  const candidates = readStartupPresentationCandidates();
  rememberWebBeats(candidates.map(candidate => candidate.beat));
  playTrace("ADAPTER_TRANSPORT_PREWARM_BEGIN", { startup_beat_count: candidates.length });
  void resolveWebCloudTransport().then(async transport => {
    if (candidates.length === 0) {
      playTrace("ADAPTER_TRANSPORT_CODE_PREWARM_ONLY");
      return;
    }
    await transport.startStartupWarm(
      candidates.map(({ beatId, messageId, mimeType }) => ({ beatId, messageId, mimeType })),
      async routed => {
        // Cloud may know a newer MASTER than the presentation cache. Every
        // startup playback/warm lookup must use the same routed id until the
        // Telegram reconcile replaces the cached Beat objects.
        for (const candidate of routed) {
          webStartupRouteOverrides.set(candidate.beatId, candidate.messageId);
        }
        const sources = await resolveWebPlaybackSources();
        const results = await Promise.allSettled(routed.map(candidate =>
          sources.prefetch(candidate.beatId, candidate.messageId, candidate.mimeType, "visible")
        ));
        playTrace("ADAPTER_STARTUP_WARM_SETTLED", {
          count: routed.length,
          failures: results.filter(result => result.status === "rejected").length,
        });
      },
    );
    playTrace("ADAPTER_TRANSPORT_PREWARM_DISPATCHED", { startup_beat_count: candidates.length });
  }).catch(error => playTrace("ADAPTER_TRANSPORT_PREWARM_DEFERRED", {
    error_name: error instanceof Error ? error.name : "unknown",
  }));
}

async function resolveWebLibraryWindow(): Promise<WebLibraryWindowConsumer> {
  if (!webLibraryWindow) webLibraryWindow = new WebLibraryWindowConsumer(await resolveWebCloudTransport());
  return webLibraryWindow;
}

async function updateBeatWarmPriority(beatId: string, priority: BeatCardWarmPriority): Promise<void> {
  if (priority !== "far" && typeof navigator !== "undefined" && navigator.onLine === false) return;
  const beat = webBeatRegistry.get(beatId);
  if (!beat) return;
  const messageId = webBeatMessageId(beat);
  if (!messageId) return;
  if (priority === "far" && !webPlaybackSources) return;
  const mimeType = beat.assets?.master?.mime_type || "audio/mpeg";
  try {
    const sources = await resolveWebPlaybackSources();
    sources.setPrefetchPriority(beat.id, messageId, mimeType, priority);
  } catch (error) {
    playTrace("ADAPTER_WARM_PRIORITY_DEFERRED", {
      beat_id: beat.id,
      message_id: messageId,
      priority,
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }
}

function ensureVisiblePlaybackObserver(): void {
  if (stopVisiblePlaybackObserver || typeof window === "undefined") return;
  stopVisiblePlaybackObserver = installBeatCardWarmObserver((beatId, priority) => {
    playTrace("ADAPTER_CARD_WARM_PRIORITY", { beat_id: beatId, priority });
    void updateBeatWarmPriority(beatId, priority);
  });
}

function ensurePlaybackRuntimeObserver(): void {
  if (stopPlaybackRuntimeObserver || typeof window === "undefined") return;
  const listener = (message: Event) => {
    const detail = (message as CustomEvent<{
      beatId?: string | null;
      currentTime?: number;
      playing?: boolean;
      waiting?: boolean;
    }>).detail;
    const beatId = String(detail?.beatId || "").trim();
    if (!beatId) return;
    webPlaybackSources?.updatePlaybackState({
      beatId,
      currentTime: Math.max(0, Number(detail?.currentTime) || 0),
      playing: Boolean(detail?.playing),
      waiting: Boolean(detail?.waiting),
    });
  };
  window.addEventListener("beatgaler:web-playback-state", listener);
  stopPlaybackRuntimeObserver = () => window.removeEventListener("beatgaler:web-playback-state", listener);
}

function rememberWebBeats(beats: readonly Beat[]): void {
  for (const beat of beats) webBeatRegistry.set(beat.id, beat);
  stopVisiblePlaybackObserver?.();
  stopVisiblePlaybackObserver = null;
  ensureVisiblePlaybackObserver();
}

function forgetWebBeats(ids: readonly string[]): void {
  for (const id of ids) {
    webBeatRegistry.delete(id);
    webStartupRouteOverrides.delete(id);
  }
}

function resetVisiblePlaybackPrefetch(): void {
  stopVisiblePlaybackObserver?.();
  stopVisiblePlaybackObserver = null;
  stopPlaybackRuntimeObserver?.();
  stopPlaybackRuntimeObserver = null;
  webBeatRegistry.clear();
  webStartupRouteOverrides.clear();
}

function reportLibraryWindow(page: WebLibraryWindowSnapshot, reason: string): void {
  // This page came from the Telegram authoritative INDEX, so its MASTER ids
  // supersede any temporary Cloud startup routing hints.
  for (const beat of page.beats) webStartupRouteOverrides.delete(beat.id);
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
  if (!webPlaybackSources) {
    webPlaybackSources = new WebPlaybackSourceManager(transport);
    ensurePlaybackRuntimeObserver();
  }
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
      webStartupRouteOverrides.delete(restored.id);
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
    async status() { return webPlaybackSources?.cacheStatus() ?? { used_bytes: 0, limit_mb: 100 }; },
    async setLimitMb(limitMb) {
      if (!webPlaybackSources) return { used_bytes: 0, limit_mb: Math.max(0, Math.round(limitMb)) };
      return webPlaybackSources.setCacheLimitMb(limitMb);
    },
    async clear() { return webPlaybackSources?.clearCache() ?? { used_bytes: 0, limit_mb: 100 }; },
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
      if (messageId) {
        playTrace("ADAPTER_PREPARE_ENTER", { beat_id: beat.id, message_id: messageId, mime_type: master?.mime_type || "audio/mpeg" });
        const sources = await resolveWebPlaybackSources();
        playTrace("ADAPTER_SOURCE_MANAGER_READY", { beat_id: beat.id });
        const prepared = await sources.prepare(beat.id, messageId, master?.mime_type || "audio/mpeg");
        playTrace("ADAPTER_PREPARE_READY", { beat_id: beat.id });
        return prepared;
      }
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
        webStartupRouteOverrides.delete(committed.id);
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
        webStartupRouteOverrides.delete(committed.id);
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
