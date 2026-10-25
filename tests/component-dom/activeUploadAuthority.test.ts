// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Beat } from "../../src/types";

const mocks = vi.hoisted(() => ({ reload: vi.fn() }));
vi.mock("../../src/lib/libraryStateManager", () => ({
  libraryStateManager: { reloadAuthoritative: mocks.reload },
}));

import { mergeActiveUploads, reloadStableLibrary } from "../../src/features/library/mergeActiveUploads";
import { upsertConfirmedBeat } from "../../src/features/cloud/useCloudUploadQueue";
import { getLibraryEventSourceId } from "../../src/features/cloud/useCloudLibraryEvents";
import { getWebClientId } from "../../src/platform/webClientId";

const beat = (id: string, status = "CLOUD_ONLY") => ({ id, name: id, tags: [], cloud_status: status }) as unknown as Beat;

beforeEach(() => { mocks.reload.mockReset(); });

describe("active upload authority reconciliation", () => {
  it("keeps only a locally active import when an old INDEX is read", () => {
    const result = mergeActiveUploads([beat("remote")], [beat("local", "UPLOADING"), beat("stale")], new Set(["local"]));
    expect(result.map(item => item.id)).toEqual(["local", "remote"]);
  });

  it("applies changes from another device while the local import stays visible", () => {
    const result = mergeActiveUploads([beat("remote-new")], [beat("local", "UPLOADING"), beat("remote-old")], new Set(["local"]));
    expect(result.map(item => item.id)).toEqual(["local", "remote-new"]);
  });

  it("re-reads when an old authoritative read resolves after commit", async () => {
    let resolveOld!: (value: Beat[]) => void;
    let revision = 1;
    mocks.reload.mockImplementationOnce(() => new Promise<Beat[]>(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce([beat("confirmed")]);
    const pending = reloadStableLibrary(() => revision);
    revision = 2;
    resolveOld([]);
    expect((await pending).beats.map(item => item.id)).toEqual(["confirmed"]);
    expect(mocks.reload).toHaveBeenCalledTimes(2);
  });

  it("upserts a confirmed beat if absent and replaces without duplicating if present", () => {
    const confirmed = beat("local", "CLOUD_ONLY");
    expect(upsertConfirmedBeat([beat("other")], confirmed).map(item => item.id)).toEqual(["local", "other"]);
    const replaced = upsertConfirmedBeat([beat("local", "UPLOADING"), beat("other")], confirmed);
    expect(replaced.map(item => item.id)).toEqual(["local", "other"]);
    expect(replaced[0].cloud_status).toBe("CLOUD_ONLY");
  });

  it("stops protecting a failed or conflicted import after ownership ends", () => {
    const current = [beat("local", "ERROR")];
    expect(mergeActiveUploads([], current, new Set(["local"]))).toHaveLength(1);
    expect(mergeActiveUploads([], current, new Set())).toEqual([]);
  });

  it("uses the stable Web installation identity for SSE", () => {
    expect(getLibraryEventSourceId()).toBe(getWebClientId());
    expect(getLibraryEventSourceId()).toBe(getLibraryEventSourceId());
  });
});
