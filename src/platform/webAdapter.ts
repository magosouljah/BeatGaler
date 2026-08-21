import { WEB_FOUNDATION_CAPABILITIES } from "./capabilities";
import type { PlatformAdapter, PlatformEventHandler, PlatformUnlisten } from "./contracts";

const WEB_CLIENT_ID_KEY = "beatgaler:web-client-id:v1";

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
};
