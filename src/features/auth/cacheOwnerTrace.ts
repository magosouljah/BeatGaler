import { playTrace } from "../playback/playTrace";

/** Local diagnostics for the identity boundary; never include beat metadata or credentials. */
export function traceCacheOwner(
  stage: "CACHE_OWNER_READ" | "CACHE_OWNER_ACCEPT" | "CACHE_OWNER_REJECT",
  cacheKind: "library" | "playback_routing",
  ownerUserId: string | null,
  confirmedUserId: string | null,
  reason?: string,
): void {
  if (!import.meta.env.DEV) return;
  playTrace(stage, {
    cache_kind: cacheKind,
    owner_user_id: ownerUserId,
    confirmed_user_id: confirmedUserId,
    ...(reason ? { reason } : {}),
  });
}
