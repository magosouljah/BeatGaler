import { describe, expect, it } from "vitest";
import {
  NEARBY_VIEWPORT_MARGIN,
  classifyBeatCardWarmPriority,
} from "../../src/features/playback/webVisiblePlaybackPrefetch";

describe("BeatCard playback warm priority", () => {
  it("prioritizes any card intersecting the real viewport as visible", () => {
    expect(classifyBeatCardWarmPriority(true, true)).toBe("visible");
  });

  it("keeps an offscreen card within the expanded viewport as nearby", () => {
    expect(classifyBeatCardWarmPriority(false, true)).toBe("nearby");
    expect(NEARBY_VIEWPORT_MARGIN).toBe("100% 0px 100% 0px");
  });

  it("does no speculative work for far cards", () => {
    expect(classifyBeatCardWarmPriority(false, false)).toBe("far");
  });
});
