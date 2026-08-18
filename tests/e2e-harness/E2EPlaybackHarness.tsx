import React, { useEffect, useMemo, useRef, useState } from "react";
import BeatCard from "../../src/components/BeatCard";
import Player from "../../src/components/Player";
import type { Beat } from "../../src/types";

type PlaybackState = "idle" | "preparing" | "playing" | "paused";

const beat = {
  id: "e2e-playback-beat",
  name: "E2E Playback Beat",
  folder_path: "E:\\BeatGaler-E2E\\E2E Playback Beat",
  mp3_path: "E:\\BeatGaler-E2E\\E2E Playback Beat\\E2E Playback Beat.mp3",
  wav_path: null,
  playback_path: "E:\\BeatGaler-E2E\\E2E Playback Beat\\E2E Playback Beat.mp3",
  bpm: "142",
  key: "fm",
  needs_resolution: false,
  tags: ["e2e", "playback"],
  rating: 5,
  image_base64: null,
  has_wav: false,
  has_stems: false,
  has_samples: true,
  samples_path: "E:\\BeatGaler-E2E\\E2E Playback Beat\\Samples",
  has_flp: true,
  has_als: false,
  stems_path: null,
  flp_path: "E:\\BeatGaler-E2E\\E2E Playback Beat\\E2E Playback Beat.flp",
  als_path: null,
  other_files: [],
  color: "#4f2d7f",
  color2: "#24143c",
  has_loop: false,
  loop_path: null,
} as Beat;

export default function E2EPlaybackHarness() {
  const [state, setState] = useState<PlaybackState>("idle");
  const [progress, setProgress] = useState(0);
  const timer = useRef<number | null>(null);
  const tagFrequency = useMemo(
    () => new Map(beat.tags.map(tag => [tag, 1])),
    [],
  );

  useEffect(() => {
    const loader = document.getElementById("beatgaler-startup-loader");
    if (loader) loader.remove();
    document.documentElement.removeAttribute("data-startup-loading");
    document.body.removeAttribute("data-startup-loading");

    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const startOrResume = () => {
    if (state === "playing") {
      setState("paused");
      return;
    }

    if (state === "paused") {
      setState("playing");
      return;
    }

    setState("preparing");
    timer.current = window.setTimeout(() => {
      setState("playing");
      setProgress(0.02);
    }, 180);
  };

  const beatCardProps: any = {
    beat,
    tagFrequency,
    showIncompleteWarnings: true,
    playing: state === "playing",
    selected: false,
    selectedCount: 0,
    selectMode: false,
    dragEnabled: false,
    warming: state === "preparing",
    warm: state === "playing" || state === "paused",
    mutationAllowed: true,
    online: true,
    disabled: state === "preparing",
    onPlay: startOrResume,
    onDetail: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onAddToQueue: () => {},
    onBulkEdit: () => {},
    onBulkUpload: () => {},
    onBulkDelete: () => {},
    onToggleSelect: () => {},
    openableProject: null,
    onWarm: () => {},
    onUploadTelegram: () => {},
    onDownloadTelegram: () => {},
    onReveal: () => {},
    onOpenProject: () => {},
    onAddFile: () => {},
    onArtworkDrop: () => {},
    onDropArtwork: () => {},
    onDownload: () => {},
    onUploadCloud: () => {},
    onDownloadCloud: () => {},
    onSetSelected: () => {},
    onSelect: () => {},
    onContextAction: () => {},
    cloudBusy: false,
    isCloudBusy: false,
    isUploading: false,
    isDownloading: false,
    uploadProgress: 0,
    downloadProgress: 0,
    animDelay: 0,
  };

  const playerProps: any = {
    beat,
    playing: state === "playing",
    progress,
    duration: 120,
    volume: 0.75,
    queue: [beat],
    currentIndex: 0,
    showQueue: false,
    canShowQueue: false,
    shuffleEnabled: false,
    repeatMode: "off",
    onToggle: startOrResume,
    onSeek: (ratio: number) => setProgress(ratio),
    onPrev: () => {},
    onNext: () => {},
    onVolumeChange: () => {},
    onToggleShuffle: () => {},
    onCycleRepeat: () => {},
    onToggleQueue: () => {},
    onPlayQueueIndex: () => {},
    onAddBeat: () => {},
    onDetail: () => {},
    onEdit: () => {},
    onDelete: () => {},
    onAddToQueue: () => {},
  };

  return (
    <div
      data-e2e-playback-state={state}
      style={{ minHeight: "100vh", background: "#090909", padding: 24 }}
    >
      <div
        data-e2e-playback-diagnostic="true"
        style={{ position: "fixed", top: 8, right: 8, zIndex: 20000, fontSize: 10, opacity: 0.01 }}
      >
        {state}
      </div>

      <div style={{ width: 240 }}>
        <BeatCard {...beatCardProps} />
      </div>

      <Player {...playerProps} />
    </div>
  );
}
