import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveWebAccountId } from "../../src/features/auth/activeWebAccount";
import {
  markCloudUploadActive,
  readActiveCloudUploads,
  rollbackInterruptedCloudUploads,
} from "../../src/features/cloud/interruptedUploadJournal";
import { buildUploadFailureDetail } from "../../src/features/cloud/uploadErrorDetails";
import type { Beat } from "../../src/types";

const beat = (id: string, name = id) => ({ id, name, mp3_path: `/stage/${id}.mp3` }) as Beat;
const WEB_KEY = "beatgaler:active-cloud-uploads:v2:user-A";

function recover(authoritativeBeatIds: Set<string> | null, fetchImpl: any, purgeLocal = vi.fn(async () => undefined)) {
  return {
    purgeLocal,
    run: () => rollbackInterruptedCloudUploads({
      beatgalerUserId: "u1", authoritativeBeatIds, cloudApiBase: "https://cloud.test", authToken: "tok", purgeLocal, fetchImpl,
    }),
  };
}

describe("interrupted upload recovery (behavior)", () => {
  beforeEach(() => { localStorage.clear(); setActiveWebAccountId("user-A"); });
  afterEach(() => { setActiveWebAccountId(null); delete (window as any).__TAURI_INTERNALS__; });

  it("keeps markers per account on Web and under the legacy single key on Desktop", () => {
    markCloudUploadActive(beat("b1"));
    expect(localStorage.getItem(WEB_KEY)).toContain("b1");
    expect(localStorage.getItem("beatgaler:active-cloud-uploads:v1")).toBeNull();
    localStorage.clear();
    (window as any).__TAURI_INTERNALS__ = {};
    markCloudUploadActive(beat("b2"));
    expect(localStorage.getItem("beatgaler:active-cloud-uploads:v1")).toContain("b2");
    expect(readActiveCloudUploads().map(item => item.beatId)).toEqual(["b2"]);
  });

  it("never purges a beat that is already committed in the authoritative catalog", async () => {
    markCloudUploadActive(beat("done"));
    const fetchImpl = vi.fn();
    const { run, purgeLocal } = recover(new Set(["done"]), fetchImpl);
    expect(await run()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(purgeLocal).not.toHaveBeenCalled();
    expect(readActiveCloudUploads()).toEqual([]);
  });

  it("fails closed when authority cannot be verified: no request, no purge, markers kept", async () => {
    markCloudUploadActive(beat("a"));
    markCloudUploadActive(beat("b"));
    const fetchImpl = vi.fn();
    const { run, purgeLocal } = recover(null, fetchImpl);
    expect(await run()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(purgeLocal).not.toHaveBeenCalled();
    expect(readActiveCloudUploads().map(item => item.beatId)).toEqual(["a", "b"]);
  });

  it("keeps the marker (and purges nothing) when the rollback request fails; clears it when it succeeds", async () => {
    markCloudUploadActive(beat("bad"));
    markCloudUploadActive(beat("ok", "Okay Beat"));
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      const { beatId } = JSON.parse(init.body);
      return beatId === "bad" ? { ok: false, status: 500, text: async () => "boom" } : { ok: true };
    });
    const { run, purgeLocal } = recover(new Set(), fetchImpl);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await run()).toEqual(["Okay Beat"]);
    warn.mockRestore();
    expect(purgeLocal).toHaveBeenCalledTimes(1);
    expect(purgeLocal).toHaveBeenCalledWith("ok", ["/stage/ok.mp3"]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://cloud.test/beats/delete-topic");
    expect(readActiveCloudUploads().map(item => item.beatId)).toEqual(["bad"]);
  });
});

describe("upload failure detail (behavior)", () => {
  it("sanitizes the raw error shown to the user", () => {
    const detail = buildUploadFailureDetail({
      beatName: "Beat", stage: "Upload", platform: "web",
      error: new Error("Telegram Bot API rejected 123456789:ABCDEFGHIJKLMNOPQRSTUVWX"),
    });
    expect(detail).toContain("Beat: Beat");
    expect(detail).not.toMatch(/telegram|bot api|ABCDEFGHIJKLMNOPQRSTUVWX/i);
    expect(detail).toContain("Galer Storage");
    expect(detail).toContain("[redacted credential]");
    expect(buildUploadFailureDetail({ beatName: "B", stage: "s", platform: "p", error: "  " })).toContain("Error detail: Unknown error");
  });
});
