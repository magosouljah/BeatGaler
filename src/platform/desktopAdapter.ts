import { filePathToUrl, getCloudClientId, loadLibrary, loadOfflineLibrary } from "../lib/tauri";
import { DESKTOP_CAPABILITIES } from "./capabilities";
import type { PlatformAdapter, PlatformEventHandler, PlatformUnlisten } from "./contracts";

export const desktopAdapter: PlatformAdapter = {
  kind: "desktop",
  capabilities: DESKTOP_CAPABILITIES,
  clientId: getCloudClientId(),
  library: {
    load: loadLibrary,
    loadOffline: loadOfflineLibrary,
    async restoreAuthoritative() {
      const { restoreLibraryFromTelegram } = await import("../lib/tauri");
      await restoreLibraryFromTelegram();
    },
    async commitSnapshot(beats) {
      const { syncCloudLibraryIndex } = await import("../lib/tauri");
      return syncCloudLibraryIndex(beats);
    },
    async flushOfflineTrashIntents() {
      const { flushOfflineTrashIntents } = await import("../lib/tauri");
      return flushOfflineTrashIntents();
    },
  },
  preferences: {
    async load() {
      const { getSettings } = await import("../lib/tauri");
      return getSettings();
    },
    async setIncompleteWarnings(enabled) {
      const { setIncompleteWarningsEnabled } = await import("../lib/tauri");
      await setIncompleteWarningsEnabled(enabled);
    },
    async setCustomCursor(enabled) {
      const { setCustomCursorEnabled } = await import("../lib/tauri");
      await setCustomCursorEnabled(enabled);
    },
  },
  trash: {
    async listBeats() { const { listTrash } = await import("../lib/tauri"); return listTrash(); },
    async restoreBeat(id) { const { restoreBeatFromTrash } = await import("../lib/tauri"); return restoreBeatFromTrash(id); },
    async purgeBeats() { const { purgeTrashNow } = await import("../lib/tauri"); return purgeTrashNow(); },
    async listPresets() { const { listTemplateTrash } = await import("../lib/tauri"); return listTemplateTrash(); },
    async restorePreset(id) { const { restoreTemplateFromTrash } = await import("../lib/tauri"); await restoreTemplateFromTrash(id); },
    async purgePresets() { const { purgeTemplateTrashNow } = await import("../lib/tauri"); return purgeTemplateTrashNow(); },
  },
  playbackCache: {
    async status() { const { getPlaybackCacheStatus } = await import("../lib/tauri"); return getPlaybackCacheStatus(); },
    async setLimitMb(limitMb) { const { setPlaybackCacheLimitMb } = await import("../lib/tauri"); return setPlaybackCacheLimitMb(limitMb); },
    async clear() { const { clearPlaybackCache } = await import("../lib/tauri"); return clearPlaybackCache(); },
  },
  system: {
    async getLogDirectory() { const { getLogDir } = await import("../lib/tauri"); return getLogDir(); },
    async getTemplatesDirectory() { const { getTemplatesDir } = await import("../lib/tauri"); return getTemplatesDir(); },
    async revealPath(path) { const { revealInExplorer } = await import("../lib/tauri"); await revealInExplorer(path); },
    async checkForUpdate() { const { checkForAppUpdate } = await import("../lib/tauri"); return checkForAppUpdate(); },
    async installUpdate() { const { installAppUpdate } = await import("../lib/tauri"); await installAppUpdate(); },
  },
  startup: {
    async loadAuthenticatedShell() { return null; },
  },
  media: {
    resolveUrl: filePathToUrl,
  },
  events: {
    async listen<T>(event: string, handler: PlatformEventHandler<T>): Promise<PlatformUnlisten> {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<T>(event, message => handler(message.payload));
    },
  },
  external: {
    async openUrl(url) {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    },
  },
  account: {
    async getInstallationId() {
      const { invoke } = await import("@tauri-apps/api/core");
      let settings = await invoke<{ beatgaler_user_id?: string | null }>("get_settings");
      if (settings?.beatgaler_user_id) return String(settings.beatgaler_user_id);
      try { await invoke("poll_telegram_cloud_status"); } catch {}
      settings = await invoke<{ beatgaler_user_id?: string | null }>("get_settings");
      if (!settings?.beatgaler_user_id) {
        throw new Error("BeatGaler could not create its installation ID.");
      }
      return String(settings.beatgaler_user_id);
    },
  },
  cloud: {
    async status() {
      const { pollTelegramCloudStatus } = await import("../lib/tauri");
      return pollTelegramCloudStatus();
    },
  },
  cloudAuth: {
    async syncSession(token, cloudApiBase) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_cloud_auth_token", { token, cloudApiBase });
    },
  },
  diagnostics: {
    reviewPerformance(message) {
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("review_perf_log", { message }))
        .catch(() => {});
    },
  },
  importer: {
    async pickBeat() { return null; },
    fromFile() { throw new Error("Browser File import is not available in BeatGaler Desktop."); },
    fileForBeat() { return null; },
    releaseBeat() {},
  },
};
