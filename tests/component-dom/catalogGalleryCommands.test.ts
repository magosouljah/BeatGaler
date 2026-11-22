import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { CatalogBeatDto, CatalogQueryFilters } from "../../src/features/library/catalog/catalogApi";
import type { CatalogBeatFile } from "../../src/features/library/catalog/catalogCommandsApi";
import { createGalleryBeatEditor } from "../../src/features/library/catalog/catalogBeatEditor";
import { createGalleryDownloads } from "../../src/features/library/catalog/catalogDownloads";
import { createKnownGalleryCards, KNOWN_BEATS_MAX } from "../../src/features/library/catalog/catalogGalleryCards";
import { importLandsAtTop, projectPendingCards } from "../../src/features/library/catalog/catalogImportSession";
import { createCatalogInteractionStore, createGallerySelection } from "../../src/features/library/catalog/catalogInteractionStore";
import { beatFromCatalogDetail } from "../../src/features/library/catalog/catalogMutations";
import { createGalleryPlaybackCommands } from "../../src/features/library/catalog/catalogPlaybackLink";
import { createCatalogPlaybackSession } from "../../src/features/library/catalog/catalogPlaybackSession";
import type { CatalogStoreSnapshot } from "../../src/features/library/catalog/catalogQueryStore";

const artwork = { fileId: "cover", revision: "1" };
const dto: CatalogBeatDto = {
  id: "beat", version: "7", name: "Beat", state: "ACTIVE", bpm: "120", key: "cm", tags: ["tag"], rating: 4,
  color: null, color2: null, artwork, playback: { fileId: "master", revision: "1" },
  hasArtwork: true, hasWav: false, hasStems: false, hasProject: true, fileCount: 3,
};
const beat = beatFromCatalogDetail(dto);
const filters: CatalogQueryFilters = { state: "ACTIVE", q: "", includeTags: [], excludeTags: [] };
const listFile = (fileId: string, role: string, current = true): CatalogBeatFile => ({
  fileId, role, current, revision: "1", filename: null, mime: null, sizeBytes: "10", status: "AVAILABLE",
  verified: true, slot: role, partCount: 1,
});

describe("comandos de edición de Gallery", () => {
  function setup() {
    const patchBeat = vi.fn<Parameters<typeof createGalleryBeatEditor>[0]["mutations"]["patchBeat"]>()
      .mockResolvedValue({ status: "ok", beat: null, revision: "8", noop: false, operationId: "op", replay: false });
    const replaceBeat = vi.fn<Parameters<typeof createGalleryBeatEditor>[0]["mutations"]["replaceBeat"]>()
      .mockResolvedValue({ status: "timeout", operationId: "transfer", beatId: dto.id, operation: null, retained: true, error: null });
    const trashBeats = vi.fn<Parameters<typeof createGalleryBeatEditor>[0]["mutations"]["trashBeats"]>()
      .mockRejectedValue(new Error("papelera no disponible"));
    const downloadFile = vi.fn<Parameters<typeof createGalleryBeatEditor>[0]["media"]["downloadFile"]>();
    const mutations = {
      patchBeat, replaceBeat, trashBeats, getBeat: vi.fn().mockResolvedValue(dto),
      listBeatFiles: vi.fn().mockResolvedValue([listFile("old", "PROJECT", false), listFile("current", "PROJECT")]),
    };
    const effects = { refreshAfterMutation: vi.fn(), setNotice: vi.fn(), setBusy: vi.fn(), releaseFile: vi.fn(), forgetArtworkOf: vi.fn() };
    const editor = createGalleryBeatEditor({
      mutations, media: { downloadFile }, knownDto: () => dto, errorMessage: String,
      playingId: dto.id, confirm: async () => true, ...effects,
    });
    return { editor, mutations, downloadFile, ...effects };
  }

  it("confirma el PATCH manual y refresca una vez", async () => {
    const { editor, mutations, refreshAfterMutation } = setup();
    await editor.commitDrawerCloudMutation({ ...beat, bpm: "140" });
    expect(mutations.patchBeat).toHaveBeenCalledExactlyOnceWith({ beatId: dto.id, expectedVersion: dto.version, patch: { bpm: "140" } });
    expect(refreshAfterMutation).toHaveBeenCalledOnce();
  });

  it("olvida portada y refresca antes de devolver el error parcial del Drawer", async () => {
    const { editor, forgetArtworkOf, refreshAfterMutation } = setup();
    const wav = new File(["wav"], "new.wav", { type: "audio/wav" });
    await expect(editor.saveDrawerToCatalog({ original: beat, updated: beat, files: { WAV: wav }, artworkRemoved: true }))
      .rejects.toMatchObject({ partial: true, pending: true });
    expect(forgetArtworkOf).toHaveBeenCalledExactlyOnceWith(dto.id);
    expect(forgetArtworkOf).toHaveBeenCalledBefore(refreshAfterMutation);
  });

  it("lee solo el PROJECT vigente y conserva otra entrada al fusionar un archivo DAW", async () => {
    const { editor, mutations, downloadFile, setBusy, refreshAfterMutation } = setup();
    const existing = new JSZip().file("old.flp", "old").file("sample.wav", "sample");
    downloadFile.mockResolvedValue({ blob: new Blob([await existing.generateAsync({ type: "arraybuffer" })]) });
    await editor.replaceAudioByDrop(dto.id, new File(["new"], "new.flp"));
    expect(downloadFile).toHaveBeenCalledExactlyOnceWith("current");
    const archive = mutations.replaceBeat.mock.calls[0][0].files.project!;
    const zip = await JSZip.loadAsync(archive);
    expect(zip.file("old.flp")).toBeNull();
    expect(await zip.file("new.flp")!.async("string")).toBe("new");
    expect(await zip.file("sample.wav")!.async("string")).toBe("sample");
    expect(setBusy.mock.calls).toEqual([[dto.id, true], [dto.id, false, undefined]]);
    expect(refreshAfterMutation).not.toHaveBeenCalled();
  });

  it("finaliza el indicador de portada pendiente sin completar ni refrescar", async () => {
    const { editor, setBusy, setNotice, refreshAfterMutation } = setup();
    await editor.replaceArtworkByDrop(dto.id, [{ kind: "file", file: new File(["png"], "cover.png", { type: "image/png" }) }]);
    expect(setBusy.mock.calls).toEqual([[dto.id, true], [dto.id, false, false]]);
    expect(setNotice).toHaveBeenCalledWith(expect.stringMatching(/^No se pudo cambiar la portada/));
    expect(refreshAfterMutation).not.toHaveBeenCalled();
  });

  it("libera el beat que suena antes de enviarlo a papelera y conserva el aviso de error", async () => {
    const { editor, mutations, releaseFile, setNotice, refreshAfterMutation } = setup();
    editor.deleteBeat(beat);
    expect(releaseFile).toHaveBeenCalledBefore(mutations.trashBeats);
    expect(mutations.trashBeats).toHaveBeenCalledExactlyOnceWith([{ beatId: dto.id, expectedVersion: dto.version }]);
    await vi.waitFor(() => expect(setNotice).toHaveBeenCalledExactlyOnceWith("papelera no disponible"));
    expect(refreshAfterMutation).not.toHaveBeenCalled();
  });
});

