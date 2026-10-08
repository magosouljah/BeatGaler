// Shared by the focused Task 4 harness and WDIO so the diagnostic pre-state
// and its runner window cannot diverge.
export const FOCUSED_FINAL_RELOAD_PRESTATE = Object.freeze({
  soak_minutes: 5,
  rotations: 1,
});

export function effectiveStage1SoakMinutes({ focusedFinalReloadTrace, configuredSoakMinutes }) {
  return focusedFinalReloadTrace
    ? FOCUSED_FINAL_RELOAD_PRESTATE.soak_minutes
    : configuredSoakMinutes;
}

export function effectiveStage1SoakRotations({ focusedFinalReloadTrace, configuredSoakRotations }) {
  return focusedFinalReloadTrace
    ? FOCUSED_FINAL_RELOAD_PRESTATE.rotations
    : configuredSoakRotations;
}
