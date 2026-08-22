import { WEB_FOUNDATION_CAPABILITIES } from "./capabilities";
import type { PlatformAdapter, PlatformEventHandler, PlatformUnlisten } from "./contracts";
import { pickWebSlotFile, webImportPort } from "./webImport";
import { loadWebLibrary } from "../features/library/webLibrary";
import { WebPlaybackSourceManager } from "../features/playback/webPlaybackSource";
import { WebDownloadsManager } from "../features/downloads/webDownloads";

let webCloudTransport: Promise<import("../features/cloud/webGalerCloudTransport").WebGalerCloudTransport> | null = null;
let webPlaybackSources: WebPlaybackSourceManager | null = null;
let webDownloads: WebDownloadsManager | null = null;

async function resolveWebCloudTransport() {
  if (!webCloudTransport) {
    webCloudTransport = import("../features/cloud/webGalerCloudTransport")
      .then(({ WebGalerCloudTransport }) => new WebGalerCloudTransport());
  }
  return webCloudTransport;
}

async function resolveWebPlaybackSources(): Promise<WebPlaybackSourceManager> {
  if (!webPlaybackSources) webPlaybackSources = new WebPlaybackSourceManager(await resolveWebCloudTransport());
  return webPlaybackSources;
}

function resolveWebDownloads(): WebDownloadsManager {
  if (!webDownloads) webDownloads = new WebDownloadsManager(resolveWebCloudTransport());
  return webDownloads;
}

function directMessageId(value: string | null | undefined): number | null {
  const match = /^direct:(\d+)$/.exec(String(value || "").trim());
  const messageId = Number(match?.[1] || 0);
  return Number.isInteger(messageId) && messageId > 0 ? messageId : null;
}

const WEB_CLIENT_ID_KEY = "beatgaler:web-client-id:v1";
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

function createClientId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `beatgaler-web-${suffix}`;
}

function resolveWebClientId(): string {
  if (typeof window === "undefined") return createClientId();
  try {
    const existing = window.localStorage.getItem(WEB_CLIENT_ID_KEY);
    if (existing) return existing;
    const created = createClientId();
    window.localStorage.setItem(WEB_CLIENT_ID_KEY, created);
    return created;
  } catch {
    return createClientId();
  }
}

export const webAdapter: PlatformAdapter = {
  kind: "web",
  capabilities: WEB_FOUNDATION_CAPABILITIES,
  clientId: resolveWebClientId(),
  library: {
    async load() {
      try {
        const transport = await resolveWebCloudTransport();
        return await loadWebLibrary(transport);
      } catch (error) {
        console.error("[web/library] authoritative load failed", error);
        throw new Error("Galer Cloud could not load your library. Please retry.");
      }
    },
    async loadOffline() { return []; },
    async restoreAuthoritative() {},
    async commitSnapshot() { return unavailable("Galer Cloud library writes"); },
    async flushOfflineTrashIntents() { return 0; },
  },
  preferences: {
    async load() {
      return {
        beats_folder: null,
        incomplete_warnings_enabled: readBooleanPreference(WEB_INCOMPLETE_WARNINGS_KEY, true),
        custom_cursor_enabled: readBooleanPreference(WEB_CUSTOM_CURSOR_KEY, true),
        beatgaler_user_id: webAdapter.clientId,
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
      return transport.moveBeatsToTrash(ids, webAdapter.clientId);
    },
    async listBeats() {
      const transport = await resolveWebCloudTransport();
      return transport.listTrashItems();
    },
    async restoreBeat(id) {
      const transport = await resolveWebCloudTransport();
      return transport.restoreBeatFromTrash(id, webAdapter.clientId);
    },
    async purgeBeats() {
      const transport = await resolveWebCloudTransport();
      return transport.purgeTrash(webAdapter.clientId);
    },
    async listPresets() { return []; },
    async restorePreset() { return unavailable("Preset restore"); },
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
    async revealPath() { return unavailable("Local file reveal"); },
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
      if (beat.playback_path.startsWith("blob:")) {
        return { url: beat.playback_path, completed: Promise.resolve() };
      }
      const master = beat.assets?.master;
      const messageId = beat.telegram_message_id || directMessageId(master?.object_id) || directMessageId(beat.telegram_file_id);
      if (!messageId) throw new Error("This MASTER must be migrated before it can play on Web.");
      const sources = await resolveWebPlaybackSources();
      return sources.prepare(beat.id, messageId, master?.mime_type || "audio/mpeg");
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
      return webAdapter.clientId;
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
        return await transport.commitImportedBeat(beat, {
          master,
          wav: slots.WAV,
          project: slots.PROJECT,
        }, webAdapter.clientId, onProgress);
      } catch (error) {
        console.error("[web/import] durable commit failed", error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("changed on another device")) throw new Error(message);
        throw new Error("Galer Cloud could not save this beat. Your file is still available for retry.");
      }
    },
    async disconnect() {
      webPlaybackSources?.releaseAll();
      webPlaybackSources = null;
      webDownloads?.cancelAll();
      webDownloads = null;
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
        return await transport.commitBeatEdit(original, updated, files, webAdapter.clientId, onProgress);
      } catch (error) {
        console.error("[web/edit] durable commit failed", error);
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("changed on another device") || message.includes("no longer in your")) throw new Error(message);
        throw new Error("Galer Cloud could not save these changes. Your selections are still available for retry.");
      }
    },
  },
  cloudAuth: {
    // The browser already sends its account token to the control plane.
    // Direct Galer Cloud transport receives its own session envelope later.
    async syncSession() {},
  },
  diagnostics: {
    reviewPerformance() {},
    async audioEvent() {},
  },
  importer: webImportPort,
};
