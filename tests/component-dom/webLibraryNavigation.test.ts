import { describe, expect, it, vi } from "vitest";
import {
  WEB_LIBRARY_NAVIGATION_EVENT,
  clearWebLibraryNavigationState,
  publishWebLibraryNavigationState,
  readRequestedWebLibraryOffset,
  readWebLibraryNavigationState,
  webLibraryPageUrl,
} from "../../src/features/library/webLibraryNavigation";

describe("Web library production cursor navigation", () => {
  it("parses only bounded non-negative integer cursor offsets", () => {
    expect(readRequestedWebLibraryOffset("")).toBe(0);
    expect(readRequestedWebLibraryOffset("?bgPage=240")).toBe(240);
    expect(readRequestedWebLibraryOffset("?bgPage=-1")).toBe(0);
    expect(readRequestedWebLibraryOffset("?bgPage=12.5")).toBe(0);
    expect(readRequestedWebLibraryOffset("?bgPage=nope")).toBe(0);
  });

  it("builds forward/back URLs without accumulating stale cursor parameters", () => {
    expect(webLibraryPageUrl(240, "https://app.beatgaler.test/library?x=1")).toBe("https://app.beatgaler.test/library?x=1&bgPage=240");
    expect(webLibraryPageUrl(480, "https://app.beatgaler.test/library?x=1&bgPage=240")).toBe("https://app.beatgaler.test/library?x=1&bgPage=480");
    expect(webLibraryPageUrl(0, "https://app.beatgaler.test/library?x=1&bgPage=240")).toBe("https://app.beatgaler.test/library?x=1");
  });

  it("publishes the exact bounded window consumed by the React pager", () => {
    clearWebLibraryNavigationState();
    const listener = vi.fn();
    window.addEventListener(WEB_LIBRARY_NAVIGATION_EVENT, listener);
    publishWebLibraryNavigationState({
      offset: 240,
      previousOffset: 0,
      nextOffset: 480,
      pageSize: 240,
      materializedCount: 240,
      totalVisible: 10_321,
    });
    expect(readWebLibraryNavigationState()).toEqual({
      offset: 240,
      previousOffset: 0,
      nextOffset: 480,
      pageSize: 240,
      materializedCount: 240,
      totalVisible: 10_321,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(WEB_LIBRARY_NAVIGATION_EVENT, listener);
  });
});
