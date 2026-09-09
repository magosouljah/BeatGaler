// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, Beat } from "../../src/types";
import { useSessionState, type SessionState } from "../../src/features/session/useSessionState";
import { useSessionActions, type SessionActions } from "../../src/features/session/useSessionActions";
import { useCustomCursor } from "../../src/features/session/useCustomCursor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let session: SessionState | null = null;
let actions: SessionActions | null = null;
let setCursorEnabled: React.Dispatch<React.SetStateAction<boolean>> | null = null;
let latestBeats: Beat[] = [];
let latestRevealed = new Set<string>();
let revealRun = 0;
const logoutAccount = vi.fn(async () => undefined);
const releaseFile = vi.fn();
const clearPlaybackPreparation = vi.fn();
const clearArtworkHydration = vi.fn();
const clearSelection = vi.fn();
const beat = { id: "beat-1" } as Beat;

function Harness() {
  session = useSessionState();
  const [beats, setBeats] = useState<Beat[]>([beat]);
  const [revealed, setRevealedBeatIds] = useState<Set<string>>(() => new Set([beat.id]));
  const [cursorEnabled, setEnabled] = useState(true);
  const progressiveRevealRunRef = useRef(0);
  useCustomCursor(cursorEnabled);
  setCursorEnabled = setEnabled;
  latestBeats = beats;
  latestRevealed = revealed;
  revealRun = progressiveRevealRunRef.current;
  actions = useSessionActions({
    setSettings: session.setSettings,
    setCloudSessionVerified: session.setCloudSessionVerified,
    logoutAccount,
    releaseFile,
    progressiveRevealRunRef,
    clearPlaybackPreparation,
    clearArtworkHydration,
    setRevealedBeatIds,
    setBeats,
    clearSelection,
  });
  return null;
}

async function renderHarness() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
}

beforeEach(() => {
  logoutAccount.mockClear();
  releaseFile.mockClear();
  clearPlaybackPreparation.mockClear();
  clearArtworkHydration.mockClear();
  clearSelection.mockClear();
  document.getElementById("beatgaler-custom-cursor-style")?.remove();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  session = null;
  actions = null;
  setCursorEnabled = null;
  document.getElementById("beatgaler-custom-cursor-style")?.remove();
});

describe("session ownership", () => {
  it("keeps connectivity and cloud verification as independent state", async () => {
    await renderHarness();
    await act(async () => {
      session!.setConnectionState("poor");
      session!.setCloudSessionVerified(true);
    });
    expect(session!.connectionState).toBe("poor");
    expect(session!.cloudSessionVerified).toBe(true);
    await act(async () => { session!.setCloudSessionVerified(false); });
    expect(session!.connectionState).toBe("poor");
    expect(session!.cloudSessionVerified).toBe(false);
  });

  it("owns local preference mutations and the custom cursor effect", async () => {
    await renderHarness();
    expect(document.getElementById("beatgaler-custom-cursor-style")?.textContent).toContain("beatgaler-custom-cursor.cur");
    await act(async () => {
      actions!.handleIncompleteWarningsChanged(false);
      actions!.handleCustomCursorChanged(false);
      actions!.handleFolderChanged("C:/Beats");
    });
    expect(session!.settings).toMatchObject({
      beats_folder: "C:/Beats",
      incomplete_warnings_enabled: false,
      custom_cursor_enabled: false,
    } satisfies Partial<AppSettings>);
    await act(async () => { setCursorEnabled!(false); });
    expect(document.getElementById("beatgaler-custom-cursor-style")).toBeNull();
  });

  it("preserves sign-out cleanup of audio, presentation and session state", async () => {
    await renderHarness();
    await act(async () => {
      session!.setSettings({
        beats_folder: null,
        incomplete_warnings_enabled: true,
        custom_cursor_enabled: true,
        telegram_cloud_connected: true,
        telegram_cloud_username: "linked-user",
      });
      session!.setCloudSessionVerified(true);
    });
    await act(async () => { await actions!.handleDisconnectTelegramAccount(); });
    expect(logoutAccount).toHaveBeenCalledTimes(1);
    expect(releaseFile).toHaveBeenCalledTimes(1);
    expect(clearPlaybackPreparation).toHaveBeenCalledTimes(1);
    expect(clearArtworkHydration).toHaveBeenCalledTimes(1);
    expect(clearSelection).toHaveBeenCalledTimes(1);
    expect(session!.cloudSessionVerified).toBe(false);
    expect(session!.settings?.telegram_cloud_connected).toBe(false);
    expect(session!.settings?.telegram_cloud_username).toBeNull();
    expect(latestBeats).toEqual([]);
    expect(Array.from(latestRevealed)).toEqual([]);
    expect(revealRun).toBe(1);
  });
});
