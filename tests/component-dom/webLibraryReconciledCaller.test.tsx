import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import {
  useWebLibraryReconciled,
  WEB_LIBRARY_RECONCILED_EVENT,
} from "../../src/features/library/useWebLibraryReconciled";

function beat(id: string): Beat {
  return {
    id,
    name: id,
    bpm: "120",
    key: "Cm",
    tags: [],
    rating: 0,
    color: "#111111",
    color2: "#222222",
    telegram_message_id: 100,
    telegram_file_id: "direct:100",
    playback_path: "",
    mp3_path: "",
    wav_path: null,
    image_base64: null,
  } as Beat;
}

describe("Web reconciled library caller", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("delivers the authoritative reconciled page immediately to the live UI caller", async () => {
    const onReconciled = vi.fn();
    function Caller() {
      useWebLibraryReconciled(true, onReconciled);
      return null;
    }
    await act(async () => root.render(<Caller />));

    const reconciled = [beat("beat-2")];
    await act(async () => {
      window.dispatchEvent(new CustomEvent(WEB_LIBRARY_RECONCILED_EVENT, {
        detail: { beats: reconciled },
      }));
    });

    expect(onReconciled).toHaveBeenCalledTimes(1);
    expect(onReconciled).toHaveBeenCalledWith(reconciled);
  });

  it("does nothing on Desktop/disabled callers", async () => {
    const onReconciled = vi.fn();
    function Caller() {
      useWebLibraryReconciled(false, onReconciled);
      return null;
    }
    await act(async () => root.render(<Caller />));
    window.dispatchEvent(new CustomEvent(WEB_LIBRARY_RECONCILED_EVENT, {
      detail: { beats: [beat("beat-1")] },
    }));
    expect(onReconciled).not.toHaveBeenCalled();
  });
});
