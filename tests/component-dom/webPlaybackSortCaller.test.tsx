import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Beat } from "../../src/types";
import {
  readWebPlaybackRoutingCache,
  updatePlaybackRoutingCacheFromManifest,
  type WebPlaybackSort,
} from "../../src/features/playback/webPlaybackRoutingCache";
import { useWebPlaybackSortRouting } from "../../src/features/playback/useWebPlaybackSortRouting";

function manifestBeat(index: number) {
  return {
    id: `beat-${index}`,
    name: `Name ${String(30 - index).padStart(2, "0")}`,
    bpm: 180 - index,
    rating: index % 5,
    master: {
      telegram_message_id: 5000 + index,
      mime: "audio/mpeg",
      size: 65536 + index,
    },
  };
}

function presentationBeat(index: number): Beat {
  return {
    id: `beat-${index}`,
    name: `Name ${String(30 - index).padStart(2, "0")}`,
    bpm: String(180 - index),
    key: "Cm",
    tags: [],
    rating: index % 5,
    color: "#111111",
    color2: "#222222",
    telegram_message_id: 5000 + index,
    telegram_file_id: `direct:${5000 + index}`,
    playback_path: "",
    mp3_path: "",
    wav_path: null,
    image_base64: null,
  } as Beat;
}

function SortCaller({ sortBy, beats }: { sortBy: WebPlaybackSort; beats: readonly Beat[] }) {
  useWebPlaybackSortRouting(sortBy, beats, true);
  return null;
}

describe("Web playback sort caller", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it("updates persisted startup14 immediately for every UI sort without a new OPEN", async () => {
    const manifest = Array.from({ length: 20 }, (_, index) => manifestBeat(index + 1));
    const beats = manifest.map((_, index) => presentationBeat(index + 1));
    updatePlaybackRoutingCacheFromManifest({ beats: manifest, deleted: [], trash: [] });

    const expected = (sortBy: WebPlaybackSort) => {
      const source = manifest.map((beat, manualIndex) => ({ ...beat, manualIndex }));
      if (sortBy === "manual") return source.slice(0, 14).map(beat => beat.id);
      return source.slice().sort((a, b) => {
        if (sortBy === "bpm") return a.bpm - b.bpm || a.manualIndex - b.manualIndex;
        if (sortBy === "name") return a.name.localeCompare(b.name) || a.manualIndex - b.manualIndex;
        return b.rating - a.rating || a.manualIndex - b.manualIndex;
      }).slice(0, 14).map(beat => beat.id);
    };

    for (const sortBy of ["manual", "rating", "bpm", "name"] as const) {
      await act(async () => root.render(<SortCaller sortBy={sortBy} beats={beats} />));
      const cache = readWebPlaybackRoutingCache();
      expect(cache.sortBy).toBe(sortBy);
      expect(cache.startup.map(route => route.beatId)).toEqual(expected(sortBy));
      expect(cache.startup).toHaveLength(14);
    }
  });

  it("is a Web-only hook and leaves routing unchanged when disabled", async () => {
    const manifest = Array.from({ length: 16 }, (_, index) => manifestBeat(index + 1));
    updatePlaybackRoutingCacheFromManifest({ beats: manifest, deleted: [], trash: [] });
    const before = readWebPlaybackRoutingCache();

    function DisabledCaller() {
      useWebPlaybackSortRouting("name", [], false);
      return null;
    }

    await act(async () => root.render(<DisabledCaller />));
    const after = readWebPlaybackRoutingCache();
    expect(after.sortBy).toBe(before.sortBy);
    expect(after.startup).toEqual(before.startup);
  });
});
