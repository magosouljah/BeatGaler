import { describe, expect, it, vi } from "vitest";
import type { CatalogBeatFile } from "../../src/features/library/catalog/catalogCommandsApi";
import { createGalleryDownloadsStore } from "../../src/features/library/catalog/catalogDownloads";
import { beatFromCatalogDetail } from "../../src/features/library/catalog/catalogMutations";
import type { CatalogBeatDto } from "../../src/features/library/catalog/catalogApi";

// Caracterizacion del estado de descargas tal como lo ve la UI (cloudFiles, downloadBusy, downloaded, avisos).
const dto = (id: string): CatalogBeatDto => ({
  id, version: "1", name: `Beat ${id}`, state: "ACTIVE", bpm: "120", key: "cm", tags: [], rating: 0, color: null, color2: null,
  artwork: null, playback: null, hasArtwork: false, hasWav: true, hasStems: false, hasProject: true, fileCount: 2,
} as unknown as CatalogBeatDto);
const file = (fileId: string, role: string, filename: string | null = null): CatalogBeatFile => ({
  fileId, role, current: true, revision: "1", filename, mime: null, sizeBytes: "10", status: "AVAILABLE", verified: true, slot: role, partCount: 1,
});
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((a) => { resolve = a; }); return { promise, resolve }; };

// Adaptador: unico lugar que sabe como se monta el estado de descargas y como se lee lo que ve la UI.
function mount(opts: { offline?: boolean; listBeatFiles?: (id: string) => Promise<CatalogBeatFile[]>; downloadFile?: (id: string) => Promise<{ blob: Blob }> } = {}) {
  const notices: Array<string | null> = [];
  const save = vi.fn();
  const listBeatFiles = vi.fn(opts.listBeatFiles ?? (async () => []));
  const downloadFile = vi.fn(opts.downloadFile ?? (async (id: string) => ({ blob: new Blob([id]) })));
  const store = createGalleryDownloadsStore(() => ({
    mutations: { listBeatFiles }, media: { downloadFile }, rejectOfflineMutation: () => !!opts.offline, setNotice: (n) => { notices.push(n); }, save,
  }));
  const read = () => { const s = store.getSnapshot(); return { cloudFiles: s.cloudFiles, downloadBusy: s.downloadBusy, downloaded: [...s.downloaded] }; };
  return {
    notices, save, listBeatFiles, downloadFile, read,
    open: (b: ReturnType<typeof beatFromCatalogDetail>) => store.openDownloads(b),
    download: (k: "MP3" | "WAV" | "PROJECT" | "ALL") => store.downloadKind(k),
    close: () => store.closeDownloads(),
  };
}
const beatA = beatFromCatalogDetail(dto("a")), beatB = beatFromCatalogDetail(dto("b"));

