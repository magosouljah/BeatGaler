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

## Phase 9A + 9B — Critical Import Core + Native Drop Contracts

Phase 9A adds deterministic Rust filesystem tests for the import rules that must hold before Desktop E2E:

- standalone MP3 is exactly one slot and never absorbs neighboring WAV/PROJECT/Samples;
- standalone WAV stays HQ-only during discovery and does not steal a neighboring MP3;
- structured beat folders pair matching MASTER MP3 + HQ WAV while leaving unrelated audio out;
- ambiguous folders preserve all plausible main-audio candidates for the conflict resolver;
- Samples/Stems/Backup/Backups/Audio trees never become independent beats;
- multiple beat folders are discovered independently in deterministic order;
- same-name loose MP3+WAV discovery produces one logical beat anchor.

Phase 9B adds a source-level regression guard that fails if Windows native filesystem drop stops using original Tauri paths, re-enters HTML staging/`arrayBuffer()`, loses artwork/card/library target arbitration, or mixes browser artwork payloads with filesystem import.

Run them through the normal gate:

```powershell
# Runs the Rust import-core tests plus all native-drop regression contracts as part of the normal automated suite
npm run check
```

The dedicated native-drop contract can also be run directly:

```powershell
# Runs only the Phase 9B native import architecture guard
node .\scripts\regression-import-native.mjs
```
