import { invoke } from "@tauri-apps/api/core";

/**
 * Diagnostic-only bridge: mirrors Review performance markers into Rust stderr
 * so they appear in the same PowerShell window as `npm run tauri dev`.
 * Never await this from the import critical path.
 */
export function reviewPerfMark(message: string): void {
  const safe = String(message ?? "").replace(/[\r\n]+/g, " ").slice(0, 2000);
  console.info(`[review-diag] ${safe}`);
  void invoke("review_perf_log", { message: safe }).catch(() => {
    // Diagnostics must never change product behavior if logging is unavailable.
  });
}
