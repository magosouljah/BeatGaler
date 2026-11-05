import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent } from "react";

type Peek = {
  colors: Record<string, string>;
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
    let colors: Record<string, string> = {};
    try { colors = JSON.parse(trigger.dataset.hiddenColors || "{}") as Record<string,string>; } catch { /* fallback to neutral */ }
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(160, viewportWidth - 16);
    const left = Math.min(Math.max(8, rect.left), viewportWidth - width - 8);
    const top = rect.bottom + 3;
    // This single overlay has no surrounding card and does not reflow the Gallery.
    setPeek({ hidden, colors, left, top: Math.min(top, viewportHeight - 26), width, keyboard });
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
  // Touch has no hover: tap the compact tag row to reveal, tap elsewhere to close.
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return;
    const trigger = findTrigger(event.target);
    if (trigger) start(trigger, true);
    else hide();
  }, [start, hide]);

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

  return { peek, hide, onPointerOver, onPointerOut, onPointerDown, onFocusCapture, onBlurCapture };
}

export function BeatTagPeekLayer({ peek }: { peek: Peek | null }) {
  if (!peek) return null;
  return (
    <div
      className="lab-tag-peek lab-tag-peek--quiet-line"
      data-keyboard={peek.keyboard}
      style={{ left: peek.left, top: peek.top, width: peek.width }}
      role="status" aria-label={`Tags adicionales: ${peek.hidden.join(", ")}`}
    >
      {peek.hidden.map(tag => <span key={tag} className="lab-tag-peek__tag"
        style={peek.colors[tag] ? { color: peek.colors[tag] } : undefined}>{tag}</span>)}
    </div>
  );
}