it("bloquea la apertura de descargas offline y aplica ID3 con la portada actual al guardar", async () => {
  const files = [listFile("master", "MASTER"), listFile("old", "ARTWORK", false), listFile("cover", "ARTWORK")];
  const listBeatFiles = vi.fn().mockResolvedValue(files);
  const downloadFile = vi.fn().mockImplementation(async (id: string) => ({
    blob: new Blob([id === "cover" ? "img" : "\xffMP3"], { type: id === "cover" ? "image/png" : "audio/mpeg" }),
  }));
  const save = vi.fn();
  const setCloudFiles = vi.fn();
  const setDownloaded = vi.fn();
  const setDownloadBusy = vi.fn();
  const setNotice = vi.fn();
  const rejectOfflineMutation = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  const ports = { mutations: { listBeatFiles }, media: { downloadFile }, setCloudFiles, setDownloaded, setDownloadBusy, setNotice, rejectOfflineMutation, save };
  const download = createGalleryDownloads({ ...ports, cloudFiles: null, downloadBusy: null });
  download.openDownloads(beat);
  expect(listBeatFiles).not.toHaveBeenCalled();
  download.openDownloads(beat);
  await vi.waitFor(() => expect(setCloudFiles).toHaveBeenCalledExactlyOnceWith({ beat, files }));

  createGalleryDownloads({ ...ports, cloudFiles: { beat, files }, downloadBusy: null }).downloadKind("MP3");
  await vi.waitFor(() => expect(setDownloadBusy.mock.calls).toEqual([["MP3"], [null]]));
  expect(downloadFile.mock.calls).toEqual([["master"], ["cover"]]);
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), "Beat.mp3");
  expect(setNotice).toHaveBeenCalledExactlyOnceWith("«Beat.mp3» descargado.");
  expect(setDownloaded.mock.calls[1][0](new Set(["WAV"]))).toEqual(new Set(["WAV", "MP3"]));
});

