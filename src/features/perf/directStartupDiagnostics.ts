import { playTrace } from "../playback/playTrace";

const serverStages = new Set([
  "LEASE_SELECTED", "ACTIVATE_LEASE", "ACTIVATE_INVITE_PROMOTE", "ACTIVATE_MEMBERSHIP",
  ...["START_RUNTIME", "ACTIVATE_RUNTIME", "ACTIVATE_MASTER", "ACTIVATE_GET_ENTITY",
    "ACTIVATE_INVITE_PROMOTE", "ACTIVATE_GET_PARTICIPANT", "ACTIVATE_CLEANUP", "ACTIVATE_DISCONNECT"]
    .flatMap(stage => [`${stage}_BEGIN`, `${stage}_DONE`, `${stage}_ERROR`]),
]);

// This header is diagnostic data, never an input to session/lease decisions.
// Whitelist fields so even an unexpected server response cannot leak secrets.
export function readDirectStartupDiagnostics(raw: string | null) {
  if (!raw || raw.length > 12_000) return null;
  try {
    const value = JSON.parse(raw);
    if (!/^[a-f0-9-]{36}$/.test(value?.request_id) || !Array.isArray(value.events)) return null;
    const number = (input: unknown) => typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : undefined;
    return {
      server_request_id: value.request_id as string,
      server_elapsed_ms: number(value.elapsed_ms),
      server_dropped_events: number(value.dropped_events),
      server_outcome: value.outcome === "done" ? "done" : value.outcome === "error" ? "error" : "unknown",
      server_events: value.events.slice(0, 32).filter((event: any) => serverStages.has(event?.stage)).map((event: any) => ({
        stage: event.stage as string,
        t_ms: number(event.t_ms),
        elapsed_ms: number(event.elapsed_ms),
        server_lease: ["new", "reused"].includes(event.server_lease) ? event.server_lease : undefined,
        lease_state: ["ASSIGNING", "ACTIVE", "STOPPING"].includes(event.lease_state) ? event.lease_state : undefined,
        invite_promote_executed: typeof event.invite_promote_executed === "boolean" ? event.invite_promote_executed : undefined,
        membership_confirmed: typeof event.membership_confirmed === "boolean" ? event.membership_confirmed : undefined,
        attempt: number(event.attempt),
      })),
    };
  } catch { return null; }
}

export function reportDirectStartupDiagnostics(response: Response, requestKind: string): void {
  try {
    const diagnostic = readDirectStartupDiagnostics(response.headers?.get?.("X-BeatGaler-Startup-Trace") ?? null);
    playTrace("SERVER_SESSION_TRACE", { request_kind: requestKind, server_trace_available: diagnostic !== null, ...diagnostic });
  } catch { /* Optional diagnostics cannot alter the HTTP result. */ }
}

export function startupCacheContext(libraryCache: "hit" | "miss" | "invalid" | "unavailable_or_invalid") {
  let navigationType = "unknown";
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    navigationType = navigation?.type ?? "unknown";
  } catch { /* Missing timing APIs must not turn a usable library cache into a miss. */ }
  return {
    navigation_type: navigationType,
    startup_type: navigationType === "reload" ? "reload"
      : libraryCache === "hit" ? "warm" : libraryCache === "miss" ? "cold" : "unknown",
  };
}
