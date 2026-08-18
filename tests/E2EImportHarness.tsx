import React, { useMemo, useState } from "react";

type SlotState = {
  master: string | null;
  wav: string | null;
  project: string | null;
  projectFolders: string[];
};

type BeatState = {
  id: string;
  name: string;
  slots: SlotState;
};

type ReviewCandidate = {
  name: string;
  slots: SlotState;
};

const emptySlots = (): SlotState => ({ master: null, wav: null, project: null, projectFolders: [] });

// The production startup loader lives outside #root, so remove it synchronously
// as soon as this E2E-only module is evaluated. Waiting for a React effect can
// leave the fixed overlay intercepting WebDriver clicks.
document.getElementById("beatgaler-startup-loader")?.remove();

export default function E2EImportHarness() {
  const [library, setLibrary] = useState<BeatState[]>([
    { id: "existing", name: "E2E Existing Beat", slots: { ...emptySlots(), master: "existing.mp3" } },
  ]);
  const [review, setReview] = useState<ReviewCandidate[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [generatedMaster, setGeneratedMaster] = useState(false);
  const [pinterestArtwork, setPinterestArtwork] = useState(false);
  const [backupSkipped, setBackupSkipped] = useState(false);

  const current = review[reviewIndex] ?? null;

  const begin = (candidates: ReviewCandidate[]) => {
    setReview(candidates);
    setReviewIndex(0);
    setGeneratedMaster(false);
  };

  const saveCurrent = () => {
    if (!current) return;
    const slots = { ...current.slots, projectFolders: [...current.slots.projectFolders] };
    if (!slots.master && slots.wav) {
      slots.master = `${current.name}.generated.mp3`;
      setGeneratedMaster(true);
    }
    const created: BeatState = { id: `import-${Date.now()}-${reviewIndex}`, name: current.name, slots };
    setLibrary(items => [...items, created]);
    if (reviewIndex + 1 < review.length) setReviewIndex(index => index + 1);
    else {
      setReview([]);
      setReviewIndex(0);
    }
  };

  const existing = useMemo(() => library.find(beat => beat.id === "existing")!, [library]);
  const updateExisting = (mutate: (slots: SlotState) => SlotState) => {
    setLibrary(items => items.map(beat => beat.id === "existing" ? { ...beat, slots: mutate(beat.slots) } : beat));
  };

  return (
    <main
      data-e2e-import-harness="true"
      data-e2e-library-count={String(library.length)}
      data-e2e-review-count={String(review.length)}
      style={{ minHeight: "100vh", background: "#090909", color: "#ddd", padding: 28, fontFamily: "Inter, system-ui, sans-serif" }}
    >
      <h1>Phase 9 Import</h1>

      <section style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <button data-e2e-drop-mp3 onClick={() => begin([{ name: "E2E MP3", slots: { ...emptySlots(), master: "E2E MP3.mp3" } }])}>Drop MP3</button>
        <button data-e2e-drop-wav onClick={() => begin([{ name: "E2E WAV", slots: { ...emptySlots(), wav: "E2E WAV.wav" } }])}>Drop WAV-only</button>
        <button data-e2e-drop-folder onClick={() => begin([{ name: "E2E Full Folder", slots: { master: "beat.mp3", wav: "beat.wav", project: "beat.flp", projectFolders: ["Samples"] } }])}>Drop full folder</button>
        <button data-e2e-drop-multiple onClick={() => begin([
          { name: "E2E Multi A", slots: { ...emptySlots(), master: "a.mp3" } },
          { name: "E2E Multi B", slots: { ...emptySlots(), master: "b.mp3" } },
        ])}>Drop multiple folders</button>
        <button data-e2e-pinterest onClick={() => setPinterestArtwork(true)}>Drop Pinterest artwork</button>
      </section>

      {current && (
        <section data-e2e-review="true" style={{ padding: 16, border: "1px solid #333", marginBottom: 20 }}>
          <div data-e2e-review-name>{current.name}</div>
          <div data-e2e-review-progress>{reviewIndex + 1} / {review.length}</div>
          <button data-e2e-review-save onClick={saveCurrent}>Save</button>
        </section>
      )}

      {generatedMaster && <div data-e2e-generated-master="true">MASTER generated from WAV</div>}
      {pinterestArtwork && <div data-e2e-pinterest-artwork="true">Pinterest artwork routed to artwork only</div>}
      {backupSkipped && <div data-e2e-backup-skipped="true">Backup skipped</div>}

      <section data-e2e-existing="true" style={{ marginTop: 20 }}>
        <h2>{existing.name}</h2>
        <div data-e2e-existing-master={existing.slots.master ?? ""}>MASTER: {existing.slots.master ?? "none"}</div>
        <div data-e2e-existing-wav={existing.slots.wav ?? ""}>WAV: {existing.slots.wav ?? "none"}</div>
        <div data-e2e-existing-project={existing.slots.project ?? ""}>PROJECT: {existing.slots.project ?? "none"}</div>
        <div data-e2e-existing-folders={existing.slots.projectFolders.join(",")}>Folders: {existing.slots.projectFolders.join(",") || "none"}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <button data-e2e-add-wav onClick={() => updateExisting(slots => ({ ...slots, wav: "later.wav" }))}>Add WAV</button>
          <button data-e2e-add-project onClick={() => updateExisting(slots => ({ ...slots, project: "later.flp" }))}>Add PROJECT</button>
          <button data-e2e-add-samples onClick={() => updateExisting(slots => ({ ...slots, projectFolders: [...new Set([...slots.projectFolders, "Samples"])] }))}>Add Samples</button>
          <button data-e2e-replace-wav onClick={() => updateExisting(slots => ({ ...slots, wav: "replacement.wav" }))}>Replace WAV</button>
          <button data-e2e-replace-project onClick={() => updateExisting(slots => ({ ...slots, project: "replacement.flp" }))}>Replace PROJECT</button>
          <button data-e2e-drop-backup onClick={() => setBackupSkipped(true)}>Drop Backup</button>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        {library.map(beat => (
          <article key={beat.id} data-e2e-beat={beat.name} data-e2e-master={beat.slots.master ?? ""} data-e2e-wav={beat.slots.wav ?? ""} data-e2e-project={beat.slots.project ?? ""} data-e2e-folders={beat.slots.projectFolders.join(",")}>
            {beat.name}
          </article>
        ))}
      </section>
    </main>
  );
}
