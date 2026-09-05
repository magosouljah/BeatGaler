import { beforeEach, describe, expect, it } from "vitest";
import {
  beginWebPlaybackIntent,
  invalidateAllWebPlaybackIntents,
  invalidateWebPlaybackIntentForBeat,
  rememberPreparedWebPlaybackUrl,
  shouldAcceptWebPlaybackRequest,
  supersededWebPlaybackUrl,
} from "../../src/features/playback/webPlaybackIntent";

describe("Web playback intent", () => {
  beforeEach(() => invalidateAllWebPlaybackIntents());

  it("rejects an older prepared URL after a newer beat intent starts", () => {
    const first = beginWebPlaybackIntent("x");
    rememberPreparedWebPlaybackUrl("blob:x", first);
    const second = beginWebPlaybackIntent("y");
    rememberPreparedWebPlaybackUrl("blob:y", second);

    expect(shouldAcceptWebPlaybackRequest("x", ["blob:x"])).toBe(false);
    expect(shouldAcceptWebPlaybackRequest("y", ["blob:y"])).toBe(true);
  });

  it("rejects a superseded same-beat preparation by its tracked intent id", () => {
    const first = beginWebPlaybackIntent("x");
    const staleUrl = supersededWebPlaybackUrl(first);
    const second = beginWebPlaybackIntent("x");
    rememberPreparedWebPlaybackUrl("blob:x-new", second);

    expect(shouldAcceptWebPlaybackRequest("x", [staleUrl])).toBe(false);
    expect(shouldAcceptWebPlaybackRequest("x", ["blob:x-new"])).toBe(true);
  });

  it("keeps globally invalidated Web URLs tracked so a late stale play stays rejected", () => {
    const current = beginWebPlaybackIntent("x");
    rememberPreparedWebPlaybackUrl("blob:x-before-invalidation", current);

    invalidateAllWebPlaybackIntents();

    expect(shouldAcceptWebPlaybackRequest("x", ["blob:x-before-invalidation"])).toBe(false);
  });

  it("does not let releasing a previous beat invalidate the newer beat intent", () => {
    const previous = beginWebPlaybackIntent("x");
    rememberPreparedWebPlaybackUrl("blob:x", previous);
    const current = beginWebPlaybackIntent("y");
    rememberPreparedWebPlaybackUrl("blob:y", current);

    invalidateWebPlaybackIntentForBeat("x");
    expect(shouldAcceptWebPlaybackRequest("y", ["blob:y"])).toBe(true);

    invalidateWebPlaybackIntentForBeat("y");
    expect(shouldAcceptWebPlaybackRequest("y", ["blob:y"])).toBe(false);
  });
});
