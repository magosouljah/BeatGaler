# Gallery overlay positioning — audit and implementation plan (2026-11-03)

Scope: `DESIGN/` on `design/beatgaler-design-system-lab-v1`. The five temporary screenshots were reviewed before implementation. No production files, MASTER optical shader or presets are in scope.

## Diagnosis

1. **Filters change Toolbar coordinates.** `GalleryPage.tsx` measures `.lab-gallery-grid` children via `getBoundingClientRect()`, finds the last visible tile in the first row and writes `toolbar.style.right`. Filtering to two tiles shifts that measured right edge far left; zero results retain a stale inline offset. An observer on the grid repeats these writes when results or columns change. This incorrectly treats the 10px visual alignment reference as a dynamic anchor.
2. **Scroll changes Toolbar coordinates.** The same layout effect subscribes to `window.scroll`, combines `first.top + 10` (document content moving through the viewport), a tag-bottom approximation (`stack.top + 50/46`), and a CSS base `top` into an inline `--gallery-tags-push`. As scroll changes `first.top`, `Math.max` changes branches. Tag auto-close also changes `tagsVisible`. The resulting CSS transition animates an unintended layout correction rather than an intentional reveal. Approximated 50/46px height ignores the actual strip size.
3. **Tag band is too thin.** Both the surface, scroll viewport and track are currently only 50px (46px in compact layout), whereas screenshot 4 calls for a substantially deeper band. Font weight is not the problem; the existing 44px target and text alignment can remain, including the intentional -6px text offset.

## Layout contract

- **Only one spatial source of truth:** CSS variables owned by `.lab-gallery-page`. A responsive gallery frame is centered in the viewport, with the existing 32px (desktop) / 16px (compact) inset tokens. The toolbar's right edge uses this frame and an existing inset token, **never the grid or its visible tiles**.
- **Viewport-fixed overlays:** the inset Tag Bar and Studio Toolbar remain independently fixed in the viewport. The Gallery grid scrolls normally underneath. The Studio Toolbar maintains its 600px WebGL canvas and existing lens controls.
- **Vertical coordinates:** Tag Bar top is the existing 24px / 16px token. The desired band height is the existing 96px token (screenshot 4); its 44px / 40px text targets remain centered with the approved -6px visual lift. Toolbar closed top is 20px / 16px. When tags are open, the toolbar top equals **tag top + band height + 8px gap**, computed entirely by CSS from the same variables.
- **Intentional motion:** Tag Bar reveal and Toolbar vertical transform share the **same** existing 180ms easing/duration; this guarantees the gap through an interruptible open/close, rather than converging only at rest. Tag spring reordering, horizontal scrolling, material variants, auto-hide, filter pinning and Glass refresh remain unchanged.
- **State changes:** filtering, zero results, column breakpoints, scrolling and grid resize do not change overlay geometry. Only a deliberate Tag Bar visibility change moves the Toolbar. Compact viewport updates the shared frame and top tokens, not tile measurements. Reduced-motion keeps immediate switching.

## Verification plan

Update static contracts to reject dynamic first-row/grid measurement and require shared responsive CSS coordinates; update Chrome browser checks to compare `getBoundingClientRect()` in no-filter, partial-filter, zero-result, one-wheel/deep scroll, reveal/hide/reveal, interrupted transitions, alternate Tag Bar material and desktop/compact widths. Verify band height and 8px settled gap. Run `node --test DESIGN/lab-contract.test.mjs`, DESIGN TypeScript, DESIGN Vite build and, where browser access permits, `node DESIGN/gallery-browser-check.mjs`. Remove the entire temporary reference directory from the final branch tree without rewriting history.

## Validation results

The dedicated Design Lab workflow for commit `38fc017e17929f65fd42d3704025f8554d61b5ce` [passed](https://github.com/magosouljah/BeatGaler/actions/runs/41704983106). GitHub Actions confirmed: 22 Node contracts/spring tests; isolated TypeScript; Vite build; Chrome Playbar, Toolbar V2, Studio 44, and Gallery browser checks. Gallery assertions use real `getBoundingClientRect()` values for filtered and empty views, mouse/touch auto-hide, interrupted reveal, scroll, and responsive layouts. At viewport 840px the measured tag band was 96px (`top:24`, `bottom:120`), Toolbar top was 128px (8px gap), and Toolbar right was 28px inside the fixed frame. At 390px, the gap was also 8px and the WebGL viewport stayed 600px tall. No production paths were modified.

Root cause of the extra CI auto-hide failure: headless Chrome advertised `(pointer: coarse)` while simulated mouse events were active. `TagNavigation.tsx` now follows the actual last input type: the mouse allows the existing 900ms hide delay, and touch keeps the strip discoverable. This preserves existing selection pinning and keyboard access. Under SwiftShader, transitional frames can be delayed; Chrome checks now wait for a settled rectangle rather than assuming a 300ms wall-clock delay means the 180ms CSS transition has completed.

## Reference cleanup

The five temporary WebP screenshots and their temporary README were reviewed, then deleted from the final branch tree. This ordinary forward commit retains Git history and leaves the permanent reference assets intact.
