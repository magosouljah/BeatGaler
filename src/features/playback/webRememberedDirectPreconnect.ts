import { hasRememberedWebSessionMarker, readWebCsrfCookieToken } from "../auth/webSessionBootstrap";
import { playTrace } from "./playTrace";
import { getWebStartupPlaybackCoordinator } from "./webStartupPlaybackCoordinator";

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
  if (!readWebCsrfCookieToken()) {
    playTrace("DIRECT_REMEMBERED_PRECONNECT_DEFERRED", { reason: "csrf_unavailable" });
    return;
  }

  playTrace("DIRECT_REMEMBERED_PRECONNECT_BEGIN");
  // getWebStartupPlaybackCoordinator() and start() are invoked synchronously by
  // the entrypoint. Network completion remains fire-and-forget so React render
  // never waits for Direct.
  const coordinator = getWebStartupPlaybackCoordinator();
  const startup = coordinator.start();
  playTrace("DIRECT_REMEMBERED_PRECONNECT_DISPATCHED");
  void startup.catch(error => playTrace("DIRECT_REMEMBERED_PRECONNECT_DEFERRED", {
    reason: "dispatch_failed",
    error_name: error instanceof Error ? error.name : "unknown",
  }));
}
