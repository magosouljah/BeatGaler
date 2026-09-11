import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({
  upload: vi.fn(),
  getLibraryIndex: vi.fn(),
  replaceLibraryIndex: vi.fn(),
}));

vi.mock("../../src/features/cloud/webTransportWorkerClient", () => ({
  WebTransportWorkerClient: class {
    prewarm() {}
    upload = network.upload;
    getLibraryIndex = network.getLibraryIndex;
    replaceLibraryIndex = network.replaceLibraryIndex;
  },
}));

vi.mock("../../src/features/cloud/webTransportController", () => ({
  WebTransportController: class {
    async connect() {}
    async beginOperation() { return "lease"; }
    async endOperation() {}
    async withOperation(_operation: string, _scope: unknown, run: () => Promise<unknown>) { return run(); }
  },
}));

vi.mock("../../src/features/cloud/webTransportSession", () => ({
  ensureWebTransportTopic: vi.fn(async () => 42),
  commitWebTransportIndexPointer: vi.fn(async () => undefined),
  reconcileWebTransportRouting: vi.fn(async () => undefined),
}));

vi.mock("../../src/features/playback/webStartupPlaybackCoordinator", () => {
  let transport: WebGalerCloudTransport | null = null;
  return {
    getWebStartupPlaybackCoordinator: () => ({
      start: async () => undefined,
      getTransport: () => transport ||= new WebGalerCloudTransport(),
    }),
    disconnectWebStartupPlaybackCoordinator: async () => { transport = null; },
  };
});

vi.mock("../../src/lib/dialog", () => ({ appAlert: vi.fn(async () => undefined) }));

import { platform } from "../../src/platform";
import { WebGalerCloudTransport } from "../../src/features/cloud/webGalerCloudTransport";
import { useCloudUploadQueue } from "../../src/features/cloud/useCloudUploadQueue";
import { useBrowserImport } from "../../src/features/import/useBrowserImport";
import { useImportEntry } from "../../src/features/import/useImportEntry";
import { useImportReview } from "../../src/features/import/useImportReview";
import { useImportSession } from "../../src/features/import/useImportSession";
import ImportReviewHost from "../../src/features/import/components/ImportReviewHost";
import AddBeatModal from "../../src/components/AddBeatModal";
import type { Beat } from "../../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
let decode: ReturnType<typeof vi.fn>;
let persistedManifest: any;
let persistedMessageId: number;
let latestBeats: Beat[] = [];
let latestUploadErrors: Record<string, string> = {};

