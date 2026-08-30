import { describe, expect, it, vi } from "vitest";
import { retryableWebBulkSaveItems, saveAllWebItems } from "../../src/features/edit/webBulkSave";

describe("Web Save All coordinator", () => {
  it("reports total success and deterministic progress", async () => {
    const commit = vi.fn(async () => {});
    const progress: Array<{ completed: number; currentId: string | null }> = [];
    const summary = await saveAllWebItems([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ], commit, state => progress.push({ completed: state.completed, currentId: state.currentId }));

    expect(commit.mock.calls.map(([item]) => item.id)).toEqual(["a", "b"]);
    expect(summary).toMatchObject({ total: 2, completed: 2, saved: 2, conflicts: 0, failed: 0 });
    expect(progress).toEqual([
      { completed: 1, currentId: "a" },
      { completed: 2, currentId: "b" },
      { completed: 2, currentId: null },
    ]);
  });

  it("continues after a partial failure without silent loss", async () => {
    const attempted: string[] = [];
    const summary = await saveAllWebItems([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
      { id: "c", value: 3 },
    ], async item => {
      attempted.push(item.id);
      if (item.id === "b") throw new Error("upload failed");
    });

    expect(attempted).toEqual(["a", "b", "c"]);
    expect(summary).toMatchObject({ total: 3, completed: 3, saved: 2, conflicts: 0, failed: 1 });
    expect(summary.results.map(result => [result.id, result.status])).toEqual([
      ["a", "saved"],
      ["b", "failed"],
      ["c", "saved"],
    ]);
  });

  it("classifies per-item CAS conflicts and still attempts later items", async () => {
    const attempted: string[] = [];
    const summary = await saveAllWebItems([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
      { id: "c", value: 3 },
    ], async item => {
      attempted.push(item.id);
      if (item.id === "b") throw new Error("Library changed on another device. Refresh and try again.");
    });

    expect(attempted).toEqual(["a", "b", "c"]);
    expect(summary).toMatchObject({ saved: 2, conflicts: 1, failed: 0 });
    expect(summary.results[1]).toMatchObject({ id: "b", status: "conflict" });
  });

  it("retries only unresolved items so successful durable commits are not replayed", async () => {
    let firstAttempt = true;
    const committed: string[] = [];
    const items = [
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ];

    const first = await saveAllWebItems(items, async item => {
      if (item.id === "b" && firstAttempt) throw new Error("409 conflict");
      committed.push(item.id);
    });
    firstAttempt = false;
    const retry = retryableWebBulkSaveItems(first);
    const second = await saveAllWebItems(retry, async item => { committed.push(item.id); });

    expect(retry.map(item => item.id)).toEqual(["b"]);
    expect(committed).toEqual(["a", "b"]);
    expect(second).toMatchObject({ total: 1, saved: 1, conflicts: 0, failed: 0 });
  });

  it("rejects duplicate ids inside one batch before a second durable commit", async () => {
    const commit = vi.fn(async () => {});
    const summary = await saveAllWebItems([
      { id: "a", value: 1 },
      { id: "a", value: 2 },
    ], commit);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ total: 2, saved: 1, failed: 1 });
    expect(summary.results[1].error).toContain("Duplicate");
  });
});
