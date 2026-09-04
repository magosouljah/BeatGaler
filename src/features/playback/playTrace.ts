import { traceClock } from "../perf/traceClock";

export type PlayTraceDetail = Record<string, unknown>;

let spanSequence = 0;

function publishWebPrefixTiming(stage: string, detail: PlayTraceDetail): void {
  if (typeof window === "undefined") return;
  const eligible = stage === "SOURCE_PREFETCH_PROGRESS" ||
    stage === "SOURCE_PREFETCH_READY" ||
    stage === "SOURCE_PREFETCH_CONSUMED" ||
    (stage === "SOURCE_MSE_APPEND_DONE" && Number(detail.append_seq || 0) === 1);
  if (!eligible) return;

  const beatId = String(detail.beat_id || "").trim();
  const bytes = Math.max(0, Number(detail.bytes || 0));
  const playableSeconds = Math.max(0, Number(detail.playable_seconds || detail.buffered_duration_s || 0));
  if (!beatId || bytes <= 0 || playableSeconds <= 0) return;

  window.dispatchEvent(new CustomEvent("beatgaler:web-playback-prefix-timing", {
    detail: { beatId, bytes, playableSeconds },
  }));
}

/**
 * Temporary Issue #97 runtime trace. Keep payloads free of credentials/chat ids.
 * Epoch time lets main-thread and Worker events be correlated in one console log.
 */
export function playTrace(stage: string, detail: PlayTraceDetail = {}): void {
  try {
    console.info(`[play-trace] ${JSON.stringify({ ...detail, ...traceClock(), stage })}`);
    publishWebPrefixTiming(stage, detail);
  } catch { /* Diagnostics must never break the operation being measured. */ }
}

/** Call-site constants/counts only: never pass a session, key, URL or raw error. */
export function playTraceSpan(stage: string, detail: PlayTraceDetail = {}) {
  const started = performance.now();
  const spanId = ++spanSequence;
  playTrace(`${stage}_BEGIN`, { ...detail, span_id: spanId });
  return (outcome: "done" | "error" = "done", result: PlayTraceDetail = {}) => {
    playTrace(`${stage}_${outcome.toUpperCase()}`, {
      ...detail, ...result, span_id: spanId,
      elapsed_ms: Math.round((performance.now() - started) * 10) / 10,
    });
  };
}

export async function observePlayStep<T>(stage: string, operation: () => Promise<T>, detail: PlayTraceDetail = {}): Promise<T> {
  const end = playTraceSpan(stage, detail);
  try {
    const result = await operation();
    end();
    return result;
  } catch (error) {
    end("error");
    throw error;
  }
}
