# Issue #97 — Startup trace capture

This instrumentation is observational. It does not change startup routing, loading states, gallery rendering, or performance behavior.

## What is recorded

Each event is emitted to the console with the prefix `[startup-trace]` and retained in memory at:

```js
window.__BEATGALER_STARTUP_TRACE__
```

A copy can be retrieved with:

```js
window.beatgalerStartupTrace?.()
```

Events use milliseconds from the earliest application module execution and include only:

- lifecycle markers;
- the visible startup surface classification;
- visible beat-card count;
- a bounded auth-screen title when the auth UI is actually visible.

The tracer does **not** record beat IDs, beat names, account IDs, email addresses, tokens, media URLs, library payloads, or credentials.

## Surface vocabulary

- `startup_loader` — static HTML loader before React owns the startup surface;
- `auth_restore` — existing-session/auth restoration state;
- `auth_screen` — interactive auth surface;
- `library_loading` — library startup skeleton;
- `library_cards` — one or more real beat cards are mounted;
- `empty_gallery` — the literal Empty Gallery terminal UI is rendered;
- `library_shell` — gallery shell exists with zero cards and no explicit empty UI;
- `unknown` — no known startup surface matched.

## Reading a trace

The first `library_cards` event is the DOM-visible first-card milestone. Subsequent `card_count` events show whether cards are revealed progressively and at what cadence.

Any `empty_gallery` event that occurs before the authoritative library truth is known is evidence for the Issue #97 false-empty-state bug. This first instrumentation pass observes that behavior; it intentionally does not attempt to fix it yet.

Web and Desktop use the same tracer so cold/warm startup sequences can be compared with the same event vocabulary.
