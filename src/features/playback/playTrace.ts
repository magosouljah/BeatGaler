export type PlayTraceDetail = Record<string, unknown>;

function elapsedMs(): number {
  try {
    return Math.round(performance.now() * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * Temporary Issue #97 runtime trace. Keep payloads free of credentials/chat ids.
 * Epoch time lets main-thread and Worker events be correlated in one console log.
 */
export function playTrace(stage: string, detail: PlayTraceDetail = {}): void {
  console.info(`[play-trace] ${JSON.stringify({
    ts_ms: Date.now(),
    t_ms: elapsedMs(),
    stage,
    ...detail,
  })}`);
}