it("envía ordinal y query global, mantiene tagsOp del lote y refresca un renombrado confirmado", async () => {
  const query = { filters, sort: "manual" as const, revision: "7" };
  const result = { report: { completed: true, confirmed: 2, total: 2 }, status: "COMPLETED" };
  const store = {
    toggle: vi.fn().mockResolvedValue(undefined), getSnapshot: vi.fn(), clearSelection: vi.fn(), selectAll: vi.fn(),
    startBulk: vi.fn().mockResolvedValue(result), confirmRename: vi.fn().mockResolvedValue(result), closeRename: vi.fn(),
  } satisfies Pick<ReturnType<typeof createCatalogInteractionStore>, "toggle" | "getSnapshot" | "clearSelection" | "selectAll" | "startBulk" | "confirmRename" | "closeRename">;
  const setNotice = vi.fn();
  const refreshAfterMutation = vi.fn();
  const setSelectMode = vi.fn();
  const selection = createGallerySelection({ store, query, ordinalOf: () => 42, setSelectMode, setNotice, refreshAfterMutation });
  selection.toggleSelection(null, false);
  expect(setSelectMode).toHaveBeenCalledExactlyOnceWith(true);
  selection.toggleSelection(beat, true);
  expect(store.toggle).toHaveBeenCalledExactlyOnceWith(dto.id, { shiftKey: true, ordinal: 42, query });
  selection.applyBulkUpdate({ tags: ["nuevo"], rating: 0 }, { tagsMode: "add" });
  expect(store.startBulk).toHaveBeenCalledExactlyOnceWith("BULK_PATCH", { rating: 0 }, { op: "add", tags: ["nuevo"] });
  selection.handleRemoveBulk();
  expect(store.startBulk).toHaveBeenLastCalledWith("BULK_TRASH");
  selection.confirmTagRename();
  await vi.waitFor(() => expect(refreshAfterMutation).toHaveBeenCalledTimes(3));
  expect(setNotice.mock.calls).toEqual([["Edición en lote: 2/2 confirmados."], ["Papelera en lote: 2/2 confirmados."], ["Tag renombrado: 2 beats."]]);
  expect(store.closeRename).toHaveBeenCalledOnce();
});

it("pausa el beat activo, usa versión y archivo de la tarjeta y consume el índice de cola", async () => {
  const session = createCatalogPlaybackSession({
    api: { startRound: vi.fn(), nextInRound: vi.fn(), consumeInRound: vi.fn(), releaseRound: vi.fn(), neighbor: vi.fn() },
    accountId: () => "fake", resolveSet: vi.fn(), resolveFile: vi.fn(),
    acquireSource: async (fileId) => ({ url: `blob:${fileId}`, cacheKey: fileId, bytes: 1, release: vi.fn() }),
  });
  const play = vi.fn<typeof session.play>().mockRejectedValue(Object.assign(new Error("falló"), { code: "OFFLINE" }));
  const togglePause = vi.fn();
  const setNotice = vi.fn();
  const playback = createGalleryPlaybackCommands({ session: { ...session, play }, playingId: dto.id, knownDto: () => dto, togglePause, setNotice });
  playback.handlePlay(beat);
  expect(togglePause).toHaveBeenCalledOnce();
  expect(play).not.toHaveBeenCalled();
  playback.addToQueue(beat);
  playback.playQueueIndex(1);
  expect(play).not.toHaveBeenCalled();
  playback.playQueueIndex(0);
  expect(session.getSnapshot().queue).toEqual([]);
  expect(play).toHaveBeenCalledExactlyOnceWith({ beatId: dto.id, version: "7", fileId: "master" });
  await vi.waitFor(() => expect(setNotice).toHaveBeenCalledExactlyOnceWith("No se pudo reproducir el beat: OFFLINE — falló"));
});

it("retira la provisional al aparecer su beat y respeta el límite de scroll de la importación", () => {
  const cards = [{ id: "draft", realId: dto.id, beat }, { id: "sending", realId: null, beat }];
  const blocks: CatalogStoreSnapshot["blocks"] = [{ items: [dto] } as CatalogStoreSnapshot["blocks"][number]];
  expect(projectPendingCards(cards, blocks)).toEqual({ residentIds: new Set([dto.id]), pendingCards: [{ id: "sending", beat }] });
  expect(importLandsAtTop({ filters, firstOrdinal: 0 }, 23)).toBe(true);
  expect(importLandsAtTop({ filters, firstOrdinal: 0 }, 24)).toBe(false);
  expect(importLandsAtTop({ filters: { ...filters, excludeTags: ["tag"] }, firstOrdinal: 0 }, 0)).toBe(false);
});

it("mantiene el beat activo en la caché acotada y publica portadas de forma agrupada", async () => {
  vi.useFakeTimers();
  try {
    const cards = createKnownGalleryCards();
    const local = cards.forRender({ artworkUrls: {}, playingId: dto.id, getSeededArtwork: () => "blob:seed" });
    expect(local.toBeat(dto).image_base64).toBe("blob:seed");
    for (let i = 0; i < KNOWN_BEATS_MAX; i++) local.toBeat({ ...dto, id: String(i) });
    expect(cards.knownDto(dto.id)).toBe(dto);
    expect(cards.knownDto("0")).toBeUndefined();
    local.toBeat({ ...dto, id: "second", artwork: { fileId: "cover2", revision: "1" } });
    const loadArtwork = vi.fn().mockResolvedValueOnce("blob:new").mockRejectedValueOnce(new Error("unavailable"));
    const publish = vi.fn();
    const onMount = cards.bindArtworkLoader({ loadArtwork }, publish);
    onMount(dto.id, 10);
    onMount("second");
    expect(cards.ordinalOf(dto.id)).toBe(10);
    cards.onUnmountCard(dto.id);
    expect(cards.ordinalOf(dto.id)).toBeUndefined();
    await vi.runAllTimersAsync();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]({})).toEqual({ cover: "blob:new", cover2: "" });
  } finally {
    vi.useRealTimers();
  }
});
