// One clock per JS realm. t_ms is relative to that realm's time origin;
// ts_ms is comparable across main thread and Dedicated Workers on this device.
const contextId = Math.random().toString(36).slice(2, 10);

export function traceClock() {
  const t = performance.now();
  return {
    context_id: contextId,
    t_ms: Math.round(t * 10) / 10,
    time_origin_ms: performance.timeOrigin,
    ts_ms: Math.round((performance.timeOrigin + t) * 10) / 10,
  };
}
