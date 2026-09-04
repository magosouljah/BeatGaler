import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 optimized Web startup + playback", () => {
  it("keeps credential refresh fail-closed", () => {
    const controller = source("src/features/cloud/webTransportController.ts");
    const refreshStart = controller.indexOf("private async applyCredentialRefresh");
    const replace = controller.indexOf("await this.runtime.replaceCredentials(session);", refreshStart);
    const verify = controller.indexOf("await this.runtime.verifyReady(session);", replace);
    const publish = controller.indexOf("this.session = session;", verify);

    expect(refreshStart).toBeGreaterThanOrEqual(0);
    expect(replace).toBeGreaterThan(refreshStart);
    expect(verify).toBeGreaterThan(replace);
    expect(publish).toBeGreaterThan(verify);
    expect(controller).toContain('playTrace("CONTROLLER_CONNECT_REFRESH_WAIT")');
    expect(controller).toContain('playTrace("CONTROLLER_CREDENTIAL_REFRESH_FAILED"');
  });

  it("does not resolve startup Telegram media before vault activation completes", () => {
    const controller = source("src/features/cloud/webTransportController.ts");
    const activationGate = controller.indexOf("const activationResult = await activationResultPromise;");
    const initialize = controller.indexOf('observePlayStep("DIRECT_INITIALIZE"', activationGate);

    expect(activationGate).toBeGreaterThanOrEqual(0);
    expect(initialize).toBeGreaterThan(activationGate);
    expect(controller).toContain('playTrace("CONTROLLER_SESSION_MEDIA_GATE_OPEN")');
    expect(controller).toContain("Do not race that RPC against vault membership.");
  });

  it("uses seven configurable data lanes and exactly one 64 KiB startup chunk", () => {
    const protocol = source("src/features/cloud/webTransportWorkerProtocol.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(protocol).toContain("export const DEFAULT_PLAYBACK_DATA_LANES = 7;");
    expect(protocol).toContain("export const STARTUP_PREFIX_BYTES = 64 * 1024;");
    expect(protocol).toContain("export const WEB_PLAYBACK_PREFETCH_TARGET_SECONDS = Number.POSITIVE_INFINITY;");
    expect(protocol).toContain("export const WEB_PLAYBACK_PREFETCH_MAX_BYTES = STARTUP_PREFIX_BYTES;");
    expect(worker).toContain("const MAX_CONFIGURABLE_DATA_LANES = 16;");
    expect(worker).toContain("configureDataLaneLimit(input.maxConcurrency)");
    expect(worker).toContain('type DataLanePriority = "foreground" | "warm";');
    expect(worker).toContain("foregroundLaneWaiters.shift() || warmLaneWaiters.shift()");
    expect(worker).toContain("const limit = Math.min(STARTUP_PREFIX_BYTES");
    expect(worker).toContain('}), "warm");');
    expect(worker).not.toContain("downloadBatchRound");
  });

  it("resolves startup media with one Telegram getMessages vector and one simple retry", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain("return await active.getMessages(targetChatId, messageIds);");
    expect(worker).toContain("for (let attempt = 1; attempt <= 2; attempt += 1)");
    expect(worker).toContain("STARTUP_MEDIA_BATCH_RETRY_DELAY_MS");
    expect(worker).toContain("resolvePlaybackMediaBatch(next, numericChatId, startupMessageIds, false)");
    expect(worker).toContain("Promise.allSettled([identityPromise, startupMediaPromise])");
    expect(worker).toContain("if (identityResult.status === \"rejected\") throw identityResult.reason;");
    expect(worker).toContain("Temporary authorization resolved to the wrong transport identity.");
  });

  it("does not use slice barriers; persistent lane loops take the next warm job immediately", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(worker).toContain("const laneLoop = async (lane: number) => {");
    expect(worker).toContain("const candidate = queue[cursor++];");
    expect(worker).toContain("await downloadStartupPrefix(requestId, state);");
    expect(worker).toContain("Promise.all(Array.from({ length: laneCount }");
    expect(worker).not.toContain("states.slice(start, start + maxConcurrency)");
    expect(worker).not.toContain("candidates.slice(start, start + maxConcurrency)");
  });

  it("keeps one warm operation while foreground playback owns a separate stream operation", () => {
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    const playback = source("src/features/playback/webPlaybackSource.ts");

    expect(transport).toContain("async prefetchFiles(");
    expect(transport).toContain("const lease = await this.controller.beginOperation(");
    expect(transport).toContain('{ objectType: "message", objectIds: ids.map(String) }');
    expect(transport).toContain("maxConcurrency: this.playbackDataLanes");
    expect(transport).toContain("Foreground playback deliberately owns a separate authorization from warm.");
    expect(transport).toContain('{ objectType: "message", objectIds: [String(input.messageId)] }');
    expect(playback).toContain("batch.handle?.cancelMessage(job.messageId);");
    expect(playback).toContain('playTrace("SOURCE_PREFETCH_NEARBY_PREEMPT"');
  });

  it("consumes the 64 KiB prefix and resumes streaming at its exact aligned offset", () => {
    const playback = source("src/features/playback/webPlaybackSource.ts");

    expect(playback).toContain("prefetched.totalBytes <= prefetched.prefix.byteLength || prefetched.prefix.byteLength % 4096 === 0");
    expect(playback).toContain('playTrace("SOURCE_PREFETCH_CONSUMED"');
    expect(playback).toContain("const offsetBytes = usablePrefix?.prefix.byteLength || 0;");
    expect(playback).toContain("this.transport.streamFile({ messageId, mimeType, offsetBytes }, chunk => {");
  });

  it("chooses the first 14 beats from the local presentation cache and current local sort", () => {
    const adapter = source("src/platform/webAdapter.ts");

    expect(adapter).toContain('const WEB_PRESENTATION_LIBRARY_CACHE_KEY = "beatvault:library:v1";');
    expect(adapter).toContain('const WEB_PRESENTATION_SORT_CACHE_KEY = "beatvault:sort:v2";');
    expect(adapter).toContain("const WEB_STARTUP_WARM_BEATS = 14;");
    expect(adapter).toContain("const ordered = beats.slice().sort");
    expect(adapter).toContain('if (sortBy === "bpm")');
    expect(adapter).toContain('if (sortBy === "name")');
    expect(adapter).toContain("ratingDiff");
    expect(adapter).toContain("transport.startStartupWarm(");
    expect(adapter).toContain('sources.prefetch(candidate.beatId, candidate.messageId, candidate.mimeType, "visible")');
  });

  it("uses Cloud startup MASTER overrides consistently until Telegram reconcile replaces them", () => {
    const adapter = source("src/platform/webAdapter.ts");

    expect(adapter).toContain("const webStartupRouteOverrides = new Map<string, number>();");
    expect(adapter).toContain("const startupRoute = webStartupRouteOverrides.get(beat.id);");
    expect(adapter).toContain("webStartupRouteOverrides.set(candidate.beatId, candidate.messageId);");
    expect(adapter).toContain("for (const beat of page.beats) webStartupRouteOverrides.delete(beat.id);");
    expect(adapter).toContain("webStartupRouteOverrides.clear();");
  });

  it("returns only requested Cloud startup routes and repairs them from Telegram authority later", () => {
    const routing = source("cloud-server/startup-routing-index.js");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    const session = source("src/features/cloud/webTransportSession.ts");

    expect(routing).toContain("const MAX_STARTUP_BEATS = 14;");
    expect(routing).toContain("beatgaler_startup_routes");
    expect(routing).toContain("startup_routes: routing.routes || {}");
    expect(routing).toContain("routing_revision");
    expect(routing).toContain("/transport/routing/reconcile");
    expect(session).toContain("startupBeatIds: normalizeStartupBeatIds(startupBeatIds)");
    expect(session).toContain("reconcileWebTransportRouting");
    expect(transport).toContain("await this.startupWarmPromise.catch(() => {});");
    expect(transport).toContain("void reconcileWebTransportRouting(result.manifest)");
  });

  it("retains getChat until the no-membership getMessages probe is proven unambiguous", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");
    const controller = source("src/features/cloud/webTransportController.ts");

    expect(worker).toContain("await client.getChat(chatId);");
    expect(worker).toContain("negative-membership probe");
    expect(controller).toContain("getMessages-without-membership probe");
  });

  it("uses exactly one playback manager after the async Direct import race", () => {
    const adapter = source("src/platform/webAdapter.ts");
    const resolverStart = adapter.indexOf("async function resolveWebPlaybackSources");
    const firstGuard = adapter.indexOf("if (webPlaybackSources) return webPlaybackSources;", resolverStart);
    const awaitTransport = adapter.indexOf("const transport = await resolveWebCloudTransport();", firstGuard);
    const secondGuard = adapter.indexOf("if (!webPlaybackSources) {", awaitTransport);

    expect(resolverStart).toBeGreaterThanOrEqual(0);
    expect(firstGuard).toBeGreaterThan(resolverStart);
    expect(awaitTransport).toBeGreaterThan(firstGuard);
    expect(secondGuard).toBeGreaterThan(awaitTransport);
    expect(adapter).not.toContain("new WebPlaybackSourceManager(await resolveWebCloudTransport())");
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
    expect(adapter).toContain("resetVisiblePlaybackPrefetch();");
  });
});
