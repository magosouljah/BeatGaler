import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 runtime trace contract", () => {
  it("keeps the definitive startup/playback timeline observable", () => {
    const rememberedPreconnect = source("src/features/playback/webRememberedDirectPreconnect.ts");
    const coordinator = source("src/features/playback/webStartupPlaybackCoordinator.ts");
    const worker = source("src/features/cloud/webTransport.worker.ts");
    const playback = source("src/features/playback/webPlaybackSource.ts");

    expect(rememberedPreconnect).toContain("DIRECT_REMEMBERED_PRECONNECT_BEGIN");
    expect(coordinator).toContain("STARTUP_LOCAL_ROUTING_READY");
    expect(coordinator).toContain("DIRECT_START_DISPATCHED");
    expect(worker).toContain("DIRECT_MTPROTO_READY");
    expect(worker).toContain("DIRECT_BACKGROUND_GET_ME_OK");
    expect(worker).toContain("DIRECT_BACKGROUND_GET_CHAT_OK");
    expect(worker).toContain("WARM_BATCH_BEGIN");
    expect(worker).toContain("WARM_PREFIX_READY");
    expect(coordinator).toContain("PLAY_FOCUS_BEGIN");
    expect(playback).toContain("PLAY_WARM_ADOPTED");
    expect(playback).toContain("PLAY_WARM_PROMOTED");
    expect(worker).toContain("PLAY_WARM_PREEMPT_ALL");
    expect(playback).toContain("PLAY_PREFIX_READY");
    expect(playback).toContain("PLAY_STREAM_BEGIN");
    expect(playback).toContain("PLAY_STREAM_FIRST_CHUNK");
    expect(playback).toContain("PLAY_BUFFER_STABLE");
    expect(worker).toContain("WARM_RESUME");
    expect(coordinator).toContain("INDEX_WAIT_STARTUP");
    expect(worker).toContain("INDEX_BEGIN");
    expect(worker).toContain("INDEX_PREEMPTED_PLAY");
    expect(worker).toContain("INDEX_RESUMED");
    expect(worker).toContain("INDEX_DONE");
  });

  it("contains no startup Cloud-route override path", () => {
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    const adapter = source("src/platform/webAdapter.ts");

    expect(transport).not.toContain("TRANSPORT_STARTUP_ROUTE_FALLBACK");
    expect(transport).not.toContain("session.startup_routes");
    expect(adapter).not.toContain("cloudRoute");
    expect(adapter).not.toContain("startup_routes");
  });
});
