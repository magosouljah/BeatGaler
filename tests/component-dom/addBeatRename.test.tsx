// @vitest-environment jsdom
// «Add beat» (Web, catálogo nativo): si el nombre derivado del archivo supera 50 caracteres Unicode se pide editarlo ANTES de subir.
// El archivo original no se modifica; el nombre editado es el metadato del beat; sin subir hasta que sea válido; con nombre válido no hay pasos extra.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const port = vi.hoisted(() => ({ pickBeat: vi.fn(), releaseBeat: vi.fn(), fileForBeat: vi.fn() }));
vi.mock("../../src/platform", () => ({
  platform: {
    capabilities: { browserFileImport: true },
    importer: { pickBeat: port.pickBeat, releaseBeat: port.releaseBeat, fileForBeat: port.fileForBeat },
  },
}));

import AddBeatModal from "../../src/components/AddBeatModal";
import type { Beat } from "../../src/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
const onAdd = vi.fn(); const onClose = vi.fn(); const hydrated = vi.fn();
const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

function candidateFor(fileName: string) {
  const file = new File([new Uint8Array(10)], fileName, { type: "audio/mpeg" });
  const beat = { id: `local_file_${fileName}`, name: fileName.replace(/\.[^.]+$/, ""), mp3_path: fileName, folder_path: fileName, tags: [], bpm: "", key: "", rating: 0 } as unknown as Beat;
  port.fileForBeat.mockImplementation((id: string) => (id === beat.id ? file : null));
  port.pickBeat.mockResolvedValue({ beat, hydrated: Promise.resolve(beat) });
  return { file, beat };
}
function mount(maxNameChars: number | null = 50) {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => { root.render(<AddBeatModal onClose={onClose} onAdd={onAdd} onCandidateHydrated={hydrated} existingBeats={[]} maxNameChars={maxNameChars ?? undefined} />); });
}
const q = (sel: string) => host.querySelector(sel) as HTMLElement | null;
async function pick() { const btn = Array.from(host.querySelectorAll("button")).find((b) => /Choose MP3 or WAV/.test(b.textContent || ""))!; await act(async () => { btn.click(); }); await flush(); }
function type(value: string) {
  const input = q("#add-beat-name") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const confirmBtn = () => q("[data-testid='add-beat-confirm']") as HTMLButtonElement;

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("Add beat: nombre ≤ 50 caracteres", () => {
  it("nombre válido: flujo actual sin pasos adicionales (se añade y cierra de inmediato)", async () => {
    const { beat } = candidateFor("Galer Beat.mp3");
    mount(); await pick();
    expect(q("#add-beat-name")).toBeNull();
    expect(onAdd).toHaveBeenCalledTimes(1); expect(onAdd.mock.calls[0][0]).toEqual([beat]); expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("nombre > 50: paso de edición con el archivo original visible; no sube hasta que sea válido; Enter/clic confirma con el nombre editado y el archivo intacto", async () => {
    const { beat, file } = candidateFor("Mi beat larguísimo de prueba v2 con un título aún más extenso para superar el límite.mp3");
    mount(); await pick();
    expect(onAdd).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(q("[data-testid='add-beat-original-file']")!.textContent).toBe("Mi beat larguísimo de prueba v2 con un título aún más extenso para superar el límite.mp3");
    expect((q("#add-beat-name") as HTMLInputElement).value).toBe("Mi beat larguísimo de prueba v2 con un título aún más extenso para superar el límite"); // prellenado, sin recortar
    expect(confirmBtn().disabled).toBe(true);
    expect(q("[data-testid='add-beat-name-hint']")!.textContent).toMatch(/Máximo 50 caracteres \(tiene 84\)/);
    type("ñ".repeat(51)); expect(confirmBtn().disabled).toBe(true); expect(q("[data-testid='add-beat-name-count']")!.textContent).toBe("51 / 50");
    type("   "); expect(confirmBtn().disabled).toBe(true); expect(q("[data-testid='add-beat-name-hint']")!.textContent).toMatch(/Escribe un nombre/);
    type("  " + "ñ".repeat(50) + " "); expect(confirmBtn().disabled).toBe(false); expect(q("[data-testid='add-beat-name-count']")!.textContent).toBe("50 / 50");
    await act(async () => { confirmBtn().click(); }); await flush();
    expect(onAdd).toHaveBeenCalledTimes(1);
    const [added] = onAdd.mock.calls[0][0] as Beat[];
    expect(added.name).toBe("ñ".repeat(50)); // metadato editado y recortado solo en los bordes por el usuario
    expect([added.id, added.mp3_path, added.folder_path]).toEqual([beat.id, beat.mp3_path, beat.folder_path]); // identidad y archivo originales intactos
    expect(port.fileForBeat(beat.id)).toBe(file); expect(file.name).toBe("Mi beat larguísimo de prueba v2 con un título aún más extenso para superar el límite.mp3");
    expect(onClose).toHaveBeenCalledTimes(1); expect(port.releaseBeat).not.toHaveBeenCalled();
    expect(hydrated).toHaveBeenCalledTimes(1);
  });

  it("Enter con nombre inválido no sube; con válido sí", async () => {
    candidateFor("Un nombre de archivo que es demasiado largo para caber en cincuenta caracteres.mp3");
    mount(); await pick();
    const input = q("#add-beat-name") as HTMLInputElement;
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onAdd).not.toHaveBeenCalled();
    type("Corto"); act(() => { (q("#add-beat-name") as HTMLInputElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("cancelar o cerrar libera el archivo elegido, no sube nada y no modifica el original", async () => {
    candidateFor("Un nombre de archivo que es demasiado largo para caber en cincuenta caracteres.mp3");
    mount(); await pick();
    const cancel = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Cancel")!;
    act(() => { cancel.click(); });
    expect(onAdd).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledTimes(1); expect(port.releaseBeat).toHaveBeenCalledWith("local_file_Un nombre de archivo que es demasiado largo para caber en cincuenta caracteres.mp3");
  });

  it("cuenta code points Unicode: 50 emojis son válidos y 51 no; un nombre con 50 acentos también", async () => {
    candidateFor("Un nombre de archivo que es demasiado largo para caber en cincuenta caracteres.mp3");
    mount(); await pick();
    type("🎵".repeat(51)); expect(confirmBtn().disabled).toBe(true); expect(q("[data-testid='add-beat-name-count']")!.textContent).toBe("51 / 50");
    type("🎵".repeat(50)); expect(confirmBtn().disabled).toBe(false);
    type("é".repeat(50)); expect(confirmBtn().disabled).toBe(false);
  });

  it("sin maxNameChars (flujo LEGACY) un nombre largo pasa tal cual, sin paso de edición", async () => {
    const { beat } = candidateFor("Un nombre de archivo que es demasiado largo para caber en cincuenta caracteres.mp3");
    mount(null); await pick();
    expect(q("#add-beat-name")).toBeNull(); expect(onAdd.mock.calls[0][0]).toEqual([beat]);
  });
});

import { importFailureMessage } from "../../src/features/library/catalog/useCatalogGalleryScope";
describe("Add beat: aviso de fallo de importación", () => {
  it("sin transporte configurado (TRANSFER_UNAVAILABLE) lo dice claro y confirma que no se guardó; otros errores conservan su mensaje", () => {
    expect(importFailureMessage({ code: "TRANSFER_UNAVAILABLE", message: "no transfer gateway is configured" })).toMatch(/no está disponible.*no se guardó/s);
    expect(importFailureMessage(new Error("El nombre admite como máximo 50 caracteres"))).toBe("El nombre admite como máximo 50 caracteres");
  });
});
