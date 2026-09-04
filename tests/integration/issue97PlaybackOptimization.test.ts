import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 combined Web playback optimization", () => {
  it("re-verifies the Worker before publishing refreshed Direct credentials", () => {
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

  it("uses 64 KiB physical rounds across six shared playback data lanes", () => {
    const protocol = source("src/features/cloud/webTransportWorkerProtocol.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(protocol).toContain("export const WEB_PLAYBACK_FIRST_CHUNK_KB = 64;");
    expect(protocol).toContain("export const WEB_PLAYBACK_DATA_LANES = 6;");
    expect(protocol).toContain("export const WEB_PLAYBACK_PREFETCH_TARGET_SECONDS = 1;");
    expect(protocol).toContain("export const WEB_PLAYBACK_PREFETCH_MAX_BYTES = 1024 * 1024;");
    expect(worker).toContain("async function withDataLane");
    expect(worker).toContain("activeDataLanes >= WEB_PLAYBACK_DATA_LANES");
    expect(worker).toContain("WEB_PLAYBACK_FIRST_CHUNK_BYTES");
    expect(worker).toContain("await withDataLane(() => active.downloadChunk({");
    expect(worker).toContain("offset: absoluteOffset");
    expect(worker).toContain("limit,");
  });

  it("warms candidates through one batch operation and keeps failures isolated per message", () => {
    const protocol = source("src/features/cloud/webTransportWorkerProtocol.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");
    const playback = source("src/features/playback/webPlaybackSource.ts");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");

    expect(protocol).toContain('op: "prefetch_batch"');
    expect(protocol).toContain('op: "prefetch_batch_cancel"');
    expect(worker).toContain("activePrefetchBatches");
    expect(worker).toContain("cancelledMessageIds");
    expect(worker).toContain("await schedulerYield();");
    expect(transport).toContain("async prefetchFiles(");
    expect(transport).toContain("const lease = await this.controller.beginOperation(");
    expect(transport).toContain('{ objectType: "message", objectIds: ids.map(String) }');
    expect(transport).toContain("const workerBatch = this.worker.prefetchBatch({ inputs }, onChunk);");
    expect(playback).toContain("this.transport.prefetchFiles(inputs, progress => this.acceptPrefetchChunk(batch, progress))");
    expect(playback).toContain("const PREFETCH_FAILURE_COOLDOWN_MS = 10_000;");
    expect(playback).toContain('playTrace("SOURCE_PREFETCH_NEARBY_PREEMPT"');
    expect(playback).toContain("batch.handle?.cancelMessage(job.messageId);");
    expect(playback).toContain("measureMp3PlayablePrefix(prefix)");
  });

  it("consumes any usable partial prefix immediately and resumes at its exact aligned offset", () => {
    const playback = source("src/features/playback/webPlaybackSource.ts");

    expect(playback).toContain("prefetched.totalBytes <= prefetched.prefix.byteLength || prefetched.prefix.byteLength % 4096 === 0");
    expect(playback).toContain('playTrace("SOURCE_PREFETCH_CONSUMED"');
    expect(playback).toContain("const offsetBytes = usablePrefix?.prefix.byteLength || 0;");
    expect(playback).toContain("this.transport.streamFile({ messageId, mimeType, offsetBytes }, chunk => {");
    expect(playback).toContain("const PLAYBACK_BUFFER_AHEAD_TARGET_SECONDS = 1;");
    expect(playback).toContain("await this.waitForStreamDemand(entry);");
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

  it("keeps playback bytes in a bounded 100 MB session-only RAM cache", () => {
    const playback = source("src/features/playback/webPlaybackSource.ts");
    const adapter = source("src/platform/webAdapter.ts");

    expect(playback).toContain("const DEFAULT_SESSION_CACHE_LIMIT_MB = 100;");
    expect(playback).toContain("cachedChunks: ArrayBuffer[];");
    expect(playback).toContain("entry.cachedChunks.push(chunk);");
    expect(playback).toContain("new Blob(reusable.cachedChunks");
    expect(playback).toContain('playTrace("SOURCE_SESSION_CACHE_HIT"');
    expect(playback).toContain("private enforceCacheBudget");
    expect(playback).toContain('playTrace("SOURCE_SESSION_CACHE_EVICTED"');
    expect(adapter).toContain("webPlaybackSources?.releaseAll();");
    expect(adapter).toContain("resetVisiblePlaybackPrefetch();");
  });

  it("classifies BeatCards as visible, nearby, or far without hover-driven warming", () => {
    const visible = source("src/features/playback/webVisiblePlaybackPrefetch.ts");
    const adapter = source("src/platform/webAdapter.ts");
    const card = source("src/components/BeatCard.tsx");

    expect(card).toContain("data-beat-card-id={visible ? beat.id : undefined}");
    expect(visible).toContain('export type BeatCardWarmPriority = "visible" | "nearby" | "far";');
    expect(visible).toContain('export const NEARBY_VIEWPORT_MARGIN = "100% 0px 100% 0px";');
    expect(visible).toContain('document.querySelectorAll("[data-beat-card-id]")');
    expect(visible).toContain("entry.isIntersecting && entry.intersectionRatio > 0");
    expect(visible).toContain("rootMargin: NEARBY_VIEWPORT_MARGIN");
    expect(visible).not.toContain("mouseenter");
    expect(visible).not.toContain("mouseover");
    expect(adapter).toContain("installBeatCardWarmObserver");
    expect(adapter).toContain("sources.setPrefetchPriority(beat.id, messageId, mimeType, priority);");
  });
});
