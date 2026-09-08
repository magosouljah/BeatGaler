import type { Beat } from "../../types";

const INTERRUPTED_UPLOADS_KEY = "beatgaler:active-cloud-uploads:v1";

export type ActiveCloudUpload = {
  beatId: string;
  beatName: string;
  stagingPaths: string[];
};

function activeUploadStagingPaths(beat: Beat): string[] {
  return [
    beat.mp3_path, beat.wav_path, beat.playback_path, beat.folder_path,
    beat.samples_path, beat.stems_path, beat.flp_path, beat.als_path,
    beat.loop_path, ...(beat.other_files ?? []),
  ].filter((value): value is string => !!value);
}

export function readActiveCloudUploads(): ActiveCloudUpload[] {
  try {
    const raw = localStorage.getItem(INTERRUPTED_UPLOADS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => item?.beatId && item?.beatName) : [];
  } catch {
    return [];
  }
}

export function writeActiveCloudUploads(items: ActiveCloudUpload[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(INTERRUPTED_UPLOADS_KEY);
    else localStorage.setItem(INTERRUPTED_UPLOADS_KEY, JSON.stringify(items));
  } catch {}
}

export function markCloudUploadActive(beat: Beat): void {
  const current = readActiveCloudUploads().filter(item => item.beatId !== beat.id);
  current.push({ beatId: beat.id, beatName: beat.name, stagingPaths: activeUploadStagingPaths(beat) });
  writeActiveCloudUploads(current);
}

export function clearCloudUploadActive(beatId: string): void {
  writeActiveCloudUploads(readActiveCloudUploads().filter(item => item.beatId !== beatId));
}
