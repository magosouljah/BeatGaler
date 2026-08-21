# BeatGaler Web — Multiplatform implementation plan

## Product decisions

- Desktop and Web remain one product and one repository.
- Shared React UI and domain logic must not import Tauri directly.
- Desktop uses `DesktopAdapter`; browsers use `WebAdapter`.
- BeatGaler Web is a pure Web application and never requires a Desktop helper.
- Galer Cloud is the product name for storage in UI, errors, documentation, and new code.
- Web drag and drop accepts exactly one beat per user action.
- Web transfers go directly from the browser to Galer Cloud; file bytes do not cross the control server.
- The prototype may receive encrypted transport credentials and decrypt them in the browser.
- Credential revocation and final production hardening are intentionally deferred until functional parity is complete.
- Desktop behavior and its existing tests must remain green throughout the migration.

## Target architecture

```text
Shared React UI + shared domain
             |
       PlatformAdapter
        /           \
DesktopAdapter     WebAdapter
Tauri/Rust         Browser APIs + direct Galer Cloud transport
```

Platform-specific behavior is controlled by an explicit capability matrix. React components must not accumulate scattered `if (web)` checks.

## Implementation status

- Phase 1 is complete: shared beat domain, capability matrix, platform contracts, runtime adapter selection, React provider, and regression coverage are in place.
- Phase 2 slice A is complete: the repository has dedicated Web dev/build/preview commands; authentication, external links, background events, and performance diagnostics now cross platform ports; and the signed-out account shell renders and logs in with a persistent browser client ID.
- Phase 2 slice B is complete: the signed-in browser shell bypasses native startup, library transactions cross the platform boundary, shared preferences persist in the browser, and Settings hides native Trash, playback cache, developer tools, and updater features by capability.
- Phase 2 remains in progress: import, playback, card actions, and the remaining `App.tsx` controllers still need to move behind platform ports before the authoritative Galer Cloud Web library can be connected.

## Canonical model rule

The shared beat model contains identity, metadata, artwork, asset availability, and opaque Galer Cloud references. Filesystem paths live only in `DesktopBeatSources`. Existing `Beat` remains unchanged until callers are migrated incrementally.

## Delivery phases

### Phase 1 — Foundation

- Add the platform-neutral beat model.
- Add the capability matrix.
- Add adapter contracts and runtime selection.
- Mount a React `PlatformProvider` without changing Desktop behavior.
- Add regression tests for Desktop-only capability isolation.

Exit gate: TypeScript, unit tests, component tests, integration tests, and the production build remain green.

### Phase 2 — Browser shell

- Remove direct Tauri imports from shared React entry points.
- Split `App.tsx` orchestration into library, import, playback, transfer, and settings controllers.
- Render the real interface through `WebAdapter`.
- Hide unsupported actions using capabilities, not duplicated components.

Exit gate: the same cards, navigation, modals, player, search, filters, tags, and settings shell render in a normal browser.

### Phase 3 — Web authentication and sessions

- Generate and persist a browser installation ID.
- Adapt registration, login, account restoration, plans, limits, devices, and simultaneous sessions.
- Keep Desktop authentication behavior unchanged.

Exit gate: a Web session can log in, restore after refresh, log out, and display the correct plan.

### Phase 4 — Direct Galer Cloud transport spike

- Run transport inside a dedicated Web Worker.
- Receive the prototype credential envelope from the control plane.
- Decrypt credentials in memory only.
- Upload in chunks without loading the complete file into RAM.
- Prove 100 MB, 500 MB, and 1.9 GB uploads in supported browsers.
- Prove progressive download and byte-range playback.

Exit gate: file bytes travel browser-to-Galer-Cloud without crossing the control server.

### Phase 5 — Authoritative Web library

- Read the Galer T-Library Schema v2 index.
- Map opaque cloud references into `BeatRecord`.
- Serialize index reads and commits.
- Add conflict detection and refresh events shared with Desktop.

Exit gate: Desktop and Web display the same account library without stale merges.

### Phase 6 — Web import and Review Beat

- Accept one beat per picker or drop action.
- Support MP3, WAV, artwork, PROJECT ZIP, Samples, and supported folders/files from browser APIs.
- Show Review Beat immediately and hydrate expensive metadata progressively.
- Enforce plan limits before transfer and again in the control plane.

Exit gate: a browser import appears in Review immediately and commits one valid beat.

### Phase 7 — Playback, downloads, and artwork

- Add direct progressive playback.
- Add MP3/WAV/PROJECT downloads through browser download APIs.
- Reuse artwork crop and metadata UI.
- Define Web cache behavior separately from Desktop Available Offline.

Exit gate: play, seek, artwork hydration, and downloads work after a clean browser refresh.

### Phase 8 — Editing and lifecycle

- Edit metadata and artwork.
- Replace asset slots.
- Implement Trash, Restore, permanent delete, and conflict handling.
- Preserve the single authoritative index transaction rule.

Exit gate: lifecycle tests pass across one Desktop client and one Web client.

### Phase 9 — Capability-complete UI

- Keep Desktop-only actions hidden on Web: open in DAW, reveal in Explorer/Finder, folder monitoring, native external drops, unrestricted filesystem access, and native updater.
- Split Settings into shared and platform sections.
- Decide separately whether Web offline packages are worth implementing.

### Phase 10 — Production readiness

- Responsive layouts for desktop browsers and iPhone.
- Chrome, Safari, Firefox, and mobile browser coverage.
- Memory, retry, resume, poor-network, and large-file testing.
- Security hardening and the final credential lifecycle.
- HTTPS hosting, metrics, backups, deployment checks, and rollback.

## First implementation rule

No Web feature may be implemented by copying a shared component. A missing capability is added to the adapter contract, implemented per platform, tested, and then enabled in the capability matrix.
