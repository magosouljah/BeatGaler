import { describe, expect, it, vi } from "vitest";
import { GALER_T_LIBRARY_SCHEMA, type WebLibraryTransport } from "../../src/features/library/webLibrary";
import { WebLibraryWindowConsumer } from "../../src/features/library/webLibraryWindow";

function entry(index: number) {
  return {
    id: `beat-${index + 1}`,
    name: `Beat ${index + 1}`,
    tags: [],
    master: {
      telegram_file_id: `direct:${index + 101}`,
      telegram_message_id: index + 101,
      filename: `Beat ${index + 1}.mp3`,
    },
  };
}

function manifest(total: number) {
  return {
    schema: GALER_T_LIBRARY_SCHEMA,
    version: 2,
    beats: Array.from({ length: total }, (_, index) => entry(index)),
    trash: [],
    deleted: [],
  };
}

describe("WebLibraryWindowConsumer", () => {
  it("walks 10k+ next/previous windows without duplicates or omissions and stays bounded", async () => {
    const total = 10_321;
    const pageSize = 240;
    const transport: WebLibraryTransport = {
      getLibraryIndex: vi.fn(async () => ({ messageId: 700, manifest: manifest(total) })),
      downloadFiles: vi.fn(async () => []),
    };
    const consumer = new WebLibraryWindowConsumer(transport, pageSize);
    const seen: string[] = [];

    let page = await consumer.first();
    while (true) {
      expect(page.materializedCount).toBeLessThanOrEqual(pageSize);
      expect(page.evidence.maxMaterializedCount).toBeLessThanOrEqual(pageSize);
      expect(page.evidence.avoidedRichMaterializations).toBe(total - page.materializedCount);
      seen.push(...page.beats.map(beat => beat.id));
      if (!page.hasMore) break;
      page = await consumer.next();
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe("beat-1");
    expect(seen.at(-1)).toBe(`beat-${total}`);
    expect(page.beats).toHaveLength(total % pageSize);
    expect(page.evidence.richMaterializationRatio).toBeCloseTo((total % pageSize) / total, 8);
    expect(transport.downloadFiles).not.toHaveBeenCalled();

    const previous = await consumer.previous();
    expect(previous.offset).toBe(Math.floor((total - 1) / pageSize) * pageSize - pageSize);
    expect(previous.beats[0].id).toBe(`beat-${previous.offset + 1}`);
    expect(previous.nextOffset).toBe(previous.offset + pageSize);
  });

  it("refresh invalidates the active window and rebases safely after authoritative shrink", async () => {
    const pageSize = 4;
    let currentManifest = manifest(10);
    const transport: WebLibraryTransport = {
      getLibraryIndex: vi.fn(async () => ({ messageId: 701, manifest: currentManifest })),
      downloadFiles: vi.fn(async () => []),
    };
    const consumer = new WebLibraryWindowConsumer(transport, pageSize);

    await consumer.first();
    await consumer.next();
    const third = await consumer.next();
    expect(third.offset).toBe(8);
    expect(third.beats.map(beat => beat.id)).toEqual(["beat-9", "beat-10"]);

    currentManifest = manifest(5);
    const refreshed = await consumer.refresh();
    expect(refreshed.offset).toBe(4);
    expect(refreshed.beats.map(beat => beat.id)).toEqual(["beat-5"]);
    expect(refreshed.totalVisible).toBe(5);
    expect(refreshed.hasMore).toBe(false);
    expect(transport.downloadFiles).not.toHaveBeenCalled();
  });

  it("coalesces concurrent authoritative refreshes and allows a fresh read after the shared one settles", async () => {
    let releaseRefresh!: () => void;
    let calls = 0;
    const gate = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const getLibraryIndex = vi.fn(async () => {
      calls += 1;
      if (calls === 2) await gate;
      return { messageId: 703 + calls, manifest: manifest(8) };
    });
    const transport: WebLibraryTransport = {
      getLibraryIndex,
      downloadFiles: vi.fn(async () => []),
    };
    const consumer = new WebLibraryWindowConsumer(transport, 4);

    await consumer.first();
    expect(getLibraryIndex).toHaveBeenCalledTimes(1);

    const firstRefresh = consumer.refresh();
    const secondRefresh = consumer.refresh();
    await vi.waitFor(() => expect(getLibraryIndex).toHaveBeenCalledTimes(2));
    expect(getLibraryIndex).toHaveBeenCalledTimes(2);

    releaseRefresh();
    const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh]);
    expect(firstResult.beats.map(beat => beat.id)).toEqual(secondResult.beats.map(beat => beat.id));
    expect(getLibraryIndex).toHaveBeenCalledTimes(2);

    await consumer.refresh();
    expect(getLibraryIndex).toHaveBeenCalledTimes(3);
  });

  it("keeps currentOrFirst stable without performing another authoritative page load", async () => {
    const transport: WebLibraryTransport = {
      getLibraryIndex: vi.fn(async () => ({ messageId: 702, manifest: manifest(500) })),
      downloadFiles: vi.fn(async () => []),
    };
    const consumer = new WebLibraryWindowConsumer(transport, 100);

    const first = await consumer.currentOrFirst();
    const same = await consumer.currentOrFirst();
    expect(first.beats.map(beat => beat.id)).toEqual(same.beats.map(beat => beat.id));
    expect(transport.getLibraryIndex).toHaveBeenCalledTimes(1);
    expect(same.evidence.pageLoads).toBe(1);
    expect(same.materializedCount).toBe(100);
    expect(same.evidence.avoidedRichMaterializations).toBe(400);
  });
});
