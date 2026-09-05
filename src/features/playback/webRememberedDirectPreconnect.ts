import { hasRememberedWebSessionMarker, readWebCsrfToken } from "../auth/webSessionBootstrap";
import { playTrace } from "./playTrace";
import { getWebStartupPlaybackCoordinator } from "./webStartupPlaybackCoordinator";

export function preconnectRememberedWebDirect(): void {
  if (typeof window === "undefined") return;
  // The entrypoint is shared by Web and Tauri. Never construct the browser
  // Direct transport from a Desktop runtime.
  if (Boolean((window as any).__TAURI_INTERNALS__)) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (!hasRememberedWebSessionMarker()) return;

  // /transport/session/start is unsafe and still needs persisted CSRF material.
  // Account restore remains parallel; it is no longer a Direct gate.
  if (!readWebCsrfToken()) {
    playTrace("DIRECT_REMEMBERED_PRECONNECT_DEFERRED", { reason: "csrf_unavailable" });
    return;
  }

  playTrace("DIRECT_REMEMBERED_PRECONNECT_BEGIN");
  // getWebStartupPlaybackCoordinator() and start() are invoked synchronously by
  // the entrypoint. Network completion remains fire-and-forget so React render
  // never waits for Direct.
  const coordinator = getWebStartupPlaybackCoordinator();
  void coordinator.start().then(
    () => playTrace("DIRECT_REMEMBERED_PRECONNECT_DISPATCHED"),
    error => playTrace("DIRECT_REMEMBERED_PRECONNECT_DEFERRED", {
      reason: "dispatch_failed",
      error_name: error instanceof Error ? error.name : "unknown",
    }),
  );
}
