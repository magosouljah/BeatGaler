import type { Beat } from "../../types";
import { libraryStateManager } from "../../lib/libraryStateManager";
import { preserveLoadedArtwork } from "./libraryPresentationCache";

/** Authority wins except for imports still owned by this renderer's upload queue. */
export function mergeActiveUploads(authoritative: Beat[], current: Beat[], activeIds: ReadonlySet<string>): Beat[] {
  const merged = preserveLoadedArtwork(authoritative, current);
  const present = new Set(merged.map(beat => beat.id));
  const local = current.filter(beat => activeIds.has(beat.id) && !present.has(beat.id));
  return local.length ? [...local, ...merged] : merged;
}

/** A read started before an upload completed must never replace the completed card. */
export async function reloadStableLibrary(getUploadRevision: () => number): Promise<{ beats: Beat[]; revision: number }> {
  for (;;) {
    const revision = getUploadRevision();
    const beats = await libraryStateManager.reloadAuthoritative();
    if (revision === getUploadRevision()) return { beats, revision };
  }
}
