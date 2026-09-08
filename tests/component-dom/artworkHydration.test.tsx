// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

const { loadArtwork, cacheArtworkThumbnail, readCachedArtworkThumbnail, decodeArtworkDataUrl } = vi.hoisted(() => ({
  loadArtwork: vi.fn(),
  cacheArtworkThumbnail: vi.fn(),
  readCachedArtworkThumbnail: vi.fn(),
  decodeArtworkDataUrl: vi.fn(),
}));

vi.mock("../../src/platform", () => ({ platform: { media: { loadArtwork } } }));
vi.mock("../../src/features/artwork/artworkThumbnailCache", () => ({ cacheArtworkThumbnail, readCachedArtworkThumbnail }));
vi.mock("../../src/features/artwork/decodeArtworkDataUrl", () => ({ decodeArtworkDataUrl }));

import { useArtworkHydration, type ArtworkHydration } from "../../src/features/artwork/useArtworkHydration";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let api: ArtworkHydration | null = null;
let beatsSnapshot: Beat[] = [];
const networkHydrated = vi.fn();

const beat = (overrides: Partial<Beat> = {}): Beat => ({ id: "a", name: "A", bpm: 120, key: "c", tags: [], rating: 0, ...overrides } as Beat);

function Harness() {
  const [beats, setBeats] = useState<Beat[]>([beat()]);
  beatsSnapshot = beats;
  api = useArtworkHydration({ setBeats, onNetworkHydrated: networkHydrated });
  return <div />;
}

beforeEach(async () => {
  loadArtwork.mockReset(); cacheArtworkThumbnail.mockReset(); readCachedArtworkThumbnail.mockReset(); decodeArtworkDataUrl.mockReset(); networkHydrated.mockReset();
  cacheArtworkThumbnail.mockImplementation(async (_beat: Beat, data: string) => data);
  decodeArtworkDataUrl.mockResolvedValue(true);
  readCachedArtworkThumbnail.mockResolvedValue(null);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
});

afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; host?.remove(); host = null; api = null; beatsSnapshot = []; });

describe("useArtworkHydration", () => {
  it("hydrates from presentation cache without network or cloud-snapshot callback", async () => {
    readCachedArtworkThumbnail.mockResolvedValue("data:cached");
    let ready = false;
    await act(async () => { ready = await api!.ensureArtworkReady(beat()); });
    expect(ready).toBe(true);
    expect(loadArtwork).not.toHaveBeenCalled();
    expect(beatsSnapshot[0].image_base64).toBe("data:cached");
    expect(networkHydrated).not.toHaveBeenCalled();
  });

  it("deduplicates network hydration and reports only the presentation update", async () => {
    loadArtwork.mockResolvedValue("data:network");
    const target = beat({ assets: { artwork: { object_id: "art-1" } } as Beat["assets"] });
    let first!: Promise<boolean>; let second!: Promise<boolean>;
    await act(async () => { first = api!.ensureArtworkReady(target); second = api!.ensureArtworkReady(target); await Promise.all([first, second]); });
    expect(first).toBe(second);
    expect(loadArtwork).toHaveBeenCalledTimes(1);
    expect(beatsSnapshot[0].image_base64).toBe("data:network");
    expect(networkHydrated).toHaveBeenCalledTimes(1);
  });

  it("does not fetch when cache-only hydration still has a remote artwork reference", async () => {
    const target = beat({ assets: { artwork: { object_id: "art-1" } } as Beat["assets"] });
    let ready = true;
    await act(async () => { ready = await api!.ensureArtworkReady(target, false); });
    expect(ready).toBe(false);
    expect(loadArtwork).not.toHaveBeenCalled();
    expect(networkHydrated).not.toHaveBeenCalled();
  });

  it("invalidates both network and cache-only memoization for one beat", async () => {
    loadArtwork.mockResolvedValue("data:first");
    const target = beat({ assets: { artwork: { object_id: "art-1" } } as Beat["assets"] });
    await act(async () => { await api!.ensureArtworkReady(target); });
    expect(loadArtwork).toHaveBeenCalledTimes(1);
    api!.invalidateArtworkHydration(target.id);
    loadArtwork.mockResolvedValue("data:second");
    await act(async () => { await api!.ensureArtworkReady(target); });
    expect(loadArtwork).toHaveBeenCalledTimes(2);
  });
});
