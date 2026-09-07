// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";
import CloudFilesModal from "../../src/features/downloads/components/CloudFilesModal";
import BeatFileDropModal from "../../src/features/dragdrop/components/BeatFileDropModal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    id: "beat-1",
    name: "Purple Beat",
    mp3_path: null,
    wav_path: null,
    flp_path: null,
    als_path: null,
    offline_available: false,
    telegram_file_id: null,
    ...overrides,
  } as Beat;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("CloudFilesModal extraction", () => {
  it("keeps the portal, download choices and Close action", async () => {
    const onDownload = vi.fn();
    const onClose = vi.fn();
    const beat = makeBeat({ telegram_file_id: "remote-master" });

    await render(
      <CloudFilesModal
        beat={beat}
        files={[]}
        busyId={null}
        downloadedIds={new Set()}
        onDownload={onDownload}
        onClose={onClose}
      />
    );

    expect(host?.querySelector("button")).toBeNull();
    expect(document.body.textContent).toContain("Download Everything");
    const buttons = Array.from(document.body.querySelectorAll("button"));
    const mp3 = buttons.find(button => button.textContent?.includes("Master audio"));
    const wav = buttons.find(button => button.textContent?.includes("Original high-quality audio"));
    expect(mp3).toBeDefined();
    expect((mp3 as HTMLButtonElement).disabled).toBe(false);
    expect((wav as HTMLButtonElement).disabled).toBe(true);

    await click(mp3!);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith("MP3");

    const close = document.body.querySelector('button[aria-label="Close download window"]');
    expect(close).not.toBeNull();
    await click(close!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("BeatFileDropModal extraction", () => {
  it("keeps file-role availability, selection and Escape close", async () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();

    await render(
      <BeatFileDropModal
        beat={makeBeat()}
        filePath="C:/drop/replacement.mp3"
        fileName="replacement.mp3"
        fileExtension="mp3"
        isDirectory={false}
        onChoose={onChoose}
        onClose={onClose}
      />
    );

    expect(host?.querySelector("button")).toBeNull();
    expect(document.body.textContent).toContain("What are you adding?");
    expect(document.body.textContent).toContain("replacement.mp3");
    const buttons = Array.from(document.body.querySelectorAll("button"));
    const master = buttons.find(button => button.textContent?.includes("MASTER MP3"));
    const wav = buttons.find(button => button.textContent?.includes("WAV HQ"));
    const projectFolder = buttons.find(button => button.textContent?.includes("Add folder to Project"));
    expect((master as HTMLButtonElement).disabled).toBe(false);
    expect((wav as HTMLButtonElement).disabled).toBe(true);
    expect((projectFolder as HTMLButtonElement).disabled).toBe(true);

    await click(master!);
    expect(onChoose).toHaveBeenCalledWith("main");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the project-folder option available for directory drops", async () => {
    const onChoose = vi.fn();
    await render(
      <BeatFileDropModal
        beat={makeBeat()}
        filePath="C:/drop/Project Assets"
        fileName="Project Assets"
        fileExtension=""
        isDirectory
        onChoose={onChoose}
        onClose={() => undefined}
      />
    );

    const projectFolder = Array.from(document.body.querySelectorAll("button"))
      .find(button => button.textContent?.includes("Add folder to Project"));
    expect(projectFolder).toBeDefined();
    expect((projectFolder as HTMLButtonElement).disabled).toBe(false);
    await click(projectFolder!);
    expect(onChoose).toHaveBeenCalledWith("projectFolder");
  });
});