describe("estado de descargas de la Gallery", () => {
  it("offline: no abre ni lista archivos", () => {
    const m = mount({ offline: true });
    m.open(beatA);
    expect(m.listBeatFiles).not.toHaveBeenCalled();
    expect(m.read()).toEqual({ cloudFiles: null, downloadBusy: null, downloaded: [] });
  });

  it("abrir lista los archivos y reinicia downloaded", async () => {
    const files = [file("m", "MASTER")];
    const m = mount({ listBeatFiles: async () => files });
    m.open(beatA);
    await vi.waitFor(() => expect(m.read().cloudFiles).toEqual({ beat: beatA, files }));
    expect(m.listBeatFiles).toHaveBeenCalledExactlyOnceWith("a");
    expect(m.read().downloaded).toEqual([]);
  });

  it("error al abrir: aviso exacto y sin modal", async () => {
    const m = mount({ listBeatFiles: async () => { throw new Error("boom"); } });
    m.open(beatA);
    await vi.waitFor(() => expect(m.notices).toEqual(["No se pudo leer los archivos del beat: boom"]));
    expect(m.read().cloudFiles).toBeNull();
  });

  it("descargar: ocupado durante la descarga, luego done y aviso con nombre", async () => {
    const gate = deferred<{ blob: Blob }>();
    const m = mount({ listBeatFiles: async () => [file("w", "WAV", "Mi Beat.wav")], downloadFile: () => gate.promise });
    m.open(beatA); await vi.waitFor(() => expect(m.read().cloudFiles).not.toBeNull());
    m.download("WAV");
    expect(m.read().downloadBusy).toBe("WAV");
    m.download("WAV"); // ignorada mientras hay una en curso
    expect(m.downloadFile).toHaveBeenCalledTimes(1);
    gate.resolve({ blob: new Blob(["x"]) });
    await vi.waitFor(() => expect(m.read().downloadBusy).toBeNull());
    expect(m.read().downloaded).toEqual(["WAV"]);
    expect(m.save).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), "Mi Beat.wav");
    expect(m.notices).toEqual(["«Mi Beat.wav» descargado."]);
  });

  it("varias descargas seguidas acumulan downloaded; ALL guarda varios y avisa el total", async () => {
    const m = mount({ listBeatFiles: async () => [file("m", "MASTER", "a.mp3"), file("w", "WAV", "a.wav"), file("p", "PROJECT", "a.zip")] });
    m.open(beatA); await vi.waitFor(() => expect(m.read().cloudFiles).not.toBeNull());
    m.download("WAV"); await vi.waitFor(() => expect(m.read().downloaded).toEqual(["WAV"]));
    await vi.waitFor(() => expect(m.read().downloadBusy).toBeNull());
    m.download("ALL"); await vi.waitFor(() => expect(m.read().downloaded).toEqual(["WAV", "ALL"]));
    await vi.waitFor(() => expect(m.read().downloadBusy).toBeNull());
    expect(m.notices).toEqual(["«a.wav» descargado.", "3 archivos descargados."]);
    expect(m.save).toHaveBeenCalledTimes(4);
  });

  it("tipo sin archivo: aviso no disponible y no cuenta como descargado", async () => {
    const m = mount({ listBeatFiles: async () => [file("w", "WAV")] });
    m.open(beatA); await vi.waitFor(() => expect(m.read().cloudFiles).not.toBeNull());
    m.download("PROJECT"); await vi.waitFor(() => expect(m.read().downloadBusy).toBeNull());
    expect(m.notices).toEqual(["Ese archivo no está disponible para este beat."]);
    expect(m.read().downloaded).toEqual([]);
  });

  it("error al descargar: aviso con el mensaje, libera ocupado, no cuenta", async () => {
    const m = mount({ listBeatFiles: async () => [file("w", "WAV")], downloadFile: async () => { throw new Error("hash"); } });
    m.open(beatA); await vi.waitFor(() => expect(m.read().cloudFiles).not.toBeNull());
    m.download("WAV"); await vi.waitFor(() => expect(m.notices).toEqual(["No se pudo descargar: hash"]));
    await vi.waitFor(() => expect(m.read().downloadBusy).toBeNull());
    expect(m.read().downloaded).toEqual([]);
  });

  it("sin modal abierto descargar no hace nada; cerrar limpia modal y ocupado", async () => {
    const m = mount({ listBeatFiles: async () => [file("w", "WAV")] });
    m.download("WAV");
    expect(m.downloadFile).not.toHaveBeenCalled();
    m.open(beatA); await vi.waitFor(() => expect(m.read().cloudFiles).not.toBeNull());
    m.close();
    expect(m.read()).toEqual({ cloudFiles: null, downloadBusy: null, downloaded: [] });
  });

  it("dos aperturas seguidas: gana la ultima en resolver (comportamiento actual)", async () => {
    const ga = deferred<CatalogBeatFile[]>(), gb = deferred<CatalogBeatFile[]>();
    const m = mount({ listBeatFiles: (id) => (id === "a" ? ga.promise : gb.promise) });
    m.open(beatA); m.open(beatB);
    gb.resolve([file("b1", "WAV")]); await vi.waitFor(() => expect(m.read().cloudFiles?.beat.id).toBe("b"));
    ga.resolve([file("a1", "WAV")]); await vi.waitFor(() => expect(m.read().cloudFiles?.beat.id).toBe("a"));
  });
});
