import { describe, expect, it } from "vitest";
import {
  FULL_CARD_INTERSECTION_RATIO,
  isFullyVisibleBeatCardIntersection,
} from "../../src/features/playback/webVisiblePlaybackPrefetch";

function entry(input: {
  ratio: number;
  top: number;
  left?: number;
  right?: number;
  bottom: number;
  rootTop?: number;
  rootLeft?: number;
  rootRight?: number;
  rootBottom?: number;
}): IntersectionObserverEntry {
  const rect = {
    x: input.left ?? 100,
    y: input.top,
    top: input.top,
    left: input.left ?? 100,
    right: input.right ?? 300,
    bottom: input.bottom,
    width: (input.right ?? 300) - (input.left ?? 100),
    height: input.bottom - input.top,
    toJSON() { return {}; },
  } as DOMRectReadOnly;
  const rootBounds = {
    x: input.rootLeft ?? 0,
    y: input.rootTop ?? 0,
    top: input.rootTop ?? 0,
    left: input.rootLeft ?? 0,
    right: input.rootRight ?? 1200,
    bottom: input.rootBottom ?? 800,
    width: (input.rootRight ?? 1200) - (input.rootLeft ?? 0),
    height: (input.rootBottom ?? 800) - (input.rootTop ?? 0),
    toJSON() { return {}; },
  } as DOMRectReadOnly;
  return {
    time: 0,
    target: document.createElement("div"),
    rootBounds,
    boundingClientRect: rect,
    intersectionRect: rect,
    isIntersecting: input.ratio > 0,
    intersectionRatio: input.ratio,
  } as IntersectionObserverEntry;
}

describe("fully visible BeatCard prefetch eligibility", () => {
  it("accepts a complete card inside the viewport", () => {
    expect(isFullyVisibleBeatCardIntersection(entry({
      ratio: 1,
      top: 120,
      bottom: 380,
    }))).toBe(true);
  });

  it("rejects a card whose lower edge is clipped even when most of it is visible", () => {
    expect(isFullyVisibleBeatCardIntersection(entry({
      ratio: FULL_CARD_INTERSECTION_RATIO,
      top: 650,
      bottom: 860,
      rootBottom: 800,
    }))).toBe(false);
  });

  it("rejects partial visibility before the full-card ratio threshold", () => {
    expect(isFullyVisibleBeatCardIntersection(entry({
      ratio: 0.98,
      top: 120,
      bottom: 380,
    }))).toBe(false);
  });
});
