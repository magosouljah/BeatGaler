import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const appSource = [
  readFileSync(resolve(process.cwd(), "src/app/useBeatGalerComposition.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/edit/useBeatEditing.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/dragdrop/useBeatFileDropRouting.ts"), "utf8"),
  readFileSync(resolve(process.cwd(), "src/features/cloud/beatCloudUpdateBusy.ts"), "utf8"),
].join("\n").replaceAll("../", "./");
const queueSource = readFileSync(resolve(process.cwd(), "src/features/playback/usePlaybackQueue.ts"), "utf8");
describe("App playback queue extraction", () => {
  it("moves queue and navigation ownership out of App", () => {
    expect(appSource).toContain('usePlaybackQueue({');
    expect(appSource).not.toContain('setQueueIds(');
    expect(appSource).not.toContain('lastHandledEndedSeqRef');
    expect(queueSource).toContain('if (queueIds.length > 0)');
    expect(queueSource).toContain('repeatMode === "one"');
    expect(queueSource).toContain('if (shuffleEnabled)');
    expect(queueSource).toContain('endedSeq <= lastHandledEndedSeqRef.current');
    expect(queueSource).toContain('ids.filter(id => liveIds.has(id))');
    expect(queueSource).toContain('displayedBeats.some(beat => beat.id === playingId)');
  });
});
