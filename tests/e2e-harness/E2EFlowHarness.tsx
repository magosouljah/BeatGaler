import React, { useEffect, useMemo, useState } from "react";
import BeatCard from "../../src/components/BeatCard";
import Drawer from "../../src/components/Drawer";
import type { Beat } from "../../src/types";

const fixture: Beat = {
  id: "e2e-purple-beat",
  name: "E2E Purple Beat",
  folder_path: "E:\\BeatGaler-E2E\\E2E Purple Beat",
  mp3_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\E2E Purple Beat.mp3",
  wav_path: null,
  playback_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\E2E Purple Beat.mp3",
  bpm: "140",
  key: "cm",
  needs_resolution: false,
  tags: ["e2e", "dark"],
  rating: 5,
  image_base64: null,
  has_wav: false,
  has_stems: false,
  has_samples: true,
  samples_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\Samples",
  has_flp: true,
  has_als: false,
  stems_path: null,
  flp_path: "E:\\BeatGaler-E2E\\E2E Purple Beat\\E2E Purple Beat.flp",
  als_path: null,
  other_files: [],
  color: "#442584",
  color2: "#701f6a",
  has_loop: false,
  loop_path: null,
};

const noop = () => {};
const noopAsync = async () => {};
const noopBeat = (_beat: Beat) => {};
const noopBool = (_value: boolean) => {};
const noopAny = (..._args: any[]) => {};

export default function E2EFlowHarness() {
  const [beat, setBeat] = useState<Beat>(fixture);
  const [editing, setEditing] = useState(false);
  const tagFrequency = useMemo(() => new Map(beat.tags.map(tag => [tag, 1])), [beat.tags]);

  useEffect(() => {
    // The production App normally owns startup-loader dismissal.
    // This isolated harness replaces <App />, so dismiss the static loader here
    // or it will remain above the real BeatCard/Drawer and intercept clicks.
    const loader = document.getElementById("beatgaler-startup-loader");
    if (loader) loader.remove();
    document.documentElement.removeAttribute("data-startup-loading");
    document.body.removeAttribute("data-startup-loading");
  }, []);

  // Intentionally use an `any` prop bag for the E2E harness.
  // BeatCard gains product features frequently; this harness only exercises
  // context-menu → Edit metadata, so unrelated required callbacks must not make
  // the test fixture brittle or force production changes.
  const beatCardProps: any = {
    beat,
    tagFrequency,
    showIncompleteWarnings: true,
    playing: false,
    selected: false,
    selectedCount: 0,
    selectMode: false,
    dragEnabled: false,

    // Core callbacks used by this flow.
    onPlay: noopBeat,
    onDetail: noopBeat,
    onEdit: () => setEditing(true),
    onDelete: noopBeat,
    onAddToQueue: noopBeat,
    onUpload: noopBeat,
    onBulkEdit: noop,
    onBulkUpload: noop,
    onBulkDelete: noop,
    onToggleSelect: noopAny,

    // Compatibility defaults for newer BeatCard contracts.
    openableProject: null,
    onWarm: noopAny,
    onUploadTelegram: noopAny,
    onDownloadTelegram: noopAny,
    onReveal: noopAny,
    onOpenProject: noopAny,
    onAddFile: noopAny,
    onArtworkDrop: noopAny,
    onDropArtwork: noopAny,
    onDownload: noopAny,
    onUploadCloud: noopAny,
    onDownloadCloud: noopAny,
    onSetSelected: noopBool,
    onSelect: noopAny,
    onContextAction: noopAny,
    cloudBusy: false,
    isCloudBusy: false,
    warming: false,
    warm: false,
    mutationAllowed: true,
    online: true,
    disabled: false,
    isUploading: false,
    isDownloading: false,
    uploadProgress: 0,
    downloadProgress: 0,
    animDelay: 0,
  };

  return (
    <div data-e2e-flow-root style={{ minHeight: "100vh", padding: 32, background: "#101010" }}>
      <BeatCard {...beatCardProps} />

      {editing && (
        <Drawer
          beat={beat}
          mode="edit"
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setBeat(updated);
            setEditing(false);
          }}
          onReleaseAudio={() => {}}
          closeAfterSave={true}
        />
      )}
    </div>
  );
}
