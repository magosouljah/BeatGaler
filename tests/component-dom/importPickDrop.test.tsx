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
import { useCatalogFileDrop } from "../../src/features/library/catalog/useCatalogFileDrop";
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

describe("useCatalogFileDrop (imagen/audio/archivo; la tarjeta decide el destino, el tipo la acción)", () => {
  let root: Root; let host: HTMLDivElement; const onDrop = vi.fn();
  const artworkEvents: Array<string | null> = []; const updateEvents: Array<string | null> = [];
  const onA = (e: Event) => artworkEvents.push((e as CustomEvent).detail.active ? (e as CustomEvent).detail.beatId : null);
  const onU = (e: Event) => updateEvents.push((e as CustomEvent).detail.active ? (e as CustomEvent).detail.beatId : null);
  function Probe({ enabled }: { enabled: boolean }) { const a = useCatalogFileDrop({ enabled, onDrop }); return <><i data-active={String(a.active)} data-target={String(a.targetId)} data-kind={a.kind} /><div data-beat-card-id="b-7" data-card="b-7" id="card7"><div id="tags"><span id="inner">x</span></div></div></>; }
  const ev = (type: string, files: File[], itemTypes: string[] = ["image/png"], target: EventTarget = window, extraTypes: string[] = []) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { types: ["Files", ...extraTypes], files, items: files.length ? itemTypes.map((t) => ({ kind: "file", type: t })) : itemTypes.map((t) => ({ kind: "file", type: t })), dropEffect: "none" } });
    target.dispatchEvent(e); return e;
  };
  const state = (k: string) => host.querySelector("i")!.getAttribute(`data-${k}`);
  beforeEach(() => { vi.clearAllMocks(); artworkEvents.length = 0; updateEvents.length = 0; window.addEventListener("beatgaler:artwork-drag", onA); window.addEventListener("beatgaler:beat-update-drag", onU); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); window.removeEventListener("beatgaler:artwork-drag", onA); window.removeEventListener("beatgaler:beat-update-drag", onU); });
  const inner = () => document.getElementById("inner")!;

  it("imagen sobre CUALQUIER zona de la tarjeta (tags, hueco, texto) activa el indicador de PORTADA y nunca el de audio", () => {
    act(() => { root.render(<Probe enabled />); });
    for (const target of [inner(), document.getElementById("tags")!, document.getElementById("card7")!]) {
      artworkEvents.length = 0; updateEvents.length = 0;
      act(() => { ev("dragenter", [], ["image/png"], target); ev("dragover", [], ["image/png"], target); });
      expect(artworkEvents.at(-1)).toBe("b-7"); expect(updateEvents.every((x) => x === null)).toBe(true); expect(state("kind")).toBe("image"); expect(state("target")).toBe("b-7");
      act(() => { ev("dragleave", [], ["image/png"], target); }); expect(state("active")).toBe("false");
    }
  });
  it("MP3/WAV/archivo sobre la tarjeta activa el indicador de reemplazo de audio (tarjeta), no el de portada", () => {
    act(() => { root.render(<Probe enabled />); });
    for (const t of ["audio/mpeg", "audio/wav", ""]) {
      artworkEvents.length = 0; updateEvents.length = 0;
      act(() => { ev("dragenter", [], [t], inner()); ev("dragover", [], [t], inner()); });
      expect(updateEvents.at(-1)).toBe("b-7"); expect(artworkEvents.every((x) => x === null)).toBe(true);
      act(() => { ev("dragleave", [], [t], inner()); });
    }
  });
  it("fuera de una tarjeta: banner global (sin indicador de tarjeta); al pasar de la tarjeta al vacío los indicadores se apagan", () => {
    act(() => { root.render(<Probe enabled />); });
    act(() => { ev("dragenter", [], ["audio/mpeg"], inner()); ev("dragover", [], ["audio/mpeg"], inner()); }); expect(updateEvents.at(-1)).toBe("b-7");
    act(() => { ev("dragover", [], ["audio/mpeg"], document.body); }); expect(updateEvents.at(-1)).toBeNull(); expect(state("target")).toBe("null"); expect(state("active")).toBe("true");
  });
  it("drop: entrega archivos, fuentes de imagen y el id de la tarjeta; apaga los indicadores; un drop fuera entrega null", () => {
    act(() => { root.render(<Probe enabled />); });
    const f = mp3("x.mp3");
    act(() => { ev("dragenter", [f], ["audio/mpeg"], inner()); ev("dragover", [f], ["audio/mpeg"], inner()); const e = ev("drop", [f], ["audio/mpeg"], inner()); expect(e.defaultPrevented).toBe(true); });
    expect(onDrop).toHaveBeenLastCalledWith(expect.objectContaining({ files: [f], targetBeatId: "b-7" })); expect(updateEvents.at(-1)).toBeNull(); expect(state("active")).toBe("false");
    act(() => { ev("dragenter", [f], ["audio/mpeg"], document.body); ev("drop", [f], ["audio/mpeg"], document.body); });
    expect(onDrop).toHaveBeenLastCalledWith(expect.objectContaining({ files: [f], targetBeatId: null }));
  });
  it("arrastres que no son de archivos/imagen se ignoran; con un modal abierto el drop se cancela pero no se procesa", () => {
    act(() => { root.render(<Probe enabled />); });
    const e = new Event("dragover", { cancelable: true }); Object.defineProperty(e, "dataTransfer", { value: { types: ["text/x-nothing"], files: [], items: [] } }); window.dispatchEvent(e); expect(e.defaultPrevented).toBe(false);
    act(() => { root.render(<Probe enabled={false} />); });
    act(() => { const d = ev("drop", [mp3("z.mp3")], ["audio/mpeg"], inner()); expect(d.defaultPrevented).toBe(true); }); expect(onDrop).not.toHaveBeenCalled();
  });
});

describe("AddBeatModal(initialFile)", () => {
  let root: Root; let host: HTMLDivElement;
  beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const candidate = (name: string) => { const beat = { id: `drop_${name}`, name: name.replace(/\.[^.]+$/, ""), mp3_path: name, tags: [] } as unknown as Beat; port.fromFile.mockReturnValue({ beat, hydrated: Promise.resolve(beat) }); port.fileForBeat.mockReturnValue(new File([], name)); return beat; };
  const mountModal = (file: File, onAdd = vi.fn(), onClose = vi.fn()) => { act(() => { root.render(<AddBeatModal onClose={onClose} onAdd={onAdd} existingBeats={[]} maxNameChars={50} initialFile={file} />); }); return { onAdd, onClose }; };
  it("archivo soltado con nombre válido: se importa por el mismo flujo (onAdd con el beat) y cierra", async () => {
    const beat = candidate("Soltado corto.mp3"); const { onAdd, onClose } = mountModal(mp3("Soltado corto.mp3"));
    await act(async () => { await Promise.resolve(); });
    expect(port.fromFile).toHaveBeenCalledTimes(1); expect(onAdd).toHaveBeenCalledWith([beat], [expect.any(Promise)]); expect(onClose).toHaveBeenCalled();
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
