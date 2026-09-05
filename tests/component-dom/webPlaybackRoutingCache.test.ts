import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import {
  deletePlaybackRoutes,
  isPlaybackRouteSuspect,
  markPlaybackRouteSuspect,
  readWebPlaybackRoutingCache,
  updatePlaybackRoutingCacheFromManifest,
  updatePlaybackRoutingSort,
  updatePlaybackRoutingStartupFromBeats,
  upsertPlaybackRouteFromBeat,
} from "../../src/features/playback/webPlaybackRoutingCache";
import { markPlaybackMessageRouteSuspect } from "../../src/features/playback/webPlaybackRoutingSuspect";

function manifestBeat(index: number) {
  return {
    id: `beat-${index}`,
    name: `Name ${String(20 - index).padStart(2, "0")}`,
    bpm: 200 - index,
    rating: index % 5,
    master: {
      telegram_message_id: 1000 + index,
      mime: "audio/mpeg",
      size: index === 1 ? null : 64000 + index,
    },
  };
}

function beat(index: number, overrides: Partial<Beat> = {}): Beat {
  return {
    id: `beat-${index}`,
    name: `Name ${String(20 - index).padStart(2, "0")}`,
    bpm: String(200 - index),
    key: "Cm",
    tags: [],
    rating: index % 5,
    color: "#111111",
    color2: "#222222",
    telegram_message_id: 1000 + index,
    telegram_file_id: `direct:${1000 + index}`,
    playback_path: "",
    mp3_path: "",
    wav_path: null,
    image_base64: null,
    ...overrides,
  } as Beat;
}

