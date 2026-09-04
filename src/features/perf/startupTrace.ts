import { traceClock } from "./traceClock";
import { playTrace } from "../playback/playTrace";

export type StartupSurface =
  | "startup_loader"
  | "auth_restore"
  | "auth_screen"
  | "library_loading"
  | "library_cards"
  | "empty_gallery"
  | "library_shell"
  | "unknown";

export type StartupTraceEvent = {
  seq: number;
  t_ms: number;
  nav_t_ms?: number;
  ts_ms?: number;
  time_origin_ms?: number;
  context_id?: string;
  kind: "lifecycle" | "surface" | "card_count";
  surface?: StartupSurface;
  card_count?: number;
  reason?: string;
  detail?: string;
};

type StartupSnapshot = {
  surface: StartupSurface;
  cardCount: number;
  detail?: string;
};

declare global {
  interface Window {
    __BEATGALER_STARTUP_TRACE__?: StartupTraceEvent[];
    beatgalerStartupTrace?: () => StartupTraceEvent[];
  }
}

const traceStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
let installed = false;
let sequence = 0;
let lastSurface: StartupSurface | null = null;
let lastSurfaceDetail = "";
let lastCardCount = -1;
let samplePending = false;

function elapsedMs(): number {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  return Math.round((now - traceStartedAt) * 10) / 10;
}

function safeDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || undefined;
}

function record(event: Omit<StartupTraceEvent, "seq" | "t_ms">): void {
  if (typeof window === "undefined") return;
  const clock = traceClock();
  const entry: StartupTraceEvent = {
    ...clock,
    nav_t_ms: clock.t_ms,
    seq: ++sequence,
    t_ms: elapsedMs(),
    ...event,
    detail: safeDetail(event.detail),
  };
  const trace = window.__BEATGALER_STARTUP_TRACE__ ?? (window.__BEATGALER_STARTUP_TRACE__ = []);
  trace.push(entry);
  console.info(`[startup-trace] ${JSON.stringify(entry)}`);
}

function nodeText(root: ParentNode): string {
  return root instanceof Document
    ? (root.body?.textContent ?? "")
    : ((root as HTMLElement).textContent ?? "");
}

export function readStartupSnapshot(root: ParentNode = document): StartupSnapshot {
  const query = (selector: string) => root.querySelector(selector);
  const cardCount = root.querySelectorAll("[data-beat-card-id]").length;

  if (query("#beatgaler-startup-loader")) {
    return { surface: "startup_loader", cardCount };
  }

  const authLoading = query(".bg-auth-card--loading");
  if (authLoading) {
    return { surface: "auth_restore", cardCount };
  }

  const authShell = query(".bg-auth-shell");
  if (authShell) {
    const title = authShell.querySelector("#beatgaler-auth-title")?.textContent ?? undefined;
    return { surface: "auth_screen", cardCount, detail: title };
  }

  const libraryLoading = query('[aria-label="Loading beat library"]');
  if (libraryLoading) {
    return { surface: "library_loading", cardCount };
  }

  if (cardCount > 0) {
    return { surface: "library_cards", cardCount };
  }

  if (nodeText(root).includes("Empty Gallery")) {
    return { surface: "empty_gallery", cardCount };
  }

  if (query('[data-library-scroll="true"]')) {
    return { surface: "library_shell", cardCount };
  }

  return { surface: "unknown", cardCount };
}

function sample(reason: string): void {
  if (typeof document === "undefined") return;
  const snapshot = readStartupSnapshot(document);
  const detail = safeDetail(snapshot.detail) ?? "";

  if (snapshot.surface !== lastSurface || detail !== lastSurfaceDetail) {
    lastSurface = snapshot.surface;
    lastSurfaceDetail = detail;
    record({
      kind: "surface",
      surface: snapshot.surface,
      card_count: snapshot.cardCount,
      reason,
      detail: snapshot.detail,
    });
  }

  if (snapshot.cardCount !== lastCardCount) {
    lastCardCount = snapshot.cardCount;
    record({
      kind: "card_count",
      surface: snapshot.surface,
      card_count: snapshot.cardCount,
      reason,
    });
  }
}

function scheduleSample(reason: string): void {
  if (samplePending) return;
  samplePending = true;
  queueMicrotask(() => {
    samplePending = false;
    sample(reason);
  });
}

function runtimeKind(): string {
  if (typeof window === "undefined") return "unknown";
  const tauri = Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);
  return tauri ? "desktop" : "web";
}

export function installStartupTrace(): void {
  if (installed || typeof window === "undefined" || typeof document === "undefined") return;
  installed = true;
  window.__BEATGALER_STARTUP_TRACE__ = [];
  window.beatgalerStartupTrace = () => (window.__BEATGALER_STARTUP_TRACE__ ?? []).map(entry => ({ ...entry }));

  const navigation = typeof performance !== "undefined"
    ? performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
    : undefined;
  let sessionMarker: boolean | null = null;
  try { sessionMarker = window.localStorage.getItem("beatgaler:web-session-present:v1") === "1"; } catch {}
  playTrace("APP_START", {
    runtime: runtimeKind(), navigation_type: navigation?.type ?? "unknown",
    remembered_session_marker: sessionMarker,
  });
  record({
    kind: "lifecycle",
    reason: "app_entry",
    detail: `runtime=${runtimeKind()} nav=${navigation?.type ?? "unknown"}`,
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      record({ kind: "lifecycle", reason: "dom_content_loaded" });
      scheduleSample("dom_content_loaded");
    }, { once: true });
  } else {
    record({ kind: "lifecycle", reason: "dom_already_ready" });
  }

  window.addEventListener("load", () => {
    record({ kind: "lifecycle", reason: "window_load" });
    scheduleSample("window_load");
  }, { once: true });

  window.addEventListener("pageshow", () => {
    record({ kind: "lifecycle", reason: "pageshow" });
    scheduleSample("pageshow");
  }, { once: true });

  const observer = new MutationObserver(() => scheduleSample("dom_mutation"));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "aria-label", "data-beat-card-id", "data-library-scroll"],
  });

  scheduleSample("install");
}
