import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readActiveCloudUploads,
  rollbackInterruptedCloudUploads,
  writeActiveCloudUploads,
} from "../../src/features/cloud/interruptedUploadJournal";
import {
  buildCloudSessionUnavailableDetail,
  buildPlaybackPreparationFailureDetail,
  buildUploadFailureDetail,
} from "../../src/features/cloud/uploadErrorDetails";

const durable = { beatId: "durable", beatName: "Durable Beat", stagingPaths: ["durable.mp3"] };
const interrupted = { beatId: "interrupted", beatName: "Interrupted Beat", stagingPaths: ["interrupted.mp3", "project.zip"] };

function response(ok: boolean, status = 200, text = ""): Response {
  return { ok, status, text: async () => text } as Response;
}

describe("task 6.2 upload recovery extraction", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("preserves a beat already confirmed by the authoritative INDEX and only rolls back the incomplete beat", async () => {
    writeActiveCloudUploads([durable, interrupted]);
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return response(true);
    }) as typeof fetch;
    const purgeLocal = vi.fn(async () => undefined);

    const rolledBack = await rollbackInterruptedCloudUploads({
      beatgalerUserId: "user-1",
      authoritativeBeatIds: new Set([durable.beatId]),
      cloudApiBase: "https://cloud.example.test",
      authToken: "token",
      purgeLocal,
      fetchImpl,
    });

    expect(rolledBack).toEqual([interrupted.beatName]);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.input)).toBe("https://cloud.example.test/beats/delete-topic");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ beatgalerUserId: "user-1", beatId: interrupted.beatId });
    expect(purgeLocal).toHaveBeenCalledTimes(1);
    expect(purgeLocal).toHaveBeenCalledWith(interrupted.beatId, interrupted.stagingPaths);
    expect(purgeLocal).not.toHaveBeenCalledWith(durable.beatId, durable.stagingPaths);
    expect(readActiveCloudUploads()).toEqual([]);
  });

  it("fails closed when the authoritative INDEX cannot be verified", async () => {
    writeActiveCloudUploads([durable, interrupted]);
    const fetchImpl = vi.fn(async () => response(true));
    const purgeLocal = vi.fn(async () => undefined);

    const rolledBack = await rollbackInterruptedCloudUploads({
      beatgalerUserId: "user-1",
      authoritativeBeatIds: null,
      cloudApiBase: "https://cloud.example.test",
      authToken: null,
      purgeLocal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(rolledBack).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(purgeLocal).not.toHaveBeenCalled();
    expect(readActiveCloudUploads()).toEqual([durable, interrupted]);
  });

  it("keeps the recovery marker when remote rollback fails", async () => {
    writeActiveCloudUploads([interrupted]);
    const fetchImpl = vi.fn(async () => response(false, 503, "temporary failure"));
    const purgeLocal = vi.fn(async () => undefined);

    const rolledBack = await rollbackInterruptedCloudUploads({
      beatgalerUserId: "user-1",
      authoritativeBeatIds: new Set(),
      cloudApiBase: "https://cloud.example.test",
      authToken: null,
      purgeLocal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(rolledBack).toEqual([]);
    expect(purgeLocal).not.toHaveBeenCalled();
    expect(readActiveCloudUploads()).toEqual([interrupted]);
  });

  it("keeps useful upload stage, platform, hints and sanitized raw detail", () => {
    const session = buildCloudSessionUnavailableDetail(new Error("network down"));
    expect(session.raw).toBe("network down");
    expect(session.detail).toContain("Stage: Verify cloud session");
    expect(session.detail).toContain("Confirm this BeatGaler installation is signed in");

    const detail = buildUploadFailureDetail({
      beatName: "Night Drive",
      stage: "Upload MASTER audio",
      platform: "Win32",
      error: new Error("Telegram connection timed out"),
    });
    expect(detail).toContain("Beat: Night Drive");
    expect(detail).toContain("Stage: Upload MASTER audio");
    expect(detail).toContain("Platform: Win32");
    expect(detail).toContain("Check Internet connectivity");
    expect(detail).toContain("Error detail: Galer Cloud connection timed out");

    const playback = buildPlaybackPreparationFailureDetail("Night Drive");
    expect(playback).toContain("PLAYBACK PREPARATION FAILED");
    expect(playback).toContain("Galer Library index are already committed");
    expect(playback).toContain("left in Cloud safely");
  });
});
