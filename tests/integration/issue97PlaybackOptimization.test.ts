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
    expect(worker).toContain("const limit = Math.min(STARTUP_PREFIX_BYTES");
  });

  it("persists an all-beat playback routing cache plus at most fourteen startup routes", () => {
    const routing = source("src/features/playback/webPlaybackRoutingCache.ts");

    expect(routing).toContain('WEB_PLAYBACK_ROUTING_CACHE_KEY = "beatgaler:web-playback-routing:v1"');
    expect(routing).toContain("WEB_STARTUP_PLAYBACK_ROUTE_LIMIT = 14");
    expect(routing).toContain('type WebPlaybackSort = "rating" | "manual" | "bpm" | "name"');
    expect(routing).toContain("routes: Record<string, CachedPlaybackRoute>");
    expect(routing).toContain("startup: CachedStartupPlaybackRoute[]");
    expect(routing).toContain("updatePlaybackRoutingCacheFromManifest");
    expect(routing).toContain("updatePlaybackRoutingSort");
  });

  it("feeds authoritative Telegram manifest routes into the playback routing cache before materialization", () => {
    const library = source("src/features/library/webLibrary.ts");

    const normalize = library.indexOf("normalizeWebLibraryManifest(index.manifest)");
    const updateRouting = library.indexOf("updatePlaybackRoutingCacheFromManifest(manifest)", normalize);
    const materialize = library.indexOf("const page = boundedPageFromNormalizedManifest(", updateRouting);
    expect(normalize).toBeGreaterThanOrEqual(0);
    expect(updateRouting).toBeGreaterThan(normalize);
    expect(materialize).toBeGreaterThan(updateRouting);
  });

  it("uses one idempotent startup coordinator and a real INDEX barrier", () => {
    const coordinator = source("src/features/playback/webStartupPlaybackCoordinator.ts");

    expect(coordinator).toContain("export class WebStartupPlaybackCoordinator");
    expect(coordinator).toContain("private startPromise: Promise<void> | null = null");
    expect(coordinator).toContain("waitUntilIndexAllowed");
    expect(coordinator).toContain("beginPlayback");
    expect(coordinator).toContain("markPlaybackStable");
    expect(coordinator).toContain("endPlayback");
    expect(coordinator).toContain("getWebStartupPlaybackCoordinator");
    expect(coordinator).toContain('playTrace("STARTUP_LOCAL_ROUTING_READY"');
    expect(coordinator).toContain('playTrace("INDEX_WAIT_STARTUP"');
  });

  it("starts Direct from remembered-session OPEN even when the local routing cache is empty", () => {
    const main = source("src/main.tsx");
    const coordinator = source("src/features/playback/webStartupPlaybackCoordinator.ts");

    expect(main).toContain('import("./features/playback/webStartupPlaybackCoordinator")');
    expect(main).toContain("getWebStartupPlaybackCoordinator().start()");
    expect(main).not.toContain("platform.cloudAuth.syncSession(null, \"\")");
    expect(coordinator).toContain("await this.transport.connectPlaybackDataPlane()");
  });

  it("makes late startup candidate configuration impossible", () => {
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    const controller = source("src/features/cloud/webTransportController.ts");

    expect(transport).toContain("constructor(startupCandidates");
    expect(controller).toContain("startupBeatIds: readonly string[]");
    expect(controller).toContain("startupMessageIds: readonly number[]");
    expect(controller).not.toContain("configureStartupBeatIds(");
    expect(controller).not.toContain("CONTROLLER_STARTUP_IDS_LATE");
  });

  it("resolves startup MASTER media from local message ids with one Telegram vector", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");
    const client = source("src/features/cloud/webTransportWorkerClient.ts");

    expect(client).toContain("startupMessageIds: sessionStartupMessageIds");
    expect(worker).toContain("command.startupMessageIds");
    expect(worker).toContain("return await active.getMessages(targetChatId, messageIds);");
    expect(worker).toContain("resolvePlaybackMediaBatch(next, numericChatId, startupMessageIds, false)");
    expect(worker).not.toContain("startupRouteMessageIds(startup_routes)");
  });

  it("removes per-operation Cloud authorization from warm and foreground playback", () => {
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    const prefetchStart = transport.indexOf("async prefetchFiles(");
    const streamStart = transport.indexOf("async streamFile(");
    const nextMethod = transport.indexOf("async commitImportedBeat(", streamStart);
    const prefetchBody = transport.slice(prefetchStart, streamStart);
    const streamBody = transport.slice(streamStart, nextMethod);

    expect(prefetchStart).toBeGreaterThanOrEqual(0);
    expect(streamStart).toBeGreaterThan(prefetchStart);
    expect(prefetchBody).toContain("this.worker.prefetchBatch");
    expect(prefetchBody).not.toContain("beginOperation");
    expect(prefetchBody).not.toContain("withOperation");
    expect(streamBody).toContain("this.worker.stream");
    expect(streamBody).not.toContain("beginOperation");
    expect(streamBody).not.toContain("withOperation");
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

  it("adopts an active/queued warm instead of redownloading offset zero", () => {
    const playback = source("src/features/playback/webPlaybackSource.ts");

    expect(playback).toContain("promotePrefetchForPlayback");
    expect(playback).toContain("const existingWarm = this.prefetchPending.get(key)");
    expect(playback).toContain("await existingWarm");
    expect(playback).toContain('playTrace(active ? "PLAY_WARM_ADOPTED" : "PLAY_WARM_PROMOTED"');
    expect(playback).toContain("promoteMessage?.(messageId)");
    expect(playback).not.toContain("cancelPrefetchForPlayback");
  });

  it("reuses a ready prefix and continues from its exact byte length", () => {
    const playback = source("src/features/playback/webPlaybackSource.ts");

    expect(playback).toContain("prefetched.totalBytes <= prefetched.prefix.byteLength || prefetched.prefix.byteLength % 4096 === 0");
    expect(playback).toContain("const offsetBytes = usablePrefix?.prefix.byteLength || 0;");
    expect(playback).toContain("this.transport.streamFile({ messageId, mimeType, offsetBytes }, chunk => {");
  });

  it("uses PLAY_CRITICAL zero-warm and PLAY_STABLE six-warm scheduling", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");
    const playback = source("src/features/playback/webPlaybackSource.ts");

    expect(worker).toContain('type PlaybackSchedulerState = "IDLE" | "PLAY_CRITICAL" | "PLAY_STABLE"');
    expect(worker).toContain('playbackSchedulerState === "PLAY_CRITICAL" ? 0');
    expect(worker).toContain('playbackSchedulerState === "PLAY_STABLE" ? 6 : dataLaneLimit');
    expect(playback).toContain("PLAYBACK_CRITICAL_BUFFER_AHEAD_SECONDS = 2");
    expect(playback).toContain("bufferedAheadSeconds(entry.sourceBuffer, entry.playbackCurrentTime)");
    expect(playback).toContain("this.transport.markPlaybackStable(entry.messageId)");
    expect(playback).toContain("if (state.waiting)");
    expect(playback).toContain("this.transport.focusPlayback(entry.messageId)");
  });

  it("keeps INDEX below WARM/PLAY and makes the INDEX byte download abortable", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");

    expect(transport).toContain("await this.indexBarrier()");
    expect(worker).toContain("activeIndexAbortController");
    expect(worker).toContain("waitUntilIndexPriorityAllowed");
    expect(worker).toContain("abortSignal: controller.signal");
    expect(worker).toContain('playTrace(reason === "play" ? "INDEX_PREEMPTED_PLAY" : "INDEX_PREEMPTED_WARM")');
    expect(worker).toContain('playTrace(resumed ? "INDEX_RESUMED" : "INDEX_BEGIN")');
  });

  it("publishes the playback data plane before getMe/getChat background verification", () => {
    const controller = source("src/features/cloud/webTransportController.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");

    const initialize = controller.indexOf("await this.runtime.initialize(session, this.startupMessageIds)");
    const publish = controller.indexOf("this.session = session", initialize);
    const background = controller.indexOf("this.startBackgroundVerification(session)", publish);
    expect(initialize).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(initialize);
    expect(background).toBeGreaterThan(publish);
    expect(controller).toContain("verifyIdentity");
    expect(worker).toContain('playTrace("DIRECT_BACKGROUND_GET_ME_OK"');
    expect(worker).toContain('playTrace("DIRECT_BACKGROUND_GET_CHAT_OK"');
  });

  it("retains capabilities for sensitive writes and credential refresh remains fail-closed", () => {
    const controller = source("src/features/cloud/webTransportController.ts");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");

    expect(controller).toContain("async beginOperation(");
    expect(controller).toContain("await this.waitUntilVerified()");
    expect(controller).toContain("await this.api.authorize(");
    expect(controller).toContain("private async applyCredentialRefresh");
    expect(transport).toContain('"commit_import"');
    expect(transport).toContain('"commit_edit"');
    expect(transport).toContain('"trash_move"');
  });

  it("keeps playback bytes in the bounded session-only RAM cache", () => {
    const playback = source("src/features/playback/webPlaybackSource.ts");
    const adapter = source("src/platform/webAdapter.ts");

    expect(playback).toContain("const DEFAULT_SESSION_CACHE_LIMIT_MB = 100;");
    expect(playback).toContain("cachedChunks: ArrayBuffer[];");
    expect(playback).toContain("entry.cachedChunks.push(chunk);");
    expect(playback).toContain('playTrace("SOURCE_SESSION_CACHE_HIT"');
    expect(playback).toContain("private enforceCacheBudget");
    expect(adapter).toContain("webPlaybackSources?.releaseAll();");
  });
});