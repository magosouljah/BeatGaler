import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ upload: vi.fn(), getLibraryIndex: vi.fn(), replaceLibraryIndex: vi.fn() }));
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
  },
}));
vi.mock("../../src/features/cloud/webTransportSession", () => ({
  ensureWebTransportTopic: vi.fn(async () => 42),
  commitWebTransportIndexPointer: vi.fn(async () => undefined),
}));
vi.mock("../../src/features/playback/webStartupPlaybackCoordinator", () => {
  let transport: WebGalerCloudTransport;
  return { getWebStartupPlaybackCoordinator: () => ({
    start: async () => undefined,
    getTransport: () => transport ||= new WebGalerCloudTransport(),
  }) };
});
vi.mock("../../src/lib/dialog", () => ({ appAlert: vi.fn(async () => undefined) }));

import { platform } from "../../src/platform";
import { appAlert } from "../../src/lib/dialog";
import { WebGalerCloudTransport } from "../../src/features/cloud/webGalerCloudTransport";
import { useBrowserImport } from "../../src/features/import/useBrowserImport";
import ImportReviewHost from "../../src/features/import/components/ImportReviewHost";
import type { ImportReviewQueueState } from "../../src/features/import/useImportSession";
import type { Beat } from "../../src/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let reviewed: Beat | undefined;
let committed: Beat | undefined;
let decode: ReturnType<typeof vi.fn>;

function Harness() {
  const [dropImporting, setDropImporting] = useState(false);
  const [reviewQueue, setReviewQueue] = useState<ImportReviewQueueState | null>(null);
  reviewed = reviewQueue?.beats[0];
  const { importDroppedBrowserFiles } = useBrowserImport({
    dropImporting, setDropImporting, setReviewQueue,
    rejectOfflineMutation: () => false,
    setDropActive: () => {}, setShowAdd: () => {},
    completeImmediateReviewPreparation: () => {}, resetImportResolutionState: () => {},
  });
  return <div onDrop={event => {
    event.preventDefault();
    void importDroppedBrowserFiles(Array.from(event.dataTransfer.files));
  }}>
    <ImportReviewHost libraryDropStaging={false} reviewBootstrap={null}
      reviewQueue={reviewQueue} skeletonEnabled tagSuggestions={[]} mutationAllowed
      onSkipCurrent={() => {}} onCancel={() => {}} isReviewNameTaken={() => false}
      onReleaseAudio={() => {}} onSaved={async (beat, progress) => {
        committed = await platform.cloudData.commitImportedBeat(beat, progress);
        setReviewQueue(null);
      }} />
  </div>;
}

