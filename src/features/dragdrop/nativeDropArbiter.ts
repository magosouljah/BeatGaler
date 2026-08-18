let lastNativeLibraryDropClaimAt = -Infinity;

/** Marks a local OS filesystem drop as owned by Tauri's native-path fast path. */
export function claimNativeLibraryDrop(now = performance.now()): void {
  lastNativeLibraryDropClaimAt = now;
}

/**
 * HTML5/WebView2 receives the same Windows drop as File objects. Give Tauri a
 * tiny window to claim it first so we do not copy every dropped byte into
 * drop-staging when native filesystem paths are already available.
 */
export async function waitForNativeLibraryDropClaim(
  htmlDropStartedAt: number,
  waitMs = 90,
): Promise<boolean> {
  const alreadyClaimed = lastNativeLibraryDropClaimAt >= htmlDropStartedAt - 120;
  if (alreadyClaimed) return true;

  await new Promise<void>(resolve => window.setTimeout(resolve, waitMs));
  return lastNativeLibraryDropClaimAt >= htmlDropStartedAt - 120;
}
