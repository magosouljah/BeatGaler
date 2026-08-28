# BeatGaler Design Foundations — 11.1

This document records the reusable UI state contract introduced by the independent Fase 2 / 11.1 slice. It is intentionally frontend-only and does not define account API semantics.

## Tokens

`src/styles/design-foundations.css` is the foundation source for color, spacing, radius, typography, focus, control height, shadows, and motion. Components should consume the CSS variables/classes instead of duplicating literal visual values inline when a foundation class already exists.

## Typography

- Primary body: SF Pro Text / Segoe UI / Helvetica Neue / system UI fallback.
- `--font-xs`: compact labels/status text.
- `--font-sm`: secondary copy.
- `--font-md`: controls/body.
- `--font-lg`/`--font-xl`: section and account headings.
- Primary text is high-contrast on the dark canvas; muted copy remains visibly distinct from disabled text.

## Focus

Keyboard focus uses `:focus-visible` with a 2 px high-contrast ring and 2 px offset. Mouse focus does not add a decorative ring. Compound fields use `:focus-within` so the entire control receives the same focus affordance.

## Buttons

Variants: `primary`, `secondary`, `ghost`, `danger`.

States:
- default: variant background/border/text;
- hover: stronger surface/border without moving layout;
- focus-visible: shared high-contrast focus ring;
- active: 1 px press translation;
- disabled: non-interactive cursor + reduced opacity;
- loading: disabled, `aria-busy=true`, spinner plus persistent label.

Minimum control height is 44 px for mobile/touch usability.

## Fields

States:
- default;
- hover/focus border emphasis;
- invalid via `aria-invalid=true`;
- disabled;
- autofill with explicit dark background and light text so browser autofill cannot create unreadable light/yellow controls.

Fields support associated labels plus optional description/error IDs through `aria-describedby`.

## Feedback

`UiFeedback` provides `error`, `success`, and `info` tones. Error feedback intended for form submission should use `role=alert`; status/loading copy should use an appropriate live region at the caller.

## Dialog

`UiDialog` provides:
- `role=dialog`, `aria-modal=true`;
- labelled title and optional description;
- initial focus inside the dialog;
- Tab/Shift+Tab containment;
- Escape dismissal when dismissible;
- backdrop dismissal when dismissible;
- focus restoration when the dialog closes.

This is the foundation primitive; migration of every existing modal/confirm is a later, separately-scoped activity.

## Icons

`UiIcon` normalizes icon size/currentColor behavior. `UiIconButton` combines the shared button states with an explicit accessible label. Decorative icons are `aria-hidden` by default.

## Reduced motion

`prefers-reduced-motion: reduce` collapses non-essential animations/transitions globally to effectively zero duration. The spinner becomes static instead of continuously rotating.

## AccountGate adoption

The 11.1 slice moves the signed-out AccountGate shell onto the reusable foundation:
- responsive card width instead of a fixed 370 px-only layout;
- 390–430 px safe-area-aware spacing;
- semantic labels/IDs and browser autocomplete tokens;
- readable autofill;
- shared button/field/feedback/loading states;
- reduced inline visual duplication.

Account APIs, MFA/reset backend semantics, data-plane behavior, and YouTube are not changed by this foundation.
