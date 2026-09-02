export type WebBulkSaveItemStatus = "saved" | "conflict" | "failed";

export interface WebBulkSaveItem<T> {
  id: string;
  value: T;
}

export interface WebBulkSaveItemResult<T> {
  id: string;
  value: T;
  status: WebBulkSaveItemStatus;
  error: string | null;
}

export interface WebBulkSaveSummary<T> {
  total: number;
  completed: number;
  saved: number;
  conflicts: number;
  failed: number;
  results: WebBulkSaveItemResult<T>[];
}

export interface WebBulkSaveProgress<T> extends WebBulkSaveSummary<T> {
  currentId: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWebBulkSaveConflict(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("409")
    || message.includes("conflict")
    || message.includes("changed on another device")
    || message.includes("revision mismatch")
    || message.includes("version mismatch");
}

function summarize<T>(total: number, results: WebBulkSaveItemResult<T>[]): WebBulkSaveSummary<T> {
  return {
    total,
    completed: results.length,
    saved: results.filter(result => result.status === "saved").length,
    conflicts: results.filter(result => result.status === "conflict").length,
    failed: results.filter(result => result.status === "failed").length,
    results: [...results],
  };
}

/**
 * Save All coordinator for Web.
 *
 * Commits are deliberately sequential and per-item: each supplied commit keeps
 * its own durable INDEX CAS boundary. One conflict/failure never hides already
 * committed items and never prevents the remaining items from being attempted.
 * Retrying is explicit: pass only failed/conflicted items back into a new run,
 * so successful durable commits are not replayed.
 */
export async function saveAllWebItems<T>(
  items: readonly WebBulkSaveItem<T>[],
  commit: (item: WebBulkSaveItem<T>) => Promise<void>,
  onProgress?: (progress: WebBulkSaveProgress<T>) => void,
): Promise<WebBulkSaveSummary<T>> {
  const results: WebBulkSaveItemResult<T>[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!item.id || seen.has(item.id)) {
      results.push({
        id: item.id,
        value: item.value,
        status: "failed",
        error: item.id ? "Duplicate item in Save All batch." : "Save All item is missing an id.",
      });
      onProgress?.({ ...summarize(items.length, results), currentId: item.id || null });
      continue;
    }
    seen.add(item.id);

    try {
      await commit(item);
      results.push({ id: item.id, value: item.value, status: "saved", error: null });
    } catch (error) {
      results.push({
        id: item.id,
        value: item.value,
        status: isWebBulkSaveConflict(error) ? "conflict" : "failed",
        error: errorMessage(error),
      });
    }
    onProgress?.({ ...summarize(items.length, results), currentId: item.id });
  }

  const summary = summarize(items.length, results);
  onProgress?.({ ...summary, currentId: null });
  return summary;
}

export function retryableWebBulkSaveItems<T>(summary: WebBulkSaveSummary<T>): WebBulkSaveItem<T>[] {
  return summary.results
    .filter(result => result.status !== "saved")
    .map(result => ({ id: result.id, value: result.value }));
}
