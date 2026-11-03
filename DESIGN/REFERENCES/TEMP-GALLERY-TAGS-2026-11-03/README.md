# Temporary references — Gallery tags and toolbar (2026-11-03)

These five user-supplied screenshots are **visual references only**, not design specifications or files to serve in the app. They have been converted to space-efficient WebP copies at their original pixel dimensions solely for reviewing this issue.

1. [Image 1: selected filter and toolbar overlap](./01-filter-toolbar-overlap.webp) — filtering reduces the grid to two beats; the Studio Toolbar overlaps the beats. **Do not anchor or chase the toolbar relative to whichever beats survive filtering.** The requested 10 px was a padding / alignment reference, not instructions to attach the toolbar to moving beat tiles.
2. [Image 2: before one wheel scroll](./02-toolbar-before-wheel.webp) — original toolbar placement / margin to preserve.
3. [Image 3: after one wheel scroll](./03-toolbar-after-wheel.webp) — toolbar moves closer after just one scroll. This is **unwanted**: preserve the same margin across scrolling, tag reveal / hide, filtering and responsive grid changes.
4. [Image 4: desired tag bar thickness](./04-desired-tag-weight.webp) — this is the requested visual weight for the **tag bar band itself**, not necessarily the tags' font weight; compare carefully to the next image.
5. [Image 5: current too-thin tag bar](./05-current-tag-weight.webp) — current appearance to replace, maintaining consistent spacing to the toolbar.

**Task guardrails:** Work exclusively in DESIGN on design/beatgaler-design-system-lab-v1. Inspect current code and Design System references; diagnose layout/scroll dependencies before edits; prepare a brief implementation plan; implement and test; delete all five WebP images **and this README** in a final cleanup commit *after their use* (ordinary git deletion, not rewriting history). Do not modify production, main, Cloud or the approved Studio optical shader without explicit justification.
