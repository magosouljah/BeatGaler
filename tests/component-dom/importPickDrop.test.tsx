// @vitest-environment jsdom
// «Choose MP3 or WAV» (carrera focus/change) y arrastrar y soltar MP3/WAV en la Gallery POSTGRES.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const port = vi.hoisted(() => ({ pickBeat: vi.fn(), releaseBeat: vi.fn(), fileForBeat: vi.fn(), fromFile: vi.fn() }));
vi.mock("../../src/platform", () => ({
  platform: { capabilities: { browserFileImport: true }, importer: { pickBeat: port.pickBeat, releaseBeat: port.releaseBeat, fileForBeat: port.fileForBeat, fromFile: port.fromFile } },
}));

import AddBeatModal from "../../src/components/AddBeatModal";
import { pickOneAudioFile, PICK_FOCUS_GRACE_MS } from "../../src/platform/webImport";
import { pickDroppedAudio, useCatalogFileDrop } from "../../src/features/library/catalog/useCatalogFileDrop";
import type { Beat } from "../../src/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mp3 = (name: string) => new File([new Uint8Array(8)], name, { type: "audio/mpeg" });

describe("pickOneAudioFile: carrera focus → change", () => {
  let input: HTMLInputElement;
  beforeEach(() => {
    vi.useFakeTimers();
    const append = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation(((n: Node) => { if (n instanceof HTMLInputElement) { input = n; vi.spyOn(n, "click").mockImplementation(() => {}); } return append(n); }) as typeof document.body.appendChild);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const setFiles = (f: File | null) => Object.defineProperty(input, "files", { configurable: true, value: f ? [f] : [] });

  it("focus llega ANTES que change (Chrome/Edge): la selección no se pierde", async () => {
    const p = pickOneAudioFile();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0); // el antiguo setTimeout(0) resolvía null aquí
    await vi.advanceTimersByTimeAsync(60);
    setFiles(mp3("a.mp3")); input.dispatchEvent(new Event("change"));
    expect((await p)?.name).toBe("a.mp3");
  });
  it("focus y archivo presente sin evento change: lo recoge el sondeo", async () => {
    const p = pickOneAudioFile();
    window.dispatchEvent(new Event("focus"));
    setFiles(mp3("b.mp3")); await vi.advanceTimersByTimeAsync(150);
    expect((await p)?.name).toBe("b.mp3");
  });
  it("change sin focus entrega el archivo", async () => {
    const p = pickOneAudioFile(); setFiles(mp3("c.wav")); input.dispatchEvent(new Event("change"));
    expect((await p)?.name).toBe("c.wav");
  });
  it("cancelación: evento cancel → null; focus sin archivo → null solo tras la gracia", async () => {
    const p1 = pickOneAudioFile(); input.dispatchEvent(new Event("cancel")); expect(await p1).toBeNull();
    const p2 = pickOneAudioFile(); setFiles(null); window.dispatchEvent(new Event("focus"));
    let done = false; void p2.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(PICK_FOCUS_GRACE_MS - 200); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(400); expect(await p2).toBeNull();
    expect(document.querySelector("input[type=file]")).toBeNull();
  });
});

describe("pickDroppedAudio", () => {
  it("un MP3/WAV es válido; varios o ninguno no", () => {
    expect(pickDroppedAudio([mp3("x.mp3")])).toMatchObject({ kind: "ok" });
    expect(pickDroppedAudio([new File([], "x.WAV")])).toMatchObject({ kind: "ok" });
    expect(pickDroppedAudio([mp3("x.mp3"), mp3("y.mp3")]).kind).toBe("many");
    expect(pickDroppedAudio([new File([], "x.txt", { type: "text/plain" })]).kind).toBe("none");
    expect(pickDroppedAudio([]).kind).toBe("none");
  });
});

describe("useCatalogFileDrop + AddBeatModal(initialFile)", () => {
  let root: Root; let host: HTMLDivElement; const onFiles = vi.fn();
  function Probe({ enabled }: { enabled: boolean }) { const a = useCatalogFileDrop({ enabled, onFiles }); return <><i data-active={String(a.active)} data-target={String(a.targetId)} /><div data-card="b-7" id="card7"><span id="inner">x</span></div></>; }
  const ev = (type: string, files: File[], types = ["Files"], target: EventTarget = window) => { const e = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(e, "dataTransfer", { value: { types, files, dropEffect: "none" } }); target.dispatchEvent(e); return e; };
  beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("arrastre de archivos activa el aviso; drop entrega los archivos y lo apaga; arrastres que no son archivos se ignoran", () => {
    act(() => { root.render(<Probe enabled />); });
    const state = () => host.querySelector("i")!.getAttribute("data-active");
    act(() => { ev("dragenter", []); }); expect(state()).toBe("true");
    act(() => { const e = ev("drop", [mp3("z.mp3")]); expect(e.defaultPrevented).toBe(true); }); expect(state()).toBe("false"); expect(onFiles).toHaveBeenCalledTimes(1);
    act(() => { const e = ev("dragenter", [], ["text/plain"]); expect(e.defaultPrevented).toBe(false); }); expect(state()).toBe("false");
  });
  it("la tarjeta tiene prioridad: soltar sobre una BeatCard entrega su id; fuera de una tarjeta, null (beat nuevo)", () => {
    act(() => { root.render(<Probe enabled />); });
    const tgt = () => host.querySelector("i")!.getAttribute("data-target");
    act(() => { ev("dragenter", [], ["Files"], document.getElementById("inner")!); ev("dragover", [], ["Files"], document.getElementById("inner")!); }); expect(tgt()).toBe("b-7");
    act(() => { ev("dragover", [], ["Files"], document.body); }); expect(tgt()).toBe("null");
    act(() => { ev("dragover", [], ["Files"], document.getElementById("inner")!); }); expect(tgt()).toBe("b-7");
    const f = mp3("sobre-tarjeta.mp3");
    act(() => { ev("drop", [f], ["Files"], document.getElementById("inner")!); }); expect(onFiles).toHaveBeenLastCalledWith([f], "b-7"); expect(tgt()).toBe("null");
    act(() => { ev("dragenter", []); ev("drop", [f], ["Files"], document.body); }); expect(onFiles).toHaveBeenLastCalledWith([f], null);
  });
  it("con un modal abierto (enabled=false) el drop se ignora pero se cancela (el navegador no abre el archivo)", () => {
    act(() => { root.render(<Probe enabled={false} />); });
    act(() => { const e = ev("drop", [mp3("z.mp3")]); expect(e.defaultPrevented).toBe(true); }); expect(onFiles).not.toHaveBeenCalled();
  });

  const candidate = (name: string) => { const beat = { id: `drop_${name}`, name: name.replace(/\.[^.]+$/, ""), mp3_path: name, tags: [] } as unknown as Beat; port.fromFile.mockReturnValue({ beat, hydrated: Promise.resolve(beat) }); port.fileForBeat.mockReturnValue(new File([], name)); return beat; };
  const mountModal = (file: File, onAdd = vi.fn(), onClose = vi.fn()) => { act(() => { root.render(<AddBeatModal onClose={onClose} onAdd={onAdd} existingBeats={[]} maxNameChars={50} initialFile={file} />); }); return { onAdd, onClose }; };
  it("archivo soltado con nombre válido: se importa por el mismo flujo (onAdd con el beat) y cierra", async () => {
    const beat = candidate("Soltado corto.mp3"); const { onAdd, onClose } = mountModal(mp3("Soltado corto.mp3"));
    await act(async () => { await Promise.resolve(); });
    expect(port.fromFile).toHaveBeenCalledTimes(1); expect(onAdd).toHaveBeenCalledWith([beat]); expect(onClose).toHaveBeenCalled();
  });
  it("archivo soltado con nombre > 50: pide renombrar y no sube hasta confirmar un nombre válido", async () => {
    const long = "x".repeat(60) + ".mp3"; candidate(long); const { onAdd } = mountModal(mp3(long));
    await act(async () => { await Promise.resolve(); });
    expect(onAdd).not.toHaveBeenCalled();
    const input = host.querySelector("#add-beat-name") as HTMLInputElement; expect(input.value).toBe("x".repeat(60));
    const confirm = host.querySelector("[data-testid='add-beat-confirm']") as HTMLButtonElement; expect(confirm.disabled).toBe(true);
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { set.call(input, "Nombre ok"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { (host.querySelector("[data-testid='add-beat-confirm']") as HTMLButtonElement).click(); });
    expect(onAdd).toHaveBeenCalledTimes(1); expect((onAdd.mock.calls[0][0] as Beat[])[0].name).toBe("Nombre ok");
  });
});
