import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const transport = readFileSync("src/features/cloud/webGalerCloudTransport.ts", "utf8");
const downloads = readFileSync("src/features/downloads/webDownloads.ts", "utf8");
const audio = readFileSync("src/hooks/useAudio.ts", "utf8");
const coordinator = readFileSync("src/features/playback/webStartupPlaybackCoordinator.ts", "utf8");

describe("PLAY physical priority over artwork/export", () => {
  it("marks export streams explicitly and retains scoped Cloud authorization", () => {
    expect(downloads).toContain('purpose: "export"');
    expect(transport).toContain('if (purpose === "export")');
    expect(transport).toContain('"export",\n        { objectType: "message", objectIds: [String(input.messageId)] }');
  });

  it("backpressures every background stream before the Worker ACKs its next 64 KiB chunk", () => {
    expect(transport).toContain("if (background) await this.waitUntilBackgroundAllowed()");
    expect(transport).toContain("await this.waitUntilBackgroundAllowed();\n            await onChunk(chunk, downloadedBytes, totalBytes);");
    expect(transport).toContain("await onChunk(chunk, downloadedBytes, totalBytes);\n            // WorkerClient sends stream_ack only after this promise resolves.");
    expect(transport).toContain("await this.waitUntilBackgroundAllowed();");
  });

  it("hydrates artwork through the same backpressured chunk stream while keeping load_artwork authorization", () => {
    expect(transport).toContain('"load_artwork"');
    expect(transport).toContain('purpose: "other"');
    expect(transport).not.toContain("results[index] = await this.worker.download");
  });

  it("does not let a stale release/stable from beat X reopen background traffic during beat Y", () => {
    expect(coordinator).toContain("private currentPlaybackMessageId: number | null = null");
    expect(coordinator).toContain("if (this.currentPlaybackMessageId !== messageId) return");
    expect(coordinator).toContain("PLAY_FOCUS_RESTORE_AFTER_STALE_RELEASE");
    expect(coordinator).toContain("await this.restoreCurrentFocusAfter(messageId)");
  });

  it("keeps the main UI bundle pointed at the tiny event module rather than WorkerClient", () => {
    expect(audio).toContain('from "../features/cloud/webTransportEvents"');
    expect(coordinator).toContain('from "../cloud/webTransportEvents"');
    expect(audio).not.toContain('from "../features/cloud/webTransportWorkerClient"');
  });
});
