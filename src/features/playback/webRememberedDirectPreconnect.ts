import { hasRememberedWebSessionMarker, readWebCsrfCookieToken } from "../auth/webSessionBootstrap";
import { playTrace } from "./playTrace";
import { getWebStartupPlaybackCoordinator } from "./webStartupPlaybackCoordinator";

// Keep the established startup-contract name while making its source explicit:
// the remembered preconnect may use only the current-origin cookie token.
const readWebCsrfToken = readWebCsrfCookieToken;

export function preconnectRememberedWebDirect(): void {
  if (typeof window === "undefined") return;
  // The entrypoint is shared by Web and Tauri. Never construct the browser
  // Direct transport from a Desktop runtime.
  if (Boolean((window as any).__TAURI_INTERNALS__)) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (!hasRememberedWebSessionMarker()) return;

  // The remembered marker and sessionStorage can outlive an API-origin change.
  // Only a CSRF cookie visible to the current Web origin proves that the early
  // Direct request can accompany the browser cookie session. Account restore
  // remains parallel and can repair/refresh CSRF when preconnect is deferred.
  if (!readWebCsrfToken()) {
    playTrace("DIRECT_REMEMBERED_PRECONNECT_DEFERRED", { reason: "csrf_unavailable" });
    return;
  }

  playTrace("DIRECT_REMEMBERED_PRECONNECT_BEGIN");
  playTrace("PREFETCH_START", { phase: "transport" });
  // The cookie may establish a Direct session, but no local beat or route is
  // selected until /auth/session confirms user.id.
  const coordinator = getWebStartupPlaybackCoordinator();
  const startup = coordinator.prepareConnection();
  playTrace("DIRECT_REMEMBERED_PRECONNECT_DISPATCHED");
  void startup.catch(error => playTrace("DIRECT_REMEMBERED_PRECONNECT_DEFERRED", {
    reason: "dispatch_failed",
    error_name: error instanceof Error ? error.name : "unknown",
  }));
}

/** Prepare the client and API origin while /auth/login establishes its cookie. */
export function prepareWebDirectForSignIn(): void {
  if (typeof window === "undefined" || Boolean((window as any).__TAURI_INTERNALS__)) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  playTrace("DIRECT_SIGN_IN_PRECONNECT_BEGIN");
  void getWebStartupPlaybackCoordinator().prepareSignIn().catch(error => playTrace("DIRECT_SIGN_IN_PRECONNECT_DEFERRED", {
    error_name: error instanceof Error ? error.name : "unknown",
  }));
}
