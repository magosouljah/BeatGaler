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

  it("uses a 64 KiB playback part and caches Telegram media by message id", () => {
    const protocol = source("src/features/cloud/webTransportWorkerProtocol.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");

    expect(protocol).toContain("export const WEB_PLAYBACK_FIRST_CHUNK_KB = 64;");
    expect(worker).toContain("const playbackMediaCache = new Map<number, CachedPlaybackMedia>();");
    expect(worker).toContain('playTrace("WORKER_PLAYBACK_MEDIA_CACHE_HIT"');
    expect(worker).toContain('playTrace("WORKER_PLAYBACK_MEDIA_CACHE_MISS"');
    expect(worker).toContain("partSize: WEB_PLAYBACK_FIRST_CHUNK_KB");
    expect(worker).toContain("offset: offsetBytes");
  });

  it("prefetches only one small prefix and resumes playback after that prefix", () => {
    const worker = source("src/features/cloud/webTransport.worker.ts");
    const playback = source("src/features/playback/webPlaybackSource.ts");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");

    expect(worker).toContain("WEB_PLAYBACK_FIRST_CHUNK_BYTES");
    expect(worker).toContain("await active.downloadChunk({");
    expect(worker).toContain("limit,");
    expect(transport).toContain("async prefetchFile(input: WebTransportPrefetchInput)");
    expect(playback).toContain("const MAX_PREFETCH_CONCURRENCY = 2;");
    expect(playback).toContain('playTrace("SOURCE_PREFETCH_CONSUMED"');
    expect(playback).toContain("const offsetBytes = usablePrefix?.prefix.byteLength || 0;");
    expect(playback).toContain("this.transport.streamFile({ messageId, mimeType, offsetBytes }");
  });

  it("keeps completed playback in a bounded session-only RAM cache", () => {
    const playback = source("src/features/playback/webPlaybackSource.ts");
    const adapter = source("src/platform/webAdapter.ts");

    expect(playback).toContain("const DEFAULT_SESSION_CACHE_LIMIT_MB = 100;");
    expect(playback).toContain('playTrace("SOURCE_SESSION_CACHE_HIT"');
    expect(playback).toContain('playTrace("SOURCE_SESSION_CACHE_RETAINED"');
    expect(playback).toContain("if (entry.streamDone && !entry.failed)");
    expect(playback).toContain("private enforceCacheBudget");
    expect(playback).toContain('playTrace("SOURCE_SESSION_CACHE_EVICTED"');
    expect(adapter).toContain("webPlaybackSources?.releaseAll();");
    expect(adapter).toContain("resetVisiblePlaybackPrefetch();");
  });

  it("observes full card roots rather than artwork for visible prefetch", () => {
    const visible = source("src/features/playback/webVisiblePlaybackPrefetch.ts");
    const adapter = source("src/platform/webAdapter.ts");
    const card = source("src/components/BeatCard.tsx");

    expect(card).toContain("data-beat-card-id={visible ? beat.id : undefined}");
    expect(visible).toContain('document.querySelectorAll("[data-beat-card-id]")');
    expect(visible).toContain("entry.intersectionRatio < FULL_CARD_INTERSECTION_RATIO");
    expect(visible).toContain("rect.bottom <= root.bottom + PIXEL_TOLERANCE");
    expect(visible).not.toContain("data-beat-artwork-id");
    expect(adapter).toContain("installFullyVisibleBeatCardObserver");
    expect(adapter).toContain("void prefetchVisibleBeat(beatId);");
  });
});
