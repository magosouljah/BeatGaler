import { WEB_FOUNDATION_CAPABILITIES } from "./capabilities";
import type { PlatformAdapter, PlatformEventHandler, PlatformUnlisten } from "./contracts";
import { getWebClientId } from "./webClientId";
import { pickWebSlotFile, webImportPort } from "./webImport";
import { playTrace } from "../features/playback/playTrace";
import {
  beginWebPlaybackIntent,
  invalidateAllWebPlaybackIntents,
  invalidateWebPlaybackIntentForBeat,
  rememberPreparedWebPlaybackUrl,
} from "../features/playback/webPlaybackIntent";

const WEB_INCOMPLETE_WARNINGS_KEY = "beatgaler:web-incomplete-warnings:v1"; const WEB_CUSTOM_CURSOR_KEY = "beatgaler:web-custom-cursor:v1";
function readBooleanPreference(key: string, fallback: boolean): boolean { try { const value = window.localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; } }
function writeBooleanPreference(key: string, value: boolean): void { try { window.localStorage.setItem(key, String(value)); } catch {} }
function unavailable(feature: string): never { throw new Error(`${feature} is not available in BeatGaler Web yet.`); }
const webClientId = getWebClientId();

export const webAdapter: PlatformAdapter = {
  kind: "web", capabilities: WEB_FOUNDATION_CAPABILITIES, clientId: webClientId,
  // The Web Gallery uses the PostgreSQL catalog. These ports satisfy the shared platform contract.
  library: {
    async load() { throw new Error("Galer Cloud could not load your library. Please retry."); },
    async restoreAuthoritative() { return unavailable("Galer Cloud library refresh"); },
    async commitSnapshot() { return unavailable("Galer Cloud library writes"); },
  },
  preferences: {
    async load() { return { beats_folder: null, incomplete_warnings_enabled: readBooleanPreference(WEB_INCOMPLETE_WARNINGS_KEY, true), custom_cursor_enabled: readBooleanPreference(WEB_CUSTOM_CURSOR_KEY, true), beatgaler_user_id: webClientId, telegram_cloud_connected: true, telegram_cloud_username: null }; },
    async setIncompleteWarnings(enabled) { writeBooleanPreference(WEB_INCOMPLETE_WARNINGS_KEY, enabled); }, async setCustomCursor(enabled) { writeBooleanPreference(WEB_CUSTOM_CURSOR_KEY, enabled); },
  },
  trash: {
    async moveBeats() { return unavailable("Galer Cloud trash"); },
    async listBeats() { return unavailable("Galer Cloud trash"); },
    async restoreBeat() { return unavailable("Galer Cloud trash"); },
    async purgeBeats() { return unavailable("Galer Cloud trash"); },
    async listPresets() { return []; },
    async restorePreset() { return unavailable("Preset restore"); },
    async purgePresets() { return unavailable("Preset deletion"); },
  },
  playbackCache: {
    async status() { return { used_bytes: 0, limit_mb: 100 }; },
    async setLimitMb(limitMb) { return { used_bytes: 0, limit_mb: Math.max(0, Math.round(limitMb)) }; },
    async clear() { return { used_bytes: 0, limit_mb: 100 }; },
  },
  system: { async getLogDirectory() { return ""; }, async getTemplatesDirectory() { return ""; }, async revealPath(path) { void path; return unavailable("Local file reveal"); }, async checkForUpdate() { return unavailable("Native app updates"); }, async installUpdate() { return unavailable("Native app updates"); } },
  media: {
    resolveUrl(source) { return source; },
    async preparePlayback(beat) {
      const intent = beginWebPlaybackIntent(beat.id);
      if (beat.playback_path.startsWith("blob:")) {
        playTrace("ADAPTER_LOCAL_BLOB", { beat_id: beat.id, intent_id: intent.id });
        rememberPreparedWebPlaybackUrl(beat.playback_path, intent);
        return { url: beat.playback_path, completed: Promise.resolve() };
      }
      throw new Error("This MASTER must be migrated before it can play on Web.");
    },
    async loadArtwork() { return null; },
    releasePlayback(beatId) { invalidateWebPlaybackIntentForBeat(beatId); },
  },
  events: { async listen<T>(event: string, handler: PlatformEventHandler<T>): Promise<PlatformUnlisten> { const listener = (message: Event) => handler((message as CustomEvent<T>).detail); window.addEventListener(event, listener); return () => window.removeEventListener(event, listener); } },
  external: { async openUrl(url) { window.open(url, "_blank", "noopener,noreferrer"); } },
  account: { async getInstallationId() { return webClientId; } },
  cloudData: {
    async commitImportedBeat() { return unavailable("Galer Cloud import"); },
    async disconnect() { invalidateAllWebPlaybackIntents(); },
  },
  downloads: {
    start() { return unavailable("Galer Cloud downloads"); },
  },
  editor: {
    pickFile: pickWebSlotFile,
    async commit() { return unavailable("Galer Cloud edits"); },
  },
  cloudAuth: { async syncSession() {} },
  diagnostics: { reviewPerformance() {}, async audioEvent() {} },
  importer: webImportPort,
};
