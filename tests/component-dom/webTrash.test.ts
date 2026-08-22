import { describe, expect, it, vi } from "vitest";
import {
  listWebTrashItems,
  moveWebBeatsToTrash,
  purgeWebTrash,
  restoreWebBeatFromTrash,
  type WebTrashRuntime,
} from "../../src/features/trash/webTrash";

function cloudBeat(id: string, name: string, masterId: number) {
  return {
    id,
    name,
    bpm: "130",
    key: "Dm",
    tags: ["dark"],
    rating: 4,
    color: "#111111",
    color2: "#222222",
    custom: { preserved: true },
    master: { telegram_file_id: `direct:${masterId}`, telegram_message_id: masterId, filename: `${name}.mp3` },
    artwork: { telegram_file_id: `direct:${masterId + 1}`, telegram_message_id: masterId + 1, filename: `${name}.png` },
    files: [{ type: "WAV", manifest: { parts: [{ telegram_message_id: masterId + 2 }] } }],
    project: { manifest: { parts: [{ telegram_message_id: masterId + 3 }] } },
  };
}

function manifest() {
  return {
    schema: "beatgaler.telegram.library",
    version: 2,
    root_custom: "keep",
    beats: [cloudBeat("beat-1", "First", 10), cloudBeat("beat-2", "Second", 20)],
    trash: [],
    deleted: [{ beat_id: "old-gone", deleted_at: 5 }],
  };
}

function runtime(source = manifest()) {
  const order: string[] = [];
  const replaceLibraryIndex = vi.fn(async () => {
    order.push("index");
    return { messageId: 501, previousMessageId: 500, beatCount: 1 };
  });
  const deleteMessages = vi.fn(async (ids: number[]) => {
    order.push("media");
    return ids.length;
  });
  const value: WebTrashRuntime = {
    getLibraryIndex: vi.fn(async () => ({ messageId: 500, manifest: source })),
    replaceLibraryIndex,
    deleteMessages,
  };
  return { value, order, replaceLibraryIndex, deleteMessages };
}

describe("Web beat Trash lifecycle", () => {
  it("moves the complete beat payload to Trash in one index transaction", async () => {
    const cloud = runtime();
    const result = await moveWebBeatsToTrash(["beat-1"], cloud.value, 1000);

    expect(result.value).toEqual(["beat-1"]);
    expect(cloud.replaceLibraryIndex).toHaveBeenCalledOnce();
    expect(cloud.deleteMessages).not.toHaveBeenCalled();
    const input: any = cloud.replaceLibraryIndex.mock.calls[0][0];
    expect(input.expectedMessageId).toBe(500);
    expect(input.manifest.root_custom).toBe("keep");
    expect(input.manifest.beats.map((beat: any) => beat.id)).toEqual(["beat-2"]);
    expect(input.manifest.trash[0]).toMatchObject({
      trashed_at: 1000,
      purge_after: 1000 + 14 * 86400,
      beat: {
        id: "beat-1",
        name: "First",
        custom: { preserved: true },
        artwork: { telegram_message_id: 11 },
      },
    });
  });

  it("lists Trash newest-first and never exposes a tombstoned beat", () => {
    const first = cloudBeat("beat-1", "First", 10);
    const gone = cloudBeat("gone", "Gone", 30);
    const value = manifest();
    value.beats = [];
    value.trash = [
      { trash_id: "trash-old", trashed_at: 20, beat: first },
      { trash_id: "trash-new", trashed_at: 40, beat: cloudBeat("beat-2", "Second", 20) },
      { trash_id: "trash-gone", trashed_at: 60, beat: gone },
    ] as any;
    value.deleted = [{ beat_id: "gone", deleted_at: 50 }];

    expect(listWebTrashItems(value)).toEqual([
      { id: "trash-new", beat_name: "Second", trashed_at: 40, is_cloud: true },
      { id: "trash-old", beat_name: "First", trashed_at: 20, is_cloud: true },
    ]);
  });

  it("restores metadata and Cloud asset references while removing only its Trash row", async () => {
    const source = manifest();
    const payload = cloudBeat("beat-1", "First", 10);
    source.beats = [cloudBeat("beat-2", "Second", 20)];
    source.trash = [{ trash_id: "trash-1", trashed_at: 100, beat: payload }] as any;
    const cloud = runtime(source);

    const result = await restoreWebBeatFromTrash("trash-1", cloud.value);

    const candidate: any = cloud.replaceLibraryIndex.mock.calls[0][0].manifest;
    expect(candidate.trash).toEqual([]);
    expect(candidate.beats.map((beat: any) => beat.id)).toEqual(["beat-2", "beat-1"]);
    expect(result.value).toMatchObject({
      id: "beat-1",
      name: "First",
      bpm: "130",
      key: "Dm",
      tags: ["dark"],
      rating: 4,
      telegram_message_id: 10,
      assets: { artwork: { object_id: "direct:11" }, wav: { object_id: "direct:12" } },
    });
  });

  it("commits tombstones before deleting media and blocks later resurrection", async () => {
    const source = manifest();
    const payload = cloudBeat("beat-1", "First", 10);
    source.beats = [cloudBeat("beat-2", "Second", 20)];
    source.trash = [{ trash_id: "trash-1", trashed_at: 100, beat: payload }] as any;
    const cloud = runtime(source);

    const result = await purgeWebTrash(cloud.value, 2000);

    expect(result.value).toBe(1);
    expect(cloud.order).toEqual(["index", "media"]);
    const candidate: any = cloud.replaceLibraryIndex.mock.calls[0][0].manifest;
    expect(candidate.trash).toEqual([]);
    expect(candidate.deleted).toEqual([
      { beat_id: "beat-1", deleted_at: 2000 },
      { beat_id: "old-gone", deleted_at: 5 },
    ]);
    expect(cloud.deleteMessages).toHaveBeenCalledWith([10, 11, 12, 13]);

    const stale = { ...source, beats: [payload, ...source.beats], trash: [], deleted: candidate.deleted };
    expect(() => listWebTrashItems(stale)).not.toThrow();
    const restoreCloud = runtime({ ...source, trash: [{ trash_id: "trash-1", beat: payload }] as any, deleted: candidate.deleted });
    await expect(restoreWebBeatFromTrash("trash-1", restoreCloud.value)).rejects.toThrow("permanently deleted");
    expect(restoreCloud.replaceLibraryIndex).not.toHaveBeenCalled();
  });
});
