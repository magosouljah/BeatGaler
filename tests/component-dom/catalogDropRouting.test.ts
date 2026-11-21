// @vitest-environment node
// Drag & drop de la Gallery POSTGRES: la ACCIÓN depende del tipo de archivo; la tarjeta solo decide el destino. Portada por imagen.
import { describe, expect, it, vi } from "vitest";
import { classifyDroppedFile } from "../../src/features/library/catalog/catalogDropKinds";
import { routeDrop } from "../../src/features/library/catalog/catalogDropRouting";
import { normalizeArtworkFile, replaceBeatArtwork, resolveArtworkFile } from "../../src/features/library/catalog/catalogArtworkReplace";

const f = (name: string, type = "") => new File([new Uint8Array(8)], name, { type });
const ev = (files: File[], targetBeatId: string | null, artwork: Promise<never[]> | null = null) => ({ files, artwork: artwork as never, targetBeatId });

describe("classifyDroppedFile", () => {
  it("imagen, MP3, WAV y no soportado, por nombre o tipo", () => {
    for (const n of ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.bmp", "a.gif", "a.avif"]) expect(classifyDroppedFile(f(n))).toBe("image");
    expect(classifyDroppedFile(f("x", "image/png"))).toBe("image");
    expect(classifyDroppedFile(f("a.mp3"))).toBe("mp3"); expect(classifyDroppedFile(f("x", "audio/mpeg"))).toBe("mp3");
    expect(classifyDroppedFile(f("a.WAV"))).toBe("wav"); expect(classifyDroppedFile(f("x", "audio/x-wav"))).toBe("wav");
    for (const n of ["a.txt", "a.flac", "a.svg", "a.tiff"]) expect(classifyDroppedFile(f(n))).toBe("unsupported");
    expect(classifyDroppedFile(f("a.zip"))).toBe("project"); expect(classifyDroppedFile(f("s.flp"))).toBe("project");
  });
});

describe("routeDrop: tipo ⇒ acción, tarjeta ⇒ destino", () => {
  it("imagen sobre una tarjeta (cualquier zona) → portada de ESE beat; nunca aviso de archivo no soportado", () => {
    expect(routeDrop(ev([f("p.png", "image/png")], "b-1"))).toMatchObject({ type: "artwork-file", beatId: "b-1" });
    expect(routeDrop(ev([f("p.jpg")], "b-2"))).toMatchObject({ type: "artwork-file", beatId: "b-2" });
  });
  it("imagen fuera de una tarjeta → aviso claro (no hay beat), no «archivo no soportado» ni beat nuevo", () => {
    expect(routeDrop(ev([f("p.png")], null))).toMatchObject({ type: "alert", title: "Drop the image on a beat" });
  });
  it("MP3/WAV sobre una tarjeta → reemplazo de audio; fuera → beat nuevo", () => {
    expect(routeDrop(ev([f("a.mp3")], "b-1"))).toMatchObject({ type: "replace-audio", beatId: "b-1" });
    expect(routeDrop(ev([f("a.wav")], "b-1"))).toMatchObject({ type: "replace-audio", beatId: "b-1" });
    expect(routeDrop(ev([f("a.mp3")], null))).toMatchObject({ type: "import" });
    expect(routeDrop(ev([f("a.wav")], null))).toMatchObject({ type: "import" });
  });
  it("tipo no compatible → aviso «Unsupported file» (con el destino correcto en el texto); varios archivos → uno a la vez", () => {
    expect(routeDrop(ev([f("a.flac")], "b-1"))).toMatchObject({ type: "alert", title: "Unsupported file", message: expect.stringContaining("image") });
    expect(routeDrop(ev([f("a.flac")], null))).toMatchObject({ type: "alert", title: "Unsupported file" });
    expect(routeDrop(ev([f("a.mp3"), f("b.png")], "b-1"))).toMatchObject({ type: "alert", title: "Drop one file at a time" });
  });
  it("imagen arrastrada desde una página (sin File, solo fuentes): portada si hay tarjeta; sin nada utilizable → «Nothing to import»", async () => {
    const sources = Promise.resolve([]);
    expect(routeDrop(ev([], "b-1", sources as never))).toMatchObject({ type: "artwork-sources", beatId: "b-1" });
    expect(routeDrop(ev([], null, sources as never))).toMatchObject({ type: "alert", title: "Drop the image on a beat" });
    expect(routeDrop(ev([], "b-1", null))).toMatchObject({ type: "alert", title: "Nothing to import" });
  });
});

describe("portada: archivos y fuentes", () => {
  it("normalizeArtworkFile fija un tipo MIME compatible por extensión y rechaza lo que no es imagen", () => {
    expect(normalizeArtworkFile(f("p.png"))?.type).toBe("image/png"); expect(normalizeArtworkFile(f("p.jpeg", ""))?.type).toBe("image/jpeg");
    expect(normalizeArtworkFile(f("p.svg", "image/svg+xml"))).toBeNull(); expect(normalizeArtworkFile(f("p.mp3", "audio/mpeg"))).toBeNull();
  });
  it("resolveArtworkFile toma la primera fuente utilizable y falla con detalle si ninguna lo es", async () => {
    expect((await resolveArtworkFile([{ kind: "file", file: f("a.txt") }, { kind: "file", file: f("b.webp") }])).name).toBe("b.webp");
    await expect(resolveArtworkFile([{ kind: "file", file: f("a.txt") }])).rejects.toThrow(/no compatible/);
    await expect(resolveArtworkFile([])).rejects.toThrow(/imagen utilizable/);
  });
  const detail = { id: "b-1", name: "Mi beat", bpm: "140", key: "Am", tags: ["trap"], rating: 3, color: "#111", color2: "#222", version: "9", hasWav: false, playback: { fileId: "f", revision: "1" }, artwork: null, hasProject: false };
  it("replaceBeatArtwork: MISMO beat, solo el archivo de portada, metadatos intactos, sin importar ni tocar audio", async () => {
    const replaceBeat = vi.fn(async () => ({ status: "committed", operationId: "o", beatId: "b-1", version: "10", revision: "5", operation: {} }));
    const art = f("p.png", "image/png");
    const r = await replaceBeatArtwork({ mutations: { getBeat: vi.fn(async () => detail), replaceBeat } as never, beatId: "b-1", file: art });
    expect(r).toEqual({ status: "committed", beatId: "b-1" });
    const a = replaceBeat.mock.calls[0][0] as { beatId: string; expectedVersion: string; original: unknown; updated: unknown; files: Record<string, unknown> };
    expect(a.beatId).toBe("b-1"); expect(a.expectedVersion).toBe("9"); expect(a.files).toEqual({ artwork: art }); expect(a.updated).toBe(a.original);
  });
  it("conflicto / error / lectura fallida → failed, sin éxito falso", async () => {
    const mk = (outcome: unknown) => ({ getBeat: vi.fn(async () => detail), replaceBeat: vi.fn(async () => outcome) }) as never;
    expect(await replaceBeatArtwork({ mutations: mk({ status: "conflict", operationId: "o", beatId: "b-1", operation: null, retained: false, error: null }), beatId: "b-1", file: f("p.png", "image/png") })).toMatchObject({ status: "failed", message: expect.stringContaining("otro dispositivo") });
    expect(await replaceBeatArtwork({ mutations: mk({ status: "failed", operationId: "o", beatId: "b-1", operation: null, retained: true, error: null }), beatId: "b-1", file: f("p.png", "image/png") })).toMatchObject({ status: "failed" });
    expect(await replaceBeatArtwork({ mutations: { getBeat: vi.fn(async () => { throw new Error("404"); }), replaceBeat: vi.fn() } as never, beatId: "b-1", file: f("p.png", "image/png") })).toMatchObject({ status: "failed" });
  });
});
