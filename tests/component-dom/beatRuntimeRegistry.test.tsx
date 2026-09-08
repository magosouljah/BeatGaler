// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MutableRefObject } from "react";
import type { Beat } from "../../src/types";
import { useBeatRuntimeRegistry, type BeatRuntimeRegistry } from "../../src/features/state/useBeatRuntimeRegistry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latestRegistry: BeatRuntimeRegistry | null = null;
let latestBeatsRef: MutableRefObject<Beat[]>;

function beat(id: string, extra: Partial<Beat> = {}): Beat {
  return { id, name: id, tags: [], other_files: [], ...extra } as Beat;
}

function Harness({ beats }: { beats: Beat[] }) {
  latestBeatsRef.current = beats;
  latestRegistry = useBeatRuntimeRegistry(beats, latestBeatsRef);
  return <div>{Object.keys(latestRegistry.beatRuntimeStates).join(",")}</div>;
}

async function render(beats: Beat[]) {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root!.render(<Harness beats={beats} />);
  });
}

beforeEach(() => {
  latestRegistry = null;
  latestBeatsRef = { current: [] };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  latestRegistry = null;
});

describe("useBeatRuntimeRegistry", () => {
  it("hydrates visible beats and keeps the same session-local registry ref", async () => {
    const item = beat("cloud", { telegram_file_id: "file-1", offline_available: true });
    await render([item]);

    expect(latestRegistry!.beatRuntimeStates.cloud).toMatchObject({
      sync_state: "synced",
      download_state: "idle",
      playback_state: "idle",
      offline_available: true,
    });
    expect(latestRegistry!.beatRuntimeStatesRef.current.cloud).toBe(latestRegistry!.beatRuntimeStates.cloud);
  });

  it("preserves a deleting beat after its card disappears until the operation forgets it", async () => {
    const item = beat("deleting", { telegram_file_id: "file-2" });
    await render([item]);
    await act(async () => {
      latestRegistry!.transitionRuntime(item.id, { type: "SYNC_DELETE_STARTED" }, item);
    });

    await render([]);
    expect(latestRegistry!.beatRuntimeStates[item.id]?.sync_state).toBe("deleting");

    await act(async () => {
      latestRegistry!.forgetRuntimeState(item.id);
    });
    expect(latestRegistry!.beatRuntimeStates[item.id]).toBeUndefined();
  });

  it("preserves Offline Trash intent for a missing card and clears it only after reconciliation", async () => {
    const item = beat("trash", { telegram_file_id: "file-3" });
    await render([item]);
    await act(async () => {
      latestRegistry!.transitionRuntime(item.id, { type: "SET_TRASH_SYNC_REQUIRED", required: true }, item);
    });

    await render([]);
    expect(latestRegistry!.beatRuntimeStates[item.id]?.trash_sync_required).toBe(true);

    await act(async () => {
      latestRegistry!.clearReconciledTrashRuntimeStates();
    });
    expect(latestRegistry!.beatRuntimeStates[item.id]).toBeUndefined();
  });

  it("keeps sync, download and playback transitions in one registry", async () => {
    const item = beat("ops");
    await render([item]);

    await act(async () => { latestRegistry!.transitionRuntime(item.id, { type: "SYNC_QUEUE_UPLOAD" }, item); });
    await act(async () => { latestRegistry!.transitionRuntime(item.id, { type: "SYNC_UPLOAD_STARTED" }, item); });
    await act(async () => { latestRegistry!.transitionRuntime(item.id, { type: "DOWNLOAD_STARTED" }, item); });
    await act(async () => { latestRegistry!.transitionRuntime(item.id, { type: "PLAYBACK_PREPARING" }, item); });

    expect(latestRegistry!.beatRuntimeStates[item.id]).toMatchObject({
      sync_state: "uploading",
      download_state: "downloading",
      playback_state: "playback_preparing",
    });
  });
});