function Harness() {
  const [beats, setBeats] = useState<Beat[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [dropImporting, setDropImporting] = useState(false);
  const session = useImportSession();
  const beatsLatestRef = useRef<Beat[]>([]);
  const beatRuntimeStatesRef = useRef<Record<string, unknown>>({});
  const cloudLibrarySnapshotRef = useRef<string | null>(null);

  const { addBeatsAndReview } = useImportEntry({
    connectionState: "online",
    setShowAdd,
    startReview: session.startReview,
    beatsLatestRef,
  });

  const uploads = useCloudUploadQueue({
    settings: null,
    setSettings: () => {},
    setConnectionState: () => {},
    setBeats,
    beatsLatestRef,
    beatRuntimeStatesRef,
    transitionRuntime: () => {},
    cloudLibrarySnapshotRef,
    waitForUploadedBeatPlaybackReady: async () => true,
    rejectOfflineMutation: () => false,
    isReviewActive: () => Boolean(session.reviewQueueLatestRef.current),
    hasProtectedStaging: () => false,
  });

  const review = useImportReview({
    setBeats,
    beatsLatestRef,
    setReviewQueue: session.setReviewQueue,
    skippedReviewSourceKeysRef: session.skippedReviewSourceKeysRef,
    cloudifyImportedBeats: uploads.cloudifyImportedBeats,
    getQueuedBeatsSnapshot: uploads.getQueuedBeatsSnapshot,
    onCancelPendingWork: () => {},
    releaseBeat: beatId => platform.importer.releaseBeat(beatId),
    discardBatch: async () => {},
    cleanupStaging: async () => {},
  });

  const browserImport = useBrowserImport({
    dropImporting,
    setDropImporting,
    rejectOfflineMutation: () => false,
    setDropActive: () => {},
    setShowAdd,
    setReviewQueue: session.setReviewQueue,
    completeImmediateReviewPreparation: () => {},
    resetImportResolutionState: () => {},
  });

  latestBeats = beats;
  latestUploadErrors = uploads.backgroundUploadErrors;

  const hydrateReviewCandidate = (beat: Beat) => session.setReviewQueue(queue => queue ? {
    ...queue,
    beats: queue.beats.map(current => current.id === beat.id ? beat : current),
  } : null);

  return (
    <div
      data-testid="library"
      onDrop={event => {
        event.preventDefault();
        void browserImport.importDroppedBrowserFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <button data-testid="open-add" onClick={() => setShowAdd(true)}>Add beat</button>
      {showAdd && (
        <AddBeatModal
          onClose={() => setShowAdd(false)}
          onAdd={addBeatsAndReview}
          onCandidateHydrated={hydrateReviewCandidate}
          existingBeats={beats}
        />
      )}
      <ImportReviewHost
        libraryDropStaging={false}
        reviewBootstrap={null}
        reviewQueue={session.reviewQueue}
        skeletonEnabled
        tagSuggestions={[]}
        mutationAllowed
        onSkipCurrent={review.skipCurrentReviewBeat}
        onCancel={review.cancelReview}
        isReviewNameTaken={() => false}
        onReleaseAudio={() => {}}
        onSaved={async beat => { review.handleReviewedBeatSaved(beat); }}
      />
    </div>
  );
}

function saveButton() {
  return Array.from(host.querySelectorAll("button"))
    .find(button => button.textContent?.trim() === "Save and finish");
}

function dispatchDrop(file: File) {
  const event = new Event("drop", { bubbles: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  host.querySelector<HTMLElement>('[data-testid="library"]')!.dispatchEvent(event);
}

async function dispatchPicker(file: File) {
  host.querySelector<HTMLButtonElement>('[data-testid="open-add"]')!.click();
  await vi.waitFor(() => expect(host.textContent).toContain("Choose MP3 or WAV"));
  const choose = Array.from(host.querySelectorAll("button"))
    .find(button => button.textContent?.includes("Choose MP3 or WAV"));
  choose!.click();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new Event("change"));
}

beforeEach(async () => {
  vi.clearAllMocks();
  persistedMessageId = 500;
  persistedManifest = {
    schema: "beatgaler.telegram.library",
    version: 2,
    beats: [],
    trash: [],
    deleted: [],
  };
  latestBeats = [];
  latestUploadErrors = {};

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:generated-master"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  (window as any).jsmediatags = {
    read(_file: File, callbacks: any) { callbacks.onSuccess({ tags: {} }); },
  };

  decode = vi.fn();
  vi.stubGlobal("OfflineAudioContext", class { decodeAudioData = decode; });

  network.getLibraryIndex.mockImplementation(async () => ({
    messageId: persistedMessageId,
    manifest: persistedManifest,
  }));
  network.replaceLibraryIndex.mockImplementation(async ({ manifest, expectedMessageId }: any) => {
    expect(expectedMessageId).toBe(persistedMessageId);
    const previousMessageId = persistedMessageId;
    persistedMessageId += 1;
    persistedManifest = manifest;
    return {
      messageId: persistedMessageId,
      previousMessageId,
      beatCount: Array.isArray(manifest.beats) ? manifest.beats.length : 0,
    };
  });
  network.upload.mockImplementation(async ({ file, kind }: { file: File; kind: string }) => ({
    telegram_file_id: kind === "MASTER" ? "direct:100" : "direct:101",
    telegram_message_id: kind === "MASTER" ? 100 : 101,
    filename: file.name,
    original_size: file.size,
    parts: [],
    transport: "direct-web",
  }));

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await platform.cloudData.disconnect().catch(() => {});
  await act(async () => root.unmount());
  host.remove();
  delete (window as any).jsmediatags;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BeatGaler Web import durability", () => {
  it.each(["drop", "picker"] as const)(
    "%s → Review → real background upload → authoritative INDEX → fresh Reload keeps the beat",
    async entry => {
      let finishDecode!: (audio: unknown) => void;
      decode.mockReturnValueOnce(new Promise(resolve => { finishDecode = resolve; }));
      const source = new File(["hq-wav"], `Durable ${entry}.wav`, { type: "audio/wav" });

      await act(async () => {
        if (entry === "drop") dispatchDrop(source);
        else await dispatchPicker(source);
        await vi.waitFor(() => expect(saveButton()).toBeDefined());
      });

      // Review must be usable before WAV → MASTER preparation finishes.
      expect(network.upload).not.toHaveBeenCalled();
      expect(network.replaceLibraryIndex).not.toHaveBeenCalled();

      await act(async () => {
        saveButton()!.click();
        await vi.waitFor(() => expect(saveButton()).toBeUndefined());
      });

      // The real Web queue has started, but commitImportedBeat must wait for MASTER.
      expect(network.upload).not.toHaveBeenCalled();
      expect(network.replaceLibraryIndex).not.toHaveBeenCalled();

      await act(async () => {
        finishDecode({
          length: 4410,
          numberOfChannels: 2,
          sampleRate: 44100,
          getChannelData: () => new Float32Array(4410),
        });
        await vi.waitFor(() => expect(network.replaceLibraryIndex).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(latestBeats.some(beat => beat.telegram_message_id === 100)).toBe(true));
      });

      expect(network.upload.mock.calls.map(([input]) => input.kind)).toEqual(["MASTER", "WAV"]);
      expect(persistedManifest.beats).toHaveLength(1);
      expect(persistedManifest.beats[0].name).toBe(`Durable ${entry}`);
      expect(persistedManifest.beats[0].master).toMatchObject({
        telegram_message_id: 100,
        filename: `Durable ${entry}.mp3`,
        mime: "audio/mpeg",
      });
      expect(persistedManifest.beats[0].files).toHaveLength(1);
      expect(persistedManifest.beats[0].files[0].manifest).toMatchObject({
        telegram_message_id: 101,
        filename: `Durable ${entry}.wav`,
      });
      expect(latestUploadErrors).toEqual({});

      // Fresh app-side library load: discard transport/window state and read only persisted INDEX.
      await platform.cloudData.disconnect();
      const reloaded = await platform.library.load();

      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]).toMatchObject({
        name: `Durable ${entry}`,
        telegram_message_id: 100,
        cloud_status: "CLOUD_ONLY",
        has_wav: true,
      });
      expect(reloaded[0].assets?.master?.object_id).toBe("direct:100");
      expect(reloaded[0].assets?.wav).toMatchObject({
        object_id: `WAV:${reloaded[0].id}`,
        filename: `Durable ${entry}.wav`,
      });
    },
  );
});
