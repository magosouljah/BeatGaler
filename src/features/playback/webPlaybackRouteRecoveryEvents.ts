export const WEB_PLAYBACK_ROUTE_RECOVERY_EVENT = "beatgaler:web-playback-route-recovery";

export type WebPlaybackRouteRecoveryPhase = "begin" | "ready" | "failed";

export interface WebPlaybackRouteRecoveryDetail {
  beatId: string;
  phase: WebPlaybackRouteRecoveryPhase;
  url?: string;
}

export function publishWebPlaybackRouteRecovery(detail: WebPlaybackRouteRecoveryDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WEB_PLAYBACK_ROUTE_RECOVERY_EVENT, { detail }));
}
