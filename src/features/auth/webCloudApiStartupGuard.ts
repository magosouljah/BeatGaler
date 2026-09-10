const CLOUD_API_STORAGE_KEY = "beatgaler:cloud-api:v1";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/**
 * Browser auth is origin-bound. Old development builds could persist a direct
 * loopback Cloud URL (for example http://127.0.0.1:4000) while the Web app now
 * talks through the same-origin /beatgaler-api proxy. Migrate that stale choice
 * before auth restore, Direct preconnect, events, or INDEX startup can reuse it.
 */
export function normalizeRememberedWebCloudApi(): string | null {
  if (typeof window === "undefined") return null;
  if ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return null;

  const remembered = window.localStorage.getItem(CLOUD_API_STORAGE_KEY);
  if (!remembered) return null;

  let parsed: URL;
  try {
    parsed = new URL(remembered);
  } catch {
    return remembered;
  }

  if (!isLoopbackHost(parsed.hostname) || parsed.origin === window.location.origin) return remembered;

  const sameOriginProxy = `${window.location.origin}/beatgaler-api`;
  window.localStorage.setItem(CLOUD_API_STORAGE_KEY, sameOriginProxy);
  return sameOriginProxy;
}