function saveButton() {
  return Array.from(host.querySelectorAll("button")).find(item => item.textContent?.trim() === "Save and finish");
}
function dispatchDrop(file: File) {
  const event = new Event("drop", { bubbles: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
  host.firstElementChild!.dispatchEvent(event);
}

beforeEach(async () => {
  vi.clearAllMocks();
  committed = undefined;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:master") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  (window as any).jsmediatags = { read(_file: File, callbacks: any) { callbacks.onSuccess({ tags: {} }); } };
  decode = vi.fn(async () => ({ length: 4410, numberOfChannels: 2, sampleRate: 44100,
    getChannelData: () => new Float32Array(4410) }));
  vi.stubGlobal("OfflineAudioContext", class { decodeAudioData = decode; });
  network.getLibraryIndex.mockResolvedValue({ messageId: 500,
    manifest: { schema: "beatgaler.telegram.library", version: 2, beats: [], trash: [], deleted: [] } });
  network.replaceLibraryIndex.mockResolvedValue({ messageId: 900, previousMessageId: 500, beatCount: 1 });
  network.upload.mockImplementation(async ({ file, kind }: { file: File; kind: string }) => ({
    telegram_file_id: kind === "MASTER" ? "direct:100" : "direct:101",
    telegram_message_id: kind === "MASTER" ? 100 : 101, filename: file.name,
    original_size: file.size, parts: [], transport: "direct-web",
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  if (reviewed) platform.importer.releaseBeat(reviewed.id);
  await act(async () => root.unmount());
  host.remove();
  delete (window as any).jsmediatags;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Web drop → automatic MASTER → Review → Save", () => {
  it.each(["wav", "mp3"])("imports %s, saves the expected slots and always uses MASTER for playback", async extension => {
    const commit = vi.spyOn(platform.cloudData, "commitImportedBeat");
    const source = new File(["audio"], `Review.${extension}`, { type: extension === "wav" ? "audio/wav" : "audio/mpeg" });
    await act(async () => {
      dispatchDrop(source);
      await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    });
    const slots = platform.importer.slotFilesForBeat(reviewed!.id);
    expect(slots.MASTER?.name).toBe("Review.mp3");
    expect(slots.WAV).toBe(extension === "wav" ? source : undefined);
    if (extension === "mp3") expect(slots.MASTER).toBe(source);
    expect(reviewed!.playback_path).toBe("blob:master");
    expect(vi.mocked(URL.createObjectURL).mock.calls[0][0]).toBe(slots.MASTER);
    expect(saveButton()?.disabled).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(network.upload).not.toHaveBeenCalled();
    await act(async () => {
      saveButton()!.click();
      await vi.waitFor(() => expect(committed).toBeDefined());
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(network.upload.mock.calls.map(([input]) => input.kind)).toEqual(extension === "wav" ? ["MASTER", "WAV"] : ["MASTER"]);
    if (extension === "wav") expect(network.upload.mock.calls[1][0].file).toBe(source);
    expect(network.replaceLibraryIndex).toHaveBeenCalledOnce();
    const entry = network.replaceLibraryIndex.mock.calls[0][0].manifest.beats[0];
    expect(entry.master).toMatchObject({ filename: "Review.mp3", mime: "audio/mpeg", telegram_message_id: 100 });
    expect(entry.files).toHaveLength(extension === "wav" ? 1 : 0);
    expect(committed!.telegram_message_id).toBe(100);
    expect(committed!.playback_path).not.toContain(".wav");
    expect(saveButton()).toBeUndefined();
  });

  it("opens Review but never uploads an incomplete beat when WAV conversion fails", async () => {
    decode.mockRejectedValueOnce(new Error("Invalid WAV"));
    const commit = vi.spyOn(platform.cloudData, "commitImportedBeat");
    await act(async () => {
      dispatchDrop(new File(["broken"], "Broken.wav", { type: "audio/wav" }));
      await vi.waitFor(() => expect(appAlert).toHaveBeenCalled());
    });
    expect(appAlert).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Could not convert WAV to MASTER MP3 at 320 kbps") }));
    expect(saveButton()).toBeDefined();
    await act(async () => saveButton()!.click());
    expect(host.textContent).toContain("Could not convert WAV to MASTER MP3 at 320 kbps");
    expect(commit).toHaveBeenCalledOnce();
    expect(network.upload).not.toHaveBeenCalled();
    expect(network.replaceLibraryIndex).not.toHaveBeenCalled();
  });

  it("opens Review while conversion is pending and makes Save wait before uploading both slots", async () => {
    let finish!: (audio: unknown) => void;
    decode.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await act(async () => dispatchDrop(new File(["wav"], "Pending.wav", { type: "audio/wav" })));
    expect(saveButton()?.disabled).toBe(false);
    expect(host.textContent).toContain("Pending");
    expect(platform.importer.slotFilesForBeat(reviewed!.id).MASTER).toBeUndefined();
    await act(async () => saveButton()!.click());
    expect(network.upload).not.toHaveBeenCalled();
    expect(network.replaceLibraryIndex).not.toHaveBeenCalled();
    await act(async () => {
      finish({ length: 4410, numberOfChannels: 2, sampleRate: 44100, getChannelData: () => new Float32Array(4410) });
      await vi.waitFor(() => expect(committed).toBeDefined());
    });
    expect(network.upload.mock.calls.map(([input]) => input.kind)).toEqual(["MASTER", "WAV"]);
    expect(network.replaceLibraryIndex).toHaveBeenCalledOnce();
  });
});
