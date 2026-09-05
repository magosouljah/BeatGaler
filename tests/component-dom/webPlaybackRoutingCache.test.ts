import { beforeEach, describe, expect, it } from "vitest";
import type { Beat } from "../../src/types";
import {
  deletePlaybackRoutes,
  readWebPlaybackRoutingCache,
  updatePlaybackRoutingCacheFromManifest,
  updatePlaybackRoutingSort,
  updatePlaybackRoutingStartupFromBeats,
  upsertPlaybackRouteFromBeat,
} from "../../src/features/playback/webPlaybackRoutingCache";

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

    upsertPlaybackRouteFromBeat(beat(3, { rating: 99, name: "Top" }));
    expect(readWebPlaybackRoutingCache().startup[0]?.beatId).toBe("beat-3");

    upsertPlaybackRouteFromBeat(beat(3, { rating: -1, name: "Edited" }));
    expect(readWebPlaybackRoutingCache().startup[0]?.beatId).not.toBe("beat-3");

    deletePlaybackRoutes(["beat-2"]);
    const cache = readWebPlaybackRoutingCache();
    expect(cache.routes["beat-2"]).toBeUndefined();
    expect(cache.startup.some(item => item.beatId === "beat-2")).toBe(false);
  });
});
