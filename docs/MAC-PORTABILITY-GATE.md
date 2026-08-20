# BeatGaler macOS Portability Gate

This gate is designed so Mac-specific regressions are found before a physical Mac is needed.

## Level A — Windows / portable gate

Run this from the BeatGaler repository on Windows:

```powershell
# Runs static Mac architecture checks, TypeScript, component/integration tests, cloud tests, Rust tests, regressions, and validates Cargo.lock.
npm run test:mac-portability
```

What this catches without a Mac:

- Offline state accidentally replacing live metadata or artwork.
- PROJECT ZIP code falling back to Windows-only PowerShell or shell zip/unzip.
- Logic `.logicx` create/extract/edit/repack regressions.
- Finder/local drag accidentally becoming Windows-only or losing native-path arbitration.
- Fixed local data-plane ports, unowned child processes, stale-runtime reuse, and sleep/wake lease recovery regressions.
- Hidden storage/transport terminology leaking through user-visible errors.
- Unicode NFC/NFD identity regressions.
- Missing updater platforms or Windows/Mac manifest clobbering.
- Stale or drifting Rust dependencies.
- Missing Mac build invariants: ARM/Intel pipelines, signing checks, minimum macOS target, runtime dylib audit, updater endpoint, and pinned runtime source.

The first Cargo run after a dependency change may update `src-tauri/Cargo.lock`. That is expected. Commit the resulting lock only after the gate passes.

## Level B — hosted native macOS CI

`.github/workflows/test-macos-portability.yml` repeats the gate on hosted native macOS runners for both Apple Silicon and Intel.

The native jobs use the committed lockfile (`cargo test --locked`). This means CI refuses to silently resolve a different Rust dependency graph from the one tested on Windows.

The public Fast ARM64 and Universal release workflows additionally test the real embedded Mach-O runtimes. They verify:

- CPU architecture.
- Minimum supported macOS version.
- FFmpeg, Node, and the local data-plane runtime only link to Apple system dylibs.
- Nested executable signatures.
- Final app signature; public Universal release also checks notarization/stapling.

## Level C — physical Mac acceptance only

A physical Mac is still required for behavior that depends on Finder/macOS UI or real machine lifecycle rather than application logic:

- Real Finder drag/drop and browser/Pinterest drag/drop together.
- Gatekeeper/quarantine after downloading the DMG from the Internet.
- Closing the lid and waking after the server lease timeout.
- Red close button, Dock reopen, and Cmd+Q behavior as perceived by a user.
- External drives, iCloud Drive, Finder aliases, network shares, and unusual filesystem permissions.
- Final audio/project workflow in installed FL Studio, Ableton Live, and Logic Pro.

These are acceptance tests, not the first place BeatGaler should discover ordinary portability bugs.

## Release rule

A macOS DMG must not be published unless:

1. Level A passes.
2. `src-tauri/Cargo.lock` has no uncommitted changes.
3. Level B passes on both architectures.
4. The actual Fast/Universal build workflow passes its runtime/signing checks.
5. Level C has passed for the release candidate.
