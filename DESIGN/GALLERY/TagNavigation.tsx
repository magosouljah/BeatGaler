import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import { DEMO_TAGS } from "../shared/data";
import type { DemoTag } from "../shared/data";

type Filter = "include" | "exclude";
type Spring = { x: number; velocity: number };
const CLOSE_DELAY = 900;
const LONG_PRESS_DELAY = 550;
const PALETTE = [
  { name: "Red", hex: "#FF3B30" }, { name: "Orange", hex: "#FF9500" },
  { name: "Yellow", hex: "#FFCC00" }, { name: "Green", hex: "#34C759" },
  { name: "Blue", hex: "#007AFF" }, { name: "Purple", hex: "#AF52DE" },
  { name: "Gray", hex: "#8E8E93" }
] as const;

// DOM order follows visual order for focus and assistive technology.
// FLIP preserves the current pixel position and velocity when interrupted.
export default function TagNavigation({ filters, onCycleTag, onClear, tagColors, setTagColors }: {
  filters: Partial<Record<DemoTag, Filter>>;
  onCycleTag: (name: DemoTag) => void;
  onClear: () => void;
  tagColors: Record<string, string>;
  setTagColors: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const [visible, setVisible] = useState(false);
  const [editingTag, setEditingTag] = useState<DemoTag | null>(null);
  const [palettePosition, setPalettePosition] = useState({ left: 0, top: 0 });
  const [edges, setEdges] = useState({ left: false, right: false });
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<DemoTag, HTMLButtonElement>());
  const itemRefs = useRef(new Map<DemoTag, HTMLDivElement>());
  const beforeLayout = useRef<Map<DemoTag, number> | null>(null);
  const springs = useRef(new Map<DemoTag, Spring>());
  const frame = useRef<number | null>(null);
  const lastFrame = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerOrigin = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef<{ tag: DemoTag; time: number } | null>(null);
  const scrollToStart = useRef(false);
  const ordered = useMemo(() => [
    ...DEMO_TAGS.filter(name => filters[name] !== undefined),
    ...DEMO_TAGS.filter(name => filters[name] === undefined)
  ], [filters]);
  const orderKey = ordered.join("|");

  const clearHide = useCallback(() => {
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);
  const show = useCallback(() => { clearHide(); setVisible(true); }, [clearHide]);
  const scheduleHide = useCallback(() => {
    if (editingTag || rootRef.current?.contains(document.activeElement)) return;
    if (hideTimer.current !== null) return;
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setVisible(false);
    }, CLOSE_DELAY);
  }, [editingTag]);
  const clearLongPress = () => {
    if (longPress.current !== null) clearTimeout(longPress.current);
    longPress.current = null;
    pointerOrigin.current = null;
  };
  const saveLayout = () => {
    const positions = new Map<DemoTag, number>();
    itemRefs.current.forEach((node, name) => positions.set(name, node.getBoundingClientRect().left));
    beforeLayout.current = positions;
  };

  const stepSpring = (time: number) => {
    const dt = lastFrame.current ? Math.min((time - lastFrame.current) / 1000, 0.032) : 1 / 60;
    lastFrame.current = time;
    springs.current.forEach((spring, name) => {
      // Critically damped mass=1 / stiffness=400 / damping=40, no rubber effect.
      spring.velocity += (-400 * spring.x - 40 * spring.velocity) * dt;
      spring.x += spring.velocity * dt;
      const node = itemRefs.current.get(name);
      if (Math.abs(spring.x) < 0.35 && Math.abs(spring.velocity) < 2) {
        if (node) node.style.transform = "";
        springs.current.delete(name);
      } else if (node) {
        node.style.transform = "translate3d(" + spring.x + "px, 0, 0)";
      }
    });
    frame.current = springs.current.size ? requestAnimationFrame(stepSpring) : null;
  };

  useLayoutEffect(() => {
    const before = beforeLayout.current;
    if (!before) return;
    beforeLayout.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    const previous = springs.current;
    itemRefs.current.forEach(node => { node.style.transform = ""; });
    const next = new Map<DemoTag, Spring>();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) itemRefs.current.forEach((node, name) => {
      const oldLeft = before.get(name);
      if (oldLeft === undefined) return;
      const x = oldLeft - node.getBoundingClientRect().left;
      if (Math.abs(x) < 0.5 && !previous.has(name)) return;
      next.set(name, { x, velocity: previous.get(name)?.velocity ?? 0 });
      node.style.transform = "translate3d(" + x + "px, 0, 0)";
    });
    springs.current = next;
    lastFrame.current = 0;
    if (next.size) frame.current = requestAnimationFrame(stepSpring);
    if (scrollToStart.current) {
      scrollToStart.current = false;
      const scroller = scrollerRef.current;
      if (scroller && scroller.scrollLeft > 2)
        scroller.scrollTo({ left: 0, behavior: reduced ? "instant" : "smooth" });
    }
  }, [orderKey]);

  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges(current => current.left === left && current.right === right ? current : { left, right });
  }, []);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const next = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, el.scrollLeft + event.deltaY));
      if (Math.abs(next - el.scrollLeft) > 0.25) {
        event.preventDefault();
        el.scrollLeft = next;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("scroll", updateEdges, { passive: true });
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    updateEdges();
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("scroll", updateEdges);
      observer.disconnect();
    };
  }, [updateEdges, orderKey]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const toolbar = document.querySelector(".studio-candidate.is-gallery .studio-candidate-toolbar") ?? document.querySelector(".lab-gallery-toolbar-float");
      const toolbarLeft = toolbar?.getBoundingClientRect().left ?? window.innerWidth;
      const inRevealZone = event.clientY <= 78 && event.clientX < toolbarLeft - 12;
      if (inRevealZone || rootRef.current?.contains(event.target as Node)) show();
      else scheduleHide();
    };
    const focus = (event: FocusEvent) => {
      if (rootRef.current?.contains(event.target as Node)) show();
      else scheduleHide();
    };
    document.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("focusin", focus);
    };
  }, [show, scheduleHide]);

  useEffect(() => {
    if (!editingTag) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setEditingTag(null);
        buttonRefs.current.get(editingTag)?.focus({ preventScroll: true });
      }
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!paletteRef.current?.contains(target) && !buttonRefs.current.get(editingTag)?.contains(target))
        setEditingTag(null);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [editingTag]);

  useEffect(() => {
    const reveal = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        show();
        requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>(".lab-gallery-tag")?.focus({ preventScroll: true }));
      }
    };
    document.addEventListener("keydown", reveal);
    return () => document.removeEventListener("keydown", reveal);
  }, [show]);

  useEffect(() => () => {
    clearHide();
    clearLongPress();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    itemRefs.current.forEach(node => { node.style.transform = ""; });
  }, [clearHide]);

  const openPalette = (name: DemoTag) => {
    clearLongPress();
    const rect = buttonRefs.current.get(name)?.getBoundingClientRect();
    if (!rect) return;
    setPalettePosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 196)),
      top: Math.max(12, Math.min(rect.bottom + 10, window.innerHeight - 194))
    });
    setEditingTag(name);
    show();
  };
  const beginLongPress = (name: DemoTag, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") return;
    clearLongPress();
    pointerOrigin.current = { x: event.clientX, y: event.clientY };
    longPress.current = setTimeout(() => {
      suppressClick.current = { tag: name, time: Date.now() };
      openPalette(name);
    }, LONG_PRESS_DELAY);
  };
  const moveLongPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = pointerOrigin.current;
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 9)
      clearLongPress();
  };
  const activate = (name: DemoTag) => {
    const suppress = suppressClick.current;
    suppressClick.current = null;
    if (suppress?.tag === name && Date.now() - suppress.time < 1800) return;
    saveLayout();
    if (filters[name] === undefined) scrollToStart.current = true;
    onCycleTag(name);
  };
  const reset = () => { saveLayout(); onClear(); };
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const buttons = Array.from(scrollerRef.current?.querySelectorAll<HTMLButtonElement>(".lab-gallery-tag") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  const allActive = !DEMO_TAGS.some(name => filters[name] !== undefined);

  return (
    <>
      <div ref={rootRef} className={"lab-gallery-tags-layer" + (visible ? " is-open" : "")}
        role="group" aria-label="Tag filters" onFocusCapture={show}>
        <div ref={scrollerRef} className={"lab-gallery-tag-bar" + (edges.left ? " has-left" : "") + (edges.right ? " has-right" : "")}
          onKeyDown={moveFocus} tabIndex={0} aria-label="Horizontal tag navigation">
          <div ref={contentRef} className="lab-gallery-tag-track">
            <button type="button" className={"lab-gallery-tag lab-gallery-tag-all" + (allActive ? " is-included" : "")}
              aria-pressed={allActive} onClick={reset}>All</button>
            {ordered.map(name => {
              const state = filters[name] ?? "idle";
              const color = tagColors[name];
              return <div key={name} ref={node => { if (node) itemRefs.current.set(name, node); else itemRefs.current.delete(name); }}
                className="lab-gallery-tag-wrap">
                <button type="button" ref={node => { if (node) buttonRefs.current.set(name, node); else buttonRefs.current.delete(name); }}
                  className={"lab-gallery-tag is-" + state}
                  style={color ? { "--lab-tag-color": color } as CSSProperties : undefined}
                  aria-pressed={state === "include"}
                  aria-label={name + ": " + state + ". Click to filter; right-click, long-press or Shift+F10 to change color."}
                  title="Click to include, exclude or clear · Right-click to edit color"
                  onClick={() => activate(name)}
                  onContextMenu={event => { event.preventDefault(); openPalette(name); }}
                  onPointerDown={event => beginLongPress(name, event)}
                  onPointerMove={moveLongPress}
                  onPointerUp={clearLongPress}
                  onPointerCancel={clearLongPress}
                  onPointerLeave={clearLongPress}
                  onKeyDown={event => {
                    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                      event.preventDefault();
                      openPalette(name);
                    }
                  }}>{name}</button>
              </div>;
            })}
          </div>
        </div>
      </div>
      {editingTag && <div ref={paletteRef} className="lab-tag-color-popover lab-tag-color-popover--floating"
        role="group" aria-label={"Colores de " + editingTag} style={palettePosition}>
        <div className="lab-tag-color-swatches">
          {PALETTE.map(option => <button type="button" key={option.hex}
            className={tagColors[editingTag] === option.hex ? "is-current" : ""}
            style={{ background: option.hex }} title={option.name}
            aria-label={option.name} aria-pressed={tagColors[editingTag] === option.hex}
            onClick={() => { setTagColors(current => ({ ...current, [editingTag]: option.hex })); setEditingTag(null); }}/>)}
        </div>
        <button type="button" className="lab-tag-color-none" onClick={() => {
          setTagColors(current => { const next = { ...current }; delete next[editingTag]; return next; });
          setEditingTag(null);
        }}>Sin color</button>
      </div>}
    </>
  );
}
