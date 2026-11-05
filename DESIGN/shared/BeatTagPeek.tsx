import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from "react";

export type BeatTagPeekMode = "quiet-line" | "cover-overlay" | "edge-rail";
type Peek = {
  mode: BeatTagPeekMode;
  hidden: string[];
  left: number;
  top: number;
  width: number;
  keyboard: boolean;
};

/**
 * One 800ms timer and one tooltip layer for the entire gallery/specimen group.
 * All hover/focus events are delegated: zero hover state, timers or observers per card.
 */
export function useBeatTagPeek() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<HTMLElement | null>(null);
  const [peek, setPeek] = useState<Peek | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);
  const hide = useCallback(() => { clearTimer(); setPeek(null); }, [clearTimer]);

  const open = useCallback((trigger: HTMLElement, keyboard: boolean) => {
    const raw = trigger.dataset.hiddenTags;
    if (!raw) return;
    let hidden: string[];
    try { hidden = JSON.parse(raw) as string[]; } catch { return; }
    if (!hidden.length) return;
    const card = trigger.closest<HTMLElement>(".lab-beat-tile--v2");
    const mode = (card?.dataset.peekMode || "quiet-line") as BeatTagPeekMode;
    const rect = trigger.getBoundingClientRect();
    const cover = card?.querySelector<HTMLElement>(".lab-beat-tile__cover")?.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let width = Math.min(270, viewportWidth - 16);
    let left = Math.min(Math.max(8, rect.left), viewportWidth - width - 8);
    let top = rect.bottom + 4;
    if (mode === "cover-overlay" && cover) {
      width = cover.width;
      left = cover.left;
      top = cover.bottom - 60;
    } else if (mode === "edge-rail") {
      width = Math.min(225, Math.max(110, viewportWidth - 16));
      const rightSpace = viewportWidth - rect.right - 10;
      if (rightSpace >= width) left = rect.right + 7;
      else if (rect.left >= width + 10) left = rect.left - width - 7;
      else {
        width = Math.min(270, viewportWidth - 16);
        left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
        top = rect.bottom + 4;
      }
      if (top + 30 > viewportHeight) top = Math.max(8, rect.top - 31);
    } else if (top + 35 > viewportHeight) {
      top = Math.max(8, rect.top - 31);
    }
    setPeek({ mode, hidden, left, top, width, keyboard });
  }, []);

  const start = useCallback((trigger: HTMLElement, keyboard: boolean) => {
    if (!keyboard && pending.current === trigger) return;
    clearTimer();
    setPeek(null);
    pending.current = trigger;
    if (keyboard) open(trigger, true);
    else timer.current = setTimeout(() => {
      timer.current = null;
      if (trigger.isConnected && pending.current === trigger) open(trigger, false);
    }, 800);
  }, [clearTimer, open]);

  const findTrigger = (target: EventTarget | null) => target instanceof Element
    ? target.closest<HTMLElement>("[data-beat-tag-trigger]") : null;

  const onPointerOver = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    const trigger = findTrigger(event.target);
    if (!trigger || trigger.contains(event.relatedTarget as Node)) return;
    start(trigger, false);
  }, [start]);
  const onPointerOut = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const trigger = findTrigger(event.target);
    if (trigger && !trigger.contains(event.relatedTarget as Node)) hide();
  }, [hide]);
  const onFocusCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const trigger = findTrigger(event.target);
    if (trigger) start(trigger, true);
  }, [start]);
  const onBlurCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const trigger = findTrigger(event.target);
    if (trigger && !trigger.contains(event.relatedTarget as Node)) hide();
  }, [hide]);

  useEffect(() => {
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    window.addEventListener("scroll", hide, { passive: true, capture: true });
    window.addEventListener("keydown", closeOnKey);
    return () => {
      clearTimer();
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [clearTimer, hide]);

  return { peek, hide, onPointerOver, onPointerOut, onFocusCapture, onBlurCapture };
}

export function BeatTagPeekLayer({ peek }: { peek: Peek | null }) {
  if (!peek) return null;
  return (
    <div
      className={`lab-tag-peek lab-tag-peek--${peek.mode}`}
      data-keyboard={peek.keyboard}
      style={{ left: peek.left, top: peek.top, width: peek.width }}
      role="status" aria-label={`Tags adicionales: ${peek.hidden.join(", ")}`}
    >
      {peek.hidden.map(tag => <span key={tag} className="lab-tag-peek__tag">{tag}</span>)}
    </div>
  );
}
