import { describe, expect, it, vi } from "vitest";
import { WebPlaybackSourceManager } from "../../src/features/playback/webPlaybackSource";

it("forgets a deleted beat by cancelling its warm member and removing its job", async () => {
  let finish!: (value: any) => void;
  const cancelMessage = vi.fn();
  const prefetchFiles = vi.fn(async () => ({
    completed: new Promise(resolve => { finish = resolve; }),
    cancelMessage,
    cancel: vi.fn(),
  }));
  const manager = new WebPlaybackSourceManager({
    prefetchFiles,
    streamFile: vi.fn(async () => { throw new Error("stream not expected"); }),
  });

  const warming = manager.prefetch("deleted-beat", 88);
  await vi.waitFor(() => expect(prefetchFiles).toHaveBeenCalledOnce());
  manager.forget("deleted-beat");

  await expect(warming).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelMessage).toHaveBeenCalledWith(88);

  finish({ results: [{ ok: false, messageId: 88, error: "Cancelled.", code: "CANCELLED" }] });
  const next = manager.prefetch("deleted-beat", 89);
  await vi.waitFor(() => expect(prefetchFiles).toHaveBeenCalledTimes(2));
  manager.forget("deleted-beat");
  await expect(next).rejects.toMatchObject({ name: "AbortError" });
});

describe("adapter delete wiring", () => {
  it("uses destructive forget rather than normal replay-preserving release", async () => {
    const { readFileSync } = await import("node:fs");
    const adapter = readFileSync("src/platform/webAdapter.ts", "utf8");
    expect(adapter).toContain("webPlaybackSources?.forget(id)");
  });
});
