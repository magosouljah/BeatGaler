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
};
