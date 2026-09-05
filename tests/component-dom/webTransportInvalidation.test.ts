import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workerClient = readFileSync("src/features/cloud/webTransportWorkerClient.ts", "utf8");
const coordinator = readFileSync("src/features/playback/webStartupPlaybackCoordinator.ts", "utf8");
const audio = readFileSync("src/hooks/useAudio.ts", "utf8");

describe("Web transport invalidation lifecycle", () => {
  it("publishes one browser invalidation surface whenever the data-plane Worker is shut down", () => {
    expect(workerClient).toContain('WEB_TRANSPORT_INVALIDATED_EVENT = "beatgaler:web-session-invalidated"');
    expect(workerClient).toContain("publishTransportInvalidated();");
  });

  it("purges SourceManager RAM and prefixes on transport invalidation", () => {
    expect(coordinator).toContain("window.addEventListener(WEB_TRANSPORT_INVALIDATED_EVENT, this.onTransportInvalidated)");
    expect(coordinator).toContain("this.sources.releaseAll()");
    expect(coordinator).toContain("window.removeEventListener(WEB_TRANSPORT_INVALIDATED_EVENT, this.onTransportInvalidated)");
  });

  it("stops and detaches HTMLAudio when the same session is invalidated", () => {
    expect(audio).toContain("window.addEventListener(WEB_TRANSPORT_INVALIDATED_EVENT, onTransportInvalidated)");
    expect(audio).toContain("audio.pause()");
    expect(audio).toContain('audio.removeAttribute("src")');
    expect(audio).toContain("currentBeatIdRef.current = null");
  });
});
