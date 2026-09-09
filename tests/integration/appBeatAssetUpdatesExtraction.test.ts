import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = [
  readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/edit/useBeatEditing.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/dragdrop/useBeatFileDropRouting.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/cloud/beatCloudUpdateBusy.ts"), "utf8"),
].join("\n").replaceAll("../", "./");
const assetUpdates = readFileSync(resolve(process.cwd(), "src/features/edit/useBeatAssetUpdates.ts"), "utf8");

describe("Beat asset update extraction", () => {
  it("moves MASTER and WAV update ownership outside App", () => {
    expect(app).toContain("useBeatAssetUpdates({");
    expect(app).not.toContain('uploadDroppedFileToTelegram(beat, filePath, "MASTER")');
    expect(app).not.toContain('uploadDroppedFileToTelegram(beat, filePath, "WAV")');
    expect(assetUpdates).toContain('uploadDroppedFileToTelegram(beat, filePath, "MASTER")');
    expect(assetUpdates).toContain('uploadDroppedFileToTelegram(beat, filePath, "WAV")');
  });

  it("keeps MASTER playback readiness and browser replacement confirmation", () => {
    expect(assetUpdates).toContain("waitForUploadedBeatPlaybackReady(updated)");
    expect(assetUpdates).toContain("Replace MASTER?");
    expect(assetUpdates).toContain("platform.editor.commit(beat, beat, { [kind]: file })");
  });

  it("keeps busy state, runtime failure and staging cleanup with the operation", () => {
    expect(assetUpdates).toContain("setBeatCloudUpdateBusy(beat.id, true)");
    expect(assetUpdates).toContain("SYNC_UPDATE_STARTED");
    expect(assetUpdates).toContain("SYNC_CONFLICT");
    expect(assetUpdates).toContain("BEAT_UPDATE_FAILED");
    expect(assetUpdates).toContain("cleanupStagedDropPaths([filePath])");
  });

  it("keeps project operations outside the asset-update owner", () => {
    expect(assetUpdates).not.toContain("startProjectAssetUpdate");
    expect(assetUpdates).not.toContain("PROJECT: file");
  });
});
