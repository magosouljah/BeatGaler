export const WEB_SESSION_MARKER_KEY = "beatgaler:web-session-present:v1";
export const WEB_CSRF_SESSION_KEY = "beatgaler:web-csrf:v1";
export const WEB_CSRF_COOKIE_NAME = "__Host-beatgaler_csrf";

export function hasRememberedWebSessionMarker(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(WEB_SESSION_MARKER_KEY) === "1";
  } catch {
    return false;
  }
}

export function readWebCookieValue(cookieHeader: string, name: string): string {
  const target = `${name}=`;
  for (const raw of String(cookieHeader || "").split(";")) {
    const item = raw.trim();
    if (!item.startsWith(target)) continue;
    const value = item.slice(target.length);
    try { return decodeURIComponent(value); }
    catch { return value; }
  }
  return "";
}

export function readWebCsrfToken(): string {
  // The cookie is what the browser actually presents to session-security, so it
  // is the authoritative CSRF value whenever it is readable. sessionStorage is
  // only a fallback for deployments where the API cookie is not visible to this
  // origin. This avoids selecting a stale cached token during parallel restore.
  if (typeof document !== "undefined") {
    try {
      const cookieToken = readWebCookieValue(document.cookie, WEB_CSRF_COOKIE_NAME);
      if (cookieToken) return cookieToken;
    } catch {}
  }
  if (typeof window !== "undefined") {
    try {
      return window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY) || "";
    } catch {
      return "";
    }
  }
  return "";
}
