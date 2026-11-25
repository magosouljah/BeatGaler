// @vitest-environment node
// Reemplazo de audio por arrastre sobre una BeatCard: confirmación previa, MASTER (MP3) / WAV (añadir o reemplazar), identidad y metadatos intactos,
// nunca un beat nuevo, conflicto/fallo/cancelación sin efecto.
import { describe, expect, it, vi } from "vitest";
import { classifyDroppedAudio } from "../../src/features/library/catalog/catalogDropKinds";
import { createBeatEditor } from "../../src/features/library/catalog/catalogBeatEditor";

const detail = (over: Record<string, unknown> = {}) => ({ id: "b-1", name: "Mi beat", bpm: "140", key: "Am", tags: ["trap"], rating: 3, color: "#111111", color2: "#222222", version: "9", hasWav: false, playback: { fileId: "f-1", revision: "1" }, artwork: null, hasProject: false, ...over });
const editorOf = (mutations: never, loadProject: (id: string) => Promise<File | null> = async () => null) =>
  createBeatEditor({ mutations: mutations as never, knownDto: () => undefined, loadProject, errorMessage: (e) => String((e as Error)?.message ?? e) });
const replaceBeatAudio = ({ mutations, beatId, file, loadProject, ...options }: { mutations: never; beatId: string; file: File; loadProject?: (id: string) => Promise<File | null>; confirm: (o: { title: string; message: string; confirmLabel: string }) => Promise<boolean> }) =>
  editorOf(mutations, loadProject).replaceAudio(beatId, file, options);
const file = (name: string, type = "") => new File([new Uint8Array(4)], name, { type });
function harness(d = detail(), outcome: unknown = { status: "committed", operationId: "op", beatId: "b-1", version: "10", revision: "50", operation: {} }) {
  const getBeat = vi.fn(async () => d);
  const replaceBeat = vi.fn(async () => outcome);
  const importBeat = vi.fn();
  return { getBeat, replaceBeat, importBeat, mutations: { getBeat, replaceBeat } as never };
}

describe("classifyDroppedAudio", () => {
  it("MP3, WAV y nada", () => {
    expect(classifyDroppedAudio(file("a.mp3"))).toBe("MP3"); expect(classifyDroppedAudio(file("a.WAV"))).toBe("WAV");
    expect(classifyDroppedAudio(file("x", "audio/mpeg"))).toBe("MP3"); expect(classifyDroppedAudio(file("x", "audio/x-wav"))).toBe("WAV");
    expect(classifyDroppedAudio(file("a.txt", "text/plain"))).toBeNull();
  });
});

describe("replaceBeatAudio", () => {
  it("MP3 sobre una tarjeta: confirma y reemplaza el MASTER del MISMO beat; metadatos intactos; no crea beat", async () => {
    const h = harness(); const confirm = vi.fn(async () => true); const f = file("nuevo.mp3", "audio/mpeg");
    const r = await replaceBeatAudio({ mutations: h.mutations, confirm, beatId: "b-1", file: f });
    expect(r).toMatchObject({ reading: "success", status: "committed", kind: "MP3" });
    expect(confirm).toHaveBeenCalledTimes(1); expect(confirm.mock.calls[0][0].title).toBe("Replace MP3?"); expect(confirm.mock.calls[0][0].message).toContain("Mi beat");
    const arg = h.replaceBeat.mock.calls[0][0] as { beatId: string; expectedVersion: string; original: unknown; updated: unknown; files: Record<string, File> };
    expect(arg.beatId).toBe("b-1"); expect(arg.expectedVersion).toBe("9"); expect(arg.files).toEqual({ master: f });
    expect(arg.updated).toBe(arg.original); // ningún cambio de metadatos: solo archivos
    expect(h.importBeat).not.toHaveBeenCalled();
  });
  it("WAV sobre un beat sin WAV: «Add WAV?» y se añade como wav; con WAV existente: «Replace WAV?»", async () => {
    const a = harness(); const c1 = vi.fn(async () => true); const w = file("hq.wav", "audio/wav");
    expect(await replaceBeatAudio({ mutations: a.mutations, confirm: c1, beatId: "b-1", file: w })).toMatchObject({ reading: "success", status: "committed", kind: "WAV", replacedExisting: false });
    expect(c1.mock.calls[0][0]).toMatchObject({ title: "Add WAV?", confirmLabel: "Add" }); expect((a.replaceBeat.mock.calls[0][0] as { files: unknown }).files).toEqual({ wav: w });
    const b = harness(detail({ hasWav: true })); const c2 = vi.fn(async () => true);
    expect(await replaceBeatAudio({ mutations: b.mutations, confirm: c2, beatId: "b-1", file: w })).toMatchObject({ reading: "success", status: "committed", kind: "WAV", replacedExisting: true });
    expect(c2.mock.calls[0][0]).toMatchObject({ title: "Replace WAV?", confirmLabel: "Replace" });
  });
  it("cancelar la confirmación no sube ni cambia nada", async () => {
    const h = harness();
    expect(await replaceBeatAudio({ mutations: h.mutations, confirm: async () => false, beatId: "b-1", file: file("n.mp3") })).toEqual({ reading: "not-started", why: "cancelled" });
    expect(h.replaceBeat).not.toHaveBeenCalled();
  });
  it("archivo no soportado: no consulta ni pregunta", async () => {
    const h = harness(); const confirm = vi.fn();
    expect(await replaceBeatAudio({ mutations: h.mutations, confirm, beatId: "b-1", file: file("n.txt", "text/plain") })).toEqual({ reading: "not-started", why: "unsupported" });
    expect(h.getBeat).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it("conflicto, estado no confirmado o error: failed con aviso, sin éxito falso", async () => {
    const conflict = harness(detail(), { status: "conflict", operationId: "op", beatId: "b-1", operation: null, retained: false, error: null });
    expect(await replaceBeatAudio({ mutations: conflict.mutations, confirm: async () => true, beatId: "b-1", file: file("n.mp3") })).toMatchObject({ reading: "rejected", why: "conflict", message: expect.stringContaining("cambió en otro dispositivo") });
    const failed = harness(detail(), { status: "failed", operationId: "op", beatId: "b-1", operation: null, retained: true, error: null });
    expect(await replaceBeatAudio({ mutations: failed.mutations, confirm: async () => true, beatId: "b-1", file: file("n.mp3") })).toMatchObject({ reading: "rejected", why: "failed", message: expect.stringContaining("conserva su archivo actual") });
    const boom = harness(); boom.replaceBeat.mockRejectedValueOnce(new Error("TRANSFER_UNAVAILABLE"));
    expect(await replaceBeatAudio({ mutations: boom.mutations, confirm: async () => true, beatId: "b-1", file: file("n.mp3") })).toMatchObject({ reading: "rejected", why: "error", message: "TRANSFER_UNAVAILABLE" });
    const gone = harness(); gone.getBeat.mockRejectedValueOnce(new Error("404")); const confirm = vi.fn();
    expect(await replaceBeatAudio({ mutations: gone.mutations, confirm, beatId: "b-1", file: file("n.mp3") })).toMatchObject({ reading: "rejected", why: "error" }); expect(confirm).not.toHaveBeenCalled();
  });
});
