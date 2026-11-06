import { DEMO_BEATS } from "../shared/data";
import type { CoverMode } from "../shared/coverSources";

export type Beat = {
  id: string;
  name: string;
  key: string;
  bpm: string;
  duration: number;
  coverMode: CoverMode;
};

export const SAMPLE_BEATS: readonly Omit<Beat, "coverMode">[] = DEMO_BEATS.map(beat => {
  const [minutes, seconds] = beat.duration.split(":").map(Number);
  return { id: beat.id, name: beat.title, key: beat.key, bpm: String(beat.bpm), duration: minutes * 60 + seconds };
});
