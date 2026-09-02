// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MAX_ARTWORK_THUMBNAIL_BYTES, artworkThumbnailCacheKey } from "../../src/features/artwork/artworkThumbnailCache";

describe("artwork thumbnail cache contract", () => {
  it("caps each cached cover at 250 KiB", () => {
    expect(MAX_ARTWORK_THUMBNAIL_BYTES).toBe(250 * 1024);
  });

  it("keys a thumbnail by beat plus durable artwork object so edits invalidate stale covers", () => {
    expect(artworkThumbnailCacheKey({
      id: "beat-1",
      assets: { artwork: { object_id: "direct:42" } },
    } as any)).toBe("beat-1:direct:42");
  });

  it("does not invent a cache identity when the beat has no durable artwork reference", () => {
    expect(artworkThumbnailCacheKey({ id: "beat-1", assets: undefined } as any)).toBeNull();
  });
});
