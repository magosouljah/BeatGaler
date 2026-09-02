import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Beat } from "../../src/types";
import { commitWebBeatEdit } from "../../src/features/edit/webBeatEdit";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 production runtime follow-up", () => {
  it("reuses the authoritative existing topic for an existing-beat upload", async () => {
    const original = {
      id: "beat-1",
      name: "Same Beat",
      bpm: "120",
      key: "Cm",
      tags: [],
      rating: 0,
      color: "#111111",
      color2: "#222222",
      telegram_file_id: "direct:101",
      telegram_message_id: 101,
      image_base64: null,
    } as unknown as Beat;
    const updated = { ...original, bpm: "121" };
    const uploadedInputs: Array<Record<string, unknown>> = [];
    const runtime = {
      getLibraryIndex: vi.fn(async () => ({
        messageId: 500,
        manifest: {
          schema: "beatgaler.telegram.library",
          version: 2,
          beats: [{
            id: "beat-1",
            name: "Same Beat",
            bpm: "120",
            key: "Cm",
            tags: [],
            rating: 0,
            color: "#111111",
            color2: "#222222",
            telegram_topic_id: 4242,
            master: { telegram_message_id: 101, filename: "old.mp3", mime: "audio/mpeg", size: 10 },
          }],
          trash: [],
        },
      })),
      upload: vi.fn(async (input: Record<string, unknown>) => {
        uploadedInputs.push(input);
        return {
          telegram_file_id: "file-new",
          telegram_message_id: 202,
          filename: "new.mp3",
          original_size: 3,
          parts: [],
          transport: "direct-web" as const,
        };
      }),
      replaceLibraryIndex: vi.fn(async () => ({ messageId: 501, beatCount: 1, updated: true })),
    };

    await commitWebBeatEdit(original, updated, { MASTER: new File(["abc"], "new.mp3", { type: "audio/mpeg" }) }, runtime);
    expect(uploadedInputs).toHaveLength(1);
    expect(uploadedInputs[0].threadId).toBe(4242);
  });

  it("routes browser drops through browser File owners, not Desktop path staging", () => {
    const app = source("src/App.tsx");
    const controller = source("src/features/dragdrop/htmlDropController.ts");
    expect(app).toContain("onBrowserLibraryFileDrop: platform.capabilities.browserFileImport ? importDroppedBrowserFiles : undefined");
    expect(app).toContain("onBrowserBeatFileDrop: platform.capabilities.browserFileImport ? handleBrowserBeatFileDrop : undefined");
    expect(app).toContain("platform.cloudData.commitImportedBeat(beat)");
    expect(controller).toContain("options.onBrowserBeatFileDrop");
  });

  it("does not let Web card warming queue native cooking ahead of Play", () => {
    const app = source("src/App.tsx");
    expect(app).toContain("if (!platform.capabilities.playbackCache) return;");
    expect(app).toContain("Math.min(isTauriAvailable ? 6 : 1, queue.length)");
  });

  it("existing Web edit transport prefers the manifest thread hint", () => {
    const edit = source("src/features/cloud/webGalerCloudTransport.ts");
    expect(edit).toContain("const hintedThreadId = Number(input.threadId || 0)");
    expect(edit).toContain("if (!threadId)");
  });
});
