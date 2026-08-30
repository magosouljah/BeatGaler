import React, { useState } from "react";
import type { Beat } from "../../src/types";
import Drawer from "../../src/components/Drawer";

function seedBeat(): Beat {
  return {
    id: "e2e-review-1",
    name: "Review Beat",
    folder_path: "C:\\BeatGalerE2E\\Review Beat",
    mp3_path: "C:\\BeatGalerE2E\\Review Beat\\Review Beat.mp3",
    wav_path: null,
    playback_path: "C:\\BeatGalerE2E\\Review Beat\\Review Beat.mp3",
    bpm: "120",
    key: "Cm",
    needs_resolution: false,
    tags: ["draft"],
    rating: 0,
    image_base64: null,
    has_wav: false,
    has_stems: false,
    has_samples: false,
    samples_path: null,
    has_flp: false,
    has_als: false,
    stems_path: null,
    flp_path: null,
    als_path: null,
    other_files: [],
    color: "#777777",
    color2: "#999999",
    has_loop: false,
    loop_path: null,
  };
}

export default function E2EReviewHarness() {
  const [saved, setSaved] = useState<Beat | null>(null);
  if (saved) {
    return (
      <main data-e2e-review-saved="true">
        <h1 data-e2e-review-saved-name>{saved.name}</h1>
        <div data-e2e-review-saved-bpm>{String(saved.bpm)}</div>
        <div data-e2e-review-saved-key>{saved.key}</div>
        <div data-e2e-review-saved-tags>{saved.tags.join(",")}</div>
      </main>
    );
  }

  return (
    <Drawer
      beat={seedBeat()}
      mode="edit"
      reviewInfo={{ current: 1, total: 1 }}
      closeAfterSave={false}
      mutationAllowed
      onClose={() => undefined}
      onSkipCurrent={() => undefined}
      onSkipAll={() => undefined}
      onSaved={setSaved}
      onReleaseAudio={() => undefined}
      isReviewNameTaken={() => false}
    />
  );
}
