import { traceClock } from "../perf/traceClock";

export type PlayTraceDetail = Record<string, unknown>;

let spanSequence = 0;

/**
 * Temporary Issue #97 runtime trace. Keep payloads free of credentials/chat ids.
 * Epoch time lets main-thread and Worker events be correlated in one console log.
 */
export function playTrace(stage: string, detail: PlayTraceDetail = {}): void {
  try {
    console.info(`[play-trace] ${JSON.stringify({ ...detail, ...traceClock(), stage })}`);
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
