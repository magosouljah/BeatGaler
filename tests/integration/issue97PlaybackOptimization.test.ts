import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 definitive Web startup + playback architecture", () => {
  it("keeps seven data lanes and exactly one 64 KiB startup prefix", () => {
    const protocol = source("src/features/cloud/webTransportWorkerProtocol.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(protocol).toContain("export const DEFAULT_PLAYBACK_DATA_LANES = 7;");
    expect(protocol).toContain("export const STARTUP_PREFIX_BYTES = 64 * 1024;");
    expect(protocol).toContain("export const WEB_PLAYBACK_PREFETCH_TARGET_SECONDS = Number.POSITIVE_INFINITY;");
    expect(protocol).toContain("export const WEB_PLAYBACK_PREFETCH_MAX_BYTES = STARTUP_PREFIX_BYTES;");
    expect(worker).toContain("const MAX_CONFIGURABLE_DATA_LANES = 16;");
    expect(worker).toContain("const desired = Math.min(STARTUP_PREFIX_BYTES");
    expect(worker).toContain("const limit = playbackChunkLimit(desired);");
  });

  it("persists an all-beat playback routing cache plus at most fourteen startup routes", () => {
    const routing = source("src/features/playback/webPlaybackRoutingCache.ts");

    expect(routing).toContain('WEB_PLAYBACK_ROUTING_CACHE_PREFIX = "beatgaler:web-playback-routing:v2:"');
    expect(routing).toContain("WEB_STARTUP_PLAYBACK_ROUTE_LIMIT = 14");
    expect(routing).toContain('type WebPlaybackSort = "rating" | "manual" | "bpm" | "name"');
    expect(routing).toContain("routes: Record<string, CachedPlaybackRoute>");
    expect(routing).toContain("startup: CachedStartupPlaybackRoute[]");
    expect(routing).toContain("updatePlaybackRoutingCacheFromManifest");
    expect(routing).toContain("updatePlaybackRoutingSort");
  });

  it("wires the real App caller to UI sort routing and authoritative reconcile", () => {
    const app = source("src/app/useBeatGalerComposition.ts").replaceAll("../", "./");
    const libraryViewState = source("src/features/library/useLibraryViewState.ts");

    expect(app).toContain('import { useLibraryViewState } from "./features/library/useLibraryViewState";');
    expect(app).toContain('import { useWebPlaybackSortRouting } from "./features/playback/useWebPlaybackSortRouting";');
    expect(app).toContain('import { useWebLibraryReconciled } from "./features/library/useWebLibraryReconciled";');
    expect(libraryViewState).toContain("const [sortBy, setSortBy] = useState<SortKey>(() => loadCachedSort());");
    expect(libraryViewState).toContain("saveCachedSort(sortBy);");

    const viewState = app.indexOf("const { search, setSearch, sortBy, setSortBy } = useLibraryViewState();");
    const sortRouting = app.indexOf('useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web");', viewState);
    const reconcileCallback = app.indexOf("const onWebLibraryReconciled = useCallback((incoming: Beat[]) => {", sortRouting);
    const mergeUploads = app.indexOf("const next = mergeActiveUploads(incoming, current, getActiveUploadIds());", reconcileCallback);
    const updateLatest = app.indexOf("beatsLatestRef.current = next;", mergeUploads);
    const reconcileHook = app.indexOf('useWebLibraryReconciled(platform.kind === "web", onWebLibraryReconciled);', updateLatest);

    expect(viewState).toBeGreaterThanOrEqual(0);
    expect(sortRouting).toBeGreaterThan(viewState);
    expect(reconcileCallback).toBeGreaterThan(sortRouting);
    expect(mergeUploads).toBeGreaterThan(reconcileCallback);
    expect(updateLatest).toBeGreaterThan(mergeUploads);
    expect(reconcileHook).toBeGreaterThan(updateLatest);
  });

  it("keeps login prewarm off public startup and Gallery mount", () => {
    const main = source("src/main.tsx");
    const experience = source("src/app/WebExperience.tsx");
    const galleryEntry = source("src/app/WebGalleryEntry.tsx");
    const workspace = source("src/app/WebGalleryWorkspace.tsx");
    const authGate = source("src/features/auth/AuthExperienceGate.tsx");
    const accountGate = source("src/components/AccountGate.tsx");

    expect(main).not.toContain("preconnectRememberedWebDirect();");
    expect(main).not.toContain("prewarmDirectRuntime");
    expect(main).not.toContain("platform.cloudAuth.syncSession(null, \"\")");
    expect(experience).toContain('path === "/" ? <LandingPage />');
    expect(galleryEntry).toContain('<AuthExperienceGate initialPhase={initialPhase} onAuthenticated={accountReady}>');
    expect(authGate).toContain('if (account?.id) return <React.Fragment key={account.id}>{children}</React.Fragment>;');
    expect(workspace).not.toContain("preconnectRememberedWebDirect");
    expect(workspace).not.toContain("prewarmDirectRuntime");

    expect(accountGate).not.toContain("webRememberedDirectPreconnect");
    expect(accountGate).not.toContain("webStartupPlaybackCoordinator");
  });

  it("keeps startup routing local-only and makes late candidate configuration impossible", () => {
    const session = source("src/features/cloud/webTransportSession.ts");
    const controller = source("src/features/cloud/webTransportController.ts");
    const protocol = source("src/features/cloud/webTransportWorkerProtocol.ts");

    expect(session).toContain("export async function reserveWebTransportSession(): Promise<WebTransportSessionPublic>");
    expect(session).not.toContain("startupBeatIds");
    expect(session).not.toContain("startup_beat_ids");
    expect(controller).not.toContain("startupBeatIds");
    expect(controller).toContain("startupMessageIds: readonly number[]");
    expect(controller).not.toContain("configureStartupBeatIds(");
    expect(controller).not.toContain("CONTROLLER_STARTUP_IDS_LATE");
    expect(protocol).not.toContain("startup_routes");
    expect(protocol).not.toContain("routing_revision");
  });

  it("resolves startup MASTER media from local message ids with one Telegram vector", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");
    const client = source("src/features/cloud/webTransportWorkerClient.ts");

    expect(client).toContain("startupMessageIds: sessionStartupMessageIds");
    expect(worker).toContain("command.startupMessageIds");
    expect(worker).toContain("await active.getMessages(targetChatId, messageIds)");
    expect(worker).toContain("void warmStartupPlaybackMedia(active, startupIds)");
    expect(worker).not.toContain("resolvePlaybackMediaBatch(next, numericChatId, startupMessageIds, false)");
    expect(worker).not.toContain("startupRouteMessageIds(startup_routes)");
  });

  it("supports real warm preemption, requeue and same-beat promotion", () => {
    const protocol = source("src/features/cloud/webTransportWorkerProtocol.ts");
    const client = source("src/features/cloud/webTransportWorkerClient.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(protocol).toContain('op: "playback_focus"');
    expect(protocol).toContain('op: "playback_stable"');
    expect(protocol).toContain('op: "playback_release"');
    expect(client).toContain("promoteMessage(messageId: number)");
    expect(worker).toContain('type WarmState = "queued" | "active" | "preempted" | "ready" | "failed"');
    expect(worker).toContain("new AbortController()");
    expect(worker).toContain("abortSignal: controller.signal");
    expect(worker).toContain("activeWarmTransfers");
    expect(worker).toContain("pendingWarm.unshift(target)");
    expect(worker).toContain("pendingWarm.push(state)");
    expect(worker).toContain('playTrace("PLAY_WARM_PREEMPT_ALL"');
  });

  it("uses PLAY_CRITICAL zero-warm and PLAY_STABLE six-warm scheduling", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain('type PlaybackSchedulerState = "IDLE" | "PLAY_CRITICAL" | "PLAY_STABLE"');
    expect(worker).toContain('playbackSchedulerState === "PLAY_CRITICAL" ? 0');
    expect(worker).toContain('playbackSchedulerState === "PLAY_STABLE" ? 6 : dataLaneLimit');
  });

  it("keeps INDEX above WARM but below Play and makes the INDEX byte download abortable", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain("activeIndexAbortController");
    expect(worker).toContain("waitUntilIndexPriorityAllowed");
    expect(worker).toContain("abortSignal: controller.signal");
    expect(worker).toContain('preemptActiveIndex("play")');
    expect(worker).not.toContain('preemptActiveIndex("warm")');
    expect(worker).toContain("request_id: activeIndexRequestId");
    expect(worker).toContain('playTrace(resumed ? "INDEX_RESUMED" : "INDEX_BEGIN", {');
    expect(worker).toContain("request_id: requestId");
  });

  it("publishes the playback data plane before getMe/getChat background verification", () => {
    const controller = source("src/features/cloud/webTransportController.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");

    const initialize = controller.indexOf("await this.runtime.initialize(session, this.startupMessageIds)");
    const publish = controller.indexOf("this.session = session", initialize);
    const background = controller.indexOf("this.startBackgroundVerification(session, lifecycleGeneration, activation?.membership || null)", publish);
    expect(initialize).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(initialize);
    expect(background).toBeGreaterThan(publish);
    expect(controller).toContain("verifyIdentity");
    expect(worker).toContain('playTrace("DIRECT_BACKGROUND_GET_ME_OK"');
    expect(worker).toContain('playTrace("DIRECT_BACKGROUND_GET_CHAT_OK"');
  });

  it("keeps controller authorization and credential refresh fail-closed", () => {
    const controller = source("src/features/cloud/webTransportController.ts");

    expect(controller).toContain("async beginOperation(");
    expect(controller).toContain("await this.waitUntilVerified()");
    expect(controller).toContain("await this.api.authorize(");
    expect(controller).toContain("private async applyCredentialRefresh");
  });
});
