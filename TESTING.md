# BeatGaler Automated Testing

## Current automated layers

### Unit tests

Run with:

```powershell
# Run the fast deterministic unit suites without opening BeatGaler Desktop
npm run test:unit
```

Current suites:

- `metadataValidation`
- `playbackReadiness`
- `beatRuntimeState`

### Architecture / regression guards

Run with:

```powershell
# Run the existing regression shields that protect BeatGaler architecture and known fixed bugs
npm run test:regressions
```

These guards are intentionally kept separate from unit tests. They protect architectural invariants such as native drag/drop, Pinterest Option 2, playback readiness, runtime-state wiring, retry behavior, Direct-mode ownership, Trash/index behavior, PROJECT handling, and export behavior.

### Fast test gate

```powershell
# Run unit tests first, then all existing regression guards
npm run test:fast
```

`npm test` currently aliases this fast gate.

### Full local check

```powershell
# Run the fast automated test gate and then compile/build the application
npm run check
```

## Test pyramid implementation order

1. Expand Unit Tests.
2. Add Component Tests.
3. Add fake-service Integration Tests.
4. Add real isolated Integration Tests.
5. Add Desktop E2E.
6. Keep aesthetic/judgment-only checks Manual until the end.

## Rule

If a behavior can be proven reliably at a lower layer, do not duplicate every case at E2E. E2E should verify a small number of complete user journeys while unit/integration tests cover the combinatorial cases.