describe("Web playback routing cache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recomputes startup14 for manual, rating, bpm and name without presentation cache", () => {
    const beats = Array.from({ length: 16 }, (_, index) => manifestBeat(index + 1));
    updatePlaybackRoutingCacheFromManifest({ beats, deleted: [], trash: [] });

    updatePlaybackRoutingSort("manual");
    expect(readWebPlaybackRoutingCache().startup.map(item => item.beatId)).toEqual(
      Array.from({ length: 14 }, (_, index) => `beat-${index + 1}`),
    );

    updatePlaybackRoutingSort("rating");
    const ratingIds = beats.slice().sort((a, b) => b.rating - a.rating || beats.indexOf(a) - beats.indexOf(b))
      .slice(0, 14).map(item => item.id);
    expect(readWebPlaybackRoutingCache().startup.map(item => item.beatId)).toEqual(ratingIds);

    updatePlaybackRoutingSort("bpm");
    const bpmIds = beats.slice().sort((a, b) => a.bpm - b.bpm || beats.indexOf(a) - beats.indexOf(b))
      .slice(0, 14).map(item => item.id);
    expect(readWebPlaybackRoutingCache().startup.map(item => item.beatId)).toEqual(bpmIds);

    updatePlaybackRoutingSort("name");
    const nameIds = beats.slice().sort((a, b) => a.name.localeCompare(b.name) || beats.indexOf(a) - beats.indexOf(b))
      .slice(0, 14).map(item => item.id);
    expect(readWebPlaybackRoutingCache().startup.map(item => item.beatId)).toEqual(nameIds);
  });

  it("does not rewrite an unchanged authoritative manifest but reconciles a changed route", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const first = { beats: [manifestBeat(1), manifestBeat(2), manifestBeat(3)], deleted: [], trash: [] };

    updatePlaybackRoutingCacheFromManifest(first);
    const writesAfterFirst = setItem.mock.calls.filter(([key]) => key === "beatgaler:web-playback-routing:v1").length;
    expect(writesAfterFirst).toBe(1);

    updatePlaybackRoutingCacheFromManifest({
      beats: [manifestBeat(1), manifestBeat(2), manifestBeat(3)],
      deleted: [],
      trash: [],
    });
    expect(setItem.mock.calls.filter(([key]) => key === "beatgaler:web-playback-routing:v1")).toHaveLength(writesAfterFirst);

    const changed = manifestBeat(2);
    changed.master.telegram_message_id = 9999;
    updatePlaybackRoutingCacheFromManifest({
      beats: [manifestBeat(1), changed, manifestBeat(3)],
      deleted: [],
      trash: [],
    });

    expect(setItem.mock.calls.filter(([key]) => key === "beatgaler:web-playback-routing:v1")).toHaveLength(writesAfterFirst + 1);
    expect(readWebPlaybackRoutingCache().routes["beat-2"]?.messageId).toBe(9999);
  });

  it("preserves null sizes instead of converting unknown to zero", () => {
    updatePlaybackRoutingCacheFromManifest({ beats: [manifestBeat(1)], deleted: [], trash: [] });
    expect(readWebPlaybackRoutingCache().routes["beat-1"]?.sizeBytes).toBeNull();
  });

  it("does not resurrect an authoritative deletion from presentation cache", () => {
    updatePlaybackRoutingCacheFromManifest({
      beats: [manifestBeat(1), manifestBeat(2)],
      deleted: [],
      trash: [],
    });
    updatePlaybackRoutingCacheFromManifest({
      beats: [manifestBeat(2)],
      deleted: [{ id: "beat-1" }],
      trash: [],
    });

    updatePlaybackRoutingStartupFromBeats([beat(1), beat(2)], "manual");
    const cache = readWebPlaybackRoutingCache();
    expect(cache.authoritative).toBe(true);
    expect(cache.routes["beat-1"]).toBeUndefined();
    expect(cache.startup.map(item => item.beatId)).toEqual(["beat-2"]);
  });

  it("recomputes startup after confirmed import, edit, restore and deletion mutations", () => {
    updatePlaybackRoutingCacheFromManifest({
      beats: [manifestBeat(1), manifestBeat(2)],
      deleted: [],
      trash: [],
    });
    updatePlaybackRoutingSort("rating");

    // Import.
    upsertPlaybackRouteFromBeat(beat(3, { rating: 99, name: "Top" }));
    expect(readWebPlaybackRoutingCache().startup[0]?.beatId).toBe("beat-3");

    // Edit.
    upsertPlaybackRouteFromBeat(beat(3, { rating: -1, name: "Edited" }));
    expect(readWebPlaybackRoutingCache().startup[0]?.beatId).not.toBe("beat-3");

    // Delete then restore the same identity with a new route.
    deletePlaybackRoutes(["beat-2"]);
    expect(readWebPlaybackRoutingCache().routes["beat-2"]).toBeUndefined();
    upsertPlaybackRouteFromBeat(beat(2, { telegram_message_id: 7777, telegram_file_id: "direct:7777", rating: 88 }));
    expect(readWebPlaybackRoutingCache().routes["beat-2"]?.messageId).toBe(7777);
    expect(readWebPlaybackRoutingCache().startup[0]?.beatId).toBe("beat-2");

    deletePlaybackRoutes(["beat-2"]);
    const cache = readWebPlaybackRoutingCache();
    expect(cache.routes["beat-2"]).toBeUndefined();
    expect(cache.startup.some(item => item.beatId === "beat-2")).toBe(false);
  });

  it("keeps the whole compact projection and startup14 correct across more than 240 beats", () => {
    const manifest = Array.from({ length: 260 }, (_, index) => ({
      ...manifestBeat(index + 1),
      name: `Beat ${String(260 - index).padStart(3, "0")}`,
      bpm: 60 + ((index * 7) % 180),
      rating: (index * 11) % 101,
    }));
    updatePlaybackRoutingCacheFromManifest({ beats: manifest, deleted: [], trash: [] });

    const initial = readWebPlaybackRoutingCache();
    expect(initial.order).toHaveLength(260);
    expect(Object.keys(initial.routes)).toHaveLength(260);

    for (const sort of ["manual", "rating", "bpm", "name"] as const) {
      updatePlaybackRoutingSort(sort);
      const cache = readWebPlaybackRoutingCache();
      expect(cache.startup).toHaveLength(14);
      expect(new Set(cache.startup.map(item => item.beatId)).size).toBe(14);
      expect(cache.startup.every(item => cache.routes[item.beatId]?.messageId === item.messageId)).toBe(true);
    }

    upsertPlaybackRouteFromBeat(beat(261, { name: "A First", rating: 999, bpm: "1" }));
    updatePlaybackRoutingSort("name");
    expect(readWebPlaybackRoutingCache().startup[0]?.beatId).toBe("beat-261");
    deletePlaybackRoutes(["beat-261"]);
    expect(readWebPlaybackRoutingCache().startup.some(item => item.beatId === "beat-261")).toBe(false);
    expect(readWebPlaybackRoutingCache().order).toHaveLength(260);
  });

  it("persists a suspect message version, excludes it from startup, and clears it only after authoritative reconcile", () => {
    const original = [manifestBeat(1), manifestBeat(2), manifestBeat(3)];
    updatePlaybackRoutingCacheFromManifest({ beats: original, deleted: [], trash: [] });
    updatePlaybackRoutingSort("manual");

    expect(markPlaybackRouteSuspect("beat-1", 1001)).toBe(true);
    let cache = readWebPlaybackRoutingCache();
    expect(isPlaybackRouteSuspect("beat-1", 1001)).toBe(true);
    expect(cache.suspect?.["beat-1"]?.messageId).toBe(1001);
    expect(cache.startup.some(item => item.beatId === "beat-1")).toBe(false);

    updatePlaybackRoutingSort("rating");
    expect(readWebPlaybackRoutingCache().startup.some(item => item.beatId === "beat-1")).toBe(false);

    const repaired = manifestBeat(1);
    repaired.master.telegram_message_id = 1900;
    updatePlaybackRoutingCacheFromManifest({ beats: [repaired, manifestBeat(2), manifestBeat(3)], deleted: [], trash: [] });
    cache = readWebPlaybackRoutingCache();
    expect(cache.suspect?.["beat-1"]).toBeUndefined();
    expect(cache.routes["beat-1"]?.messageId).toBe(1900);
  });

  it("quarantines every beat owning a failed message id without treating unrelated routes as suspect", () => {
    updatePlaybackRoutingCacheFromManifest({
      beats: [manifestBeat(1), manifestBeat(2), manifestBeat(3)],
      deleted: [],
      trash: [],
    });

    expect(markPlaybackMessageRouteSuspect(1002)).toEqual(["beat-2"]);
    expect(isPlaybackRouteSuspect("beat-2", 1002)).toBe(true);
    expect(isPlaybackRouteSuspect("beat-1")).toBe(false);
    expect(readWebPlaybackRoutingCache().startup.some(item => item.beatId === "beat-2")).toBe(false);
  });
});
