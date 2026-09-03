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
  if (typeof window !== "undefined") {
    try {
      const sessionToken = window.sessionStorage.getItem(WEB_CSRF_SESSION_KEY) || "";
      if (sessionToken) return sessionToken;
    } catch {}
  }
  if (typeof document === "undefined") return "";
  try {
    return readWebCookieValue(document.cookie, WEB_CSRF_COOKIE_NAME);
  } catch {
    return "";
  }
}
