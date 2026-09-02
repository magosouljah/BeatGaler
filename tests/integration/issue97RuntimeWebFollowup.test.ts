import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Beat } from "../../src/types";
import { commitWebBeatEdit } from "../../src/features/edit/webBeatEdit";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Issue #97 production runtime follow-up", () => {
  it("replaces a stale installation topic id with the vault-resolved topic after artwork upload", async () => {
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
    const updated = { ...original, image_base64: "data:image/png;base64,YQ==" };
    const uploadedInputs: Array<Record<string, unknown>> = [];
    let publishedManifest: any = null;
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
          filename: "cover.png",
          original_size: 1,
          parts: [],
          transport: "direct-web" as const,
          thread_id: 3131,
        };
      }),
      replaceLibraryIndex: vi.fn(async (input: { manifest: unknown }) => {
        publishedManifest = input.manifest;
        return { messageId: 501, beatCount: 1, updated: true };
      }),
    };

    await commitWebBeatEdit(original, updated, {}, runtime);
    expect(uploadedInputs).toHaveLength(1);
    expect(uploadedInputs[0]).not.toHaveProperty("threadId");
    expect(publishedManifest.beats[0].telegram_topic_id).toBe(3131);
  });

  it("keeps visible cloud cards playable while authority is still checking", () => {
    const app = source("src/App.tsx");
    const card = source("src/components/BeatCard.tsx");
    expect(app).toContain('playbackInteractive={connectionState !== "offline" || Boolean(beat.offline_available)}');
    expect(card).toContain("if (!playbackInteractive || playbackBlocked) return;");
  });

  it("resolves an existing beat topic by vault rather than installation", () => {
    const server = source("cloud-server/server-core.js");
    const transport = source("src/features/cloud/webGalerCloudTransport.ts");
    expect(server).toContain("function storedBeatTopicCandidates(chatId, userId, beatId)");
    expect(server).toContain("key.endsWith(suffix)");
    expect(server).toContain("Number(current?.chatId) === Number(chatId)");
    expect(server).toContain("Number(a.messageThreadId) - Number(b.messageThreadId)");
    expect(server).toContain("adoptCanonicalBeatTopic(chatId, userId, beatId, name, current)");
    expect(transport).not.toContain("hintedThreadId");
    expect(transport).toContain("return { ...uploaded, thread_id: threadId };");
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
});
