import type { Beat } from "../../types";
import { getActiveWebAccountId } from "../auth/activeWebAccount";

const INTERRUPTED_UPLOADS_KEY = "beatgaler:active-cloud-uploads:v1";
const WEB_INTERRUPTED_UPLOADS_PREFIX = "beatgaler:active-cloud-uploads:v2:";

function uploadJournalKey(accountId = getActiveWebAccountId()): string | null {
  if (typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__) {
    return accountId ? `${WEB_INTERRUPTED_UPLOADS_PREFIX}${encodeURIComponent(accountId)}` : null;
  }
  return INTERRUPTED_UPLOADS_KEY;
}

export type ActiveCloudUpload = {
  beatId: string;
  beatName: string;
  stagingPaths: string[];
};

export type InterruptedUploadRecoveryOptions = {
  beatgalerUserId: string;
  authoritativeBeatIds: Set<string> | null;
  cloudApiBase: string;
  authToken: string | null;
  purgeLocal: (beatId: string, stagingPaths: string[]) => Promise<unknown>;
  fetchImpl?: typeof fetch;
};

function activeUploadStagingPaths(beat: Beat): string[] {
  return [
    beat.mp3_path, beat.wav_path, beat.playback_path, beat.folder_path,
    beat.samples_path, beat.stems_path, beat.flp_path, beat.als_path,
    beat.loop_path, ...(beat.other_files ?? []),
  ].filter((value): value is string => !!value);
}

export function readActiveCloudUploads(accountId?: string | null): ActiveCloudUpload[] {
  try {
    const key = uploadJournalKey(accountId);
    if (!key) return [];
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(item => item?.beatId && item?.beatName) : [];
  } catch {
    return [];
  }
}

export function writeActiveCloudUploads(items: ActiveCloudUpload[], accountId?: string | null): void {
  try {
    const key = uploadJournalKey(accountId);
    if (!key) return;
    if (items.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(items));
  } catch {}
}

export function markCloudUploadActive(beat: Beat): void {
  const accountId = getActiveWebAccountId();
  const current = readActiveCloudUploads(accountId).filter(item => item.beatId !== beat.id);
  current.push({ beatId: beat.id, beatName: beat.name, stagingPaths: activeUploadStagingPaths(beat) });
  writeActiveCloudUploads(current, accountId);
}

export function clearCloudUploadActive(beatId: string): void {
  const accountId = getActiveWebAccountId();
  writeActiveCloudUploads(readActiveCloudUploads(accountId).filter(item => item.beatId !== beatId), accountId);
}

export async function rollbackInterruptedCloudUploads({
  beatgalerUserId,
  authoritativeBeatIds,
  cloudApiBase,
  authToken,
  purgeLocal,
  fetchImpl = fetch,
}: InterruptedUploadRecoveryOptions): Promise<string[]> {
  const accountId = getActiveWebAccountId();
  const pending = readActiveCloudUploads(accountId);
  if (pending.length === 0) return [];

  const rolledBack: string[] = [];
  const remaining: ActiveCloudUpload[] = [];

  for (const item of pending) {
    if (accountId && accountId !== getActiveWebAccountId()) return rolledBack;
    // A recovery marker only proves that the process died mid-flow. The cloud
    // INDEX remains authoritative: a committed beat must never be purged.
    if (authoritativeBeatIds?.has(item.beatId)) {
      console.info(`[upload-recovery] marker cleared for durable beat ${item.beatId}`);
      continue;
    }

    // If authority could not be verified, fail closed. Keep every marker so a
    // later launch can retry recovery without risking durable media.
    if (authoritativeBeatIds === null) {
      remaining.push(item);
      continue;
    }

    try {
      const response = await fetchImpl(`${cloudApiBase}/beats/delete-topic`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({ beatgalerUserId, beatId: item.beatId }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `HTTP ${response.status}`);
      }

      if (accountId && accountId !== getActiveWebAccountId()) return rolledBack;
      await purgeLocal(item.beatId, item.stagingPaths);
      rolledBack.push(item.beatName);
    } catch (error) {
      console.warn(`Could not roll back interrupted upload ${item.beatName}:`, error);
      remaining.push(item);
    }
  }

  writeActiveCloudUploads(remaining, accountId);
  return rolledBack;
}
