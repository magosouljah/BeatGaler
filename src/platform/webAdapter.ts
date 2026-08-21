import { WEB_FOUNDATION_CAPABILITIES } from "./capabilities";
import type { PlatformAdapter, PlatformEventHandler, PlatformUnlisten } from "./contracts";
import { webImportPort } from "./webImport";

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
    // Galer Cloud library support is implemented in the next Web phase.
    async load() { return []; },
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
    async listBeats() { return []; },
    async restoreBeat() { return unavailable("Trash restore"); },
    async purgeBeats() { return unavailable("Trash deletion"); },
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
  cloudAuth: {
    // The browser already sends its account token to the control plane.
    // Direct Galer Cloud transport receives its own session envelope later.
    async syncSession() {},
  },
  diagnostics: {
    reviewPerformance() {},
  },
  importer: webImportPort,
};
