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
};
