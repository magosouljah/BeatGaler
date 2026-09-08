import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const app = readFileSync("src/App.tsx", "utf8");
const assetUpdates = readFileSync("src/features/edit/useBeatAssetUpdates.ts", "utf8");

test("beat asset update ownership lives outside App", () => {
  assert.match(app, /useBeatAssetUpdates\(\{/);
  assert.doesNotMatch(app, /uploadDroppedFileToTelegram\(beat, filePath, "MASTER"\)/);
  assert.doesNotMatch(app, /uploadDroppedFileToTelegram\(beat, filePath, "WAV"\)/);
  assert.match(assetUpdates, /uploadDroppedFileToTelegram\(beat, filePath, "MASTER"\)/);
  assert.match(assetUpdates, /uploadDroppedFileToTelegram\(beat, filePath, "WAV"\)/);
});

test("MASTER keeps playback readiness and browser replacement confirmation", () => {
  assert.match(assetUpdates, /waitForUploadedBeatPlaybackReady\(updated\)/);
  assert.match(assetUpdates, /Replace MASTER\?/);
  assert.match(assetUpdates, /platform\.editor\.commit\(beat, beat, \{ \[kind\]: file \}\)/);
});

test("busy state, runtime failure and staging cleanup remain owned by the operation", () => {
  assert.match(assetUpdates, /setBeatCloudUpdateBusy\(beat\.id, true\)/);
  assert.match(assetUpdates, /SYNC_UPDATE_STARTED/);
  assert.match(assetUpdates, /SYNC_CONFLICT/);
  assert.match(assetUpdates, /BEAT_UPDATE_FAILED/);
  assert.match(assetUpdates, /cleanupStagedDropPaths\(\[filePath\]\)/);
});

test("project operations stay temporarily composed by App for task 5.3", () => {
  assert.match(app, /startProjectAssetUpdate/);
  assert.match(app, /startProjectZipReplacement/);
  assert.match(app, /platform\.editor\.commit\(beat, beat, \{ PROJECT: file \}\)/);
});
