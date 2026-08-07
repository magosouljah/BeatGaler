import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
// Drop-in scheduler — no Tailwind, no new deps. Styled entirely with
// inline React styles, same pattern your app already uses elsewhere.
//
// Controlled the same way your original component was: value / onChange / minDate.
interface UploadSchedulerProps {
  value?: Date | null;
  onChange?: (d: Date) => void;
  minDate?: Date;
}
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MESES_CORTOS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const DIAS_SEMANA = ['L','M','M','J','V','S','D'];
const FIELD_ORDER = ['day', 'month', 'year', 'hour', 'minute'] as const;
type FieldName = typeof FIELD_ORDER[number];
// ---- monochrome palette (matches your #0c0c0c app shell, no accent color) ----
const COL = {
  bg: '#141414',
  border: '#262626',
  borderFlash: '#e11d48',
  text: '#f4f4f5',
  textDim: '#71717a',
  textFaint: '#3f3f46',
  active: 'rgba(255,255,255,0.08)',
  activeRing: 'rgba(255,255,255,0.35)',
  hover: '#1f1f1f',
  selectedBg: '#f4f4f5',
  selectedText: '#0c0c0c',
  barLow: '#52525b',
  barHigh: '#e4e4e7',
};
function pad(n: number | string) { return String(n).padStart(2, '0'); }
function daysInMonth(year: number, month: number) { return new Date(year, month + 1, 0).getDate(); }
// React attaches onWheel as a PASSIVE listener by default (since React 17),
// which means calling e.preventDefault() inside a normal onWheel prop is
// silently ignored — the browser still scrolls the nearest scrollable
// ancestor (in this case, the whole modal) even though we "prevented" it.
// The only reliable fix is a real, non-passive native listener.
function useNonPassiveWheel<T extends HTMLElement>(
  ref: React.RefObject<T>,
  handler: ((e: WheelEvent) => void) | null,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !handler) return;
    const listener = (e: WheelEvent) => handler(e);
    el.addEventListener('wheel', listener, { passive: false });
    return () => el.removeEventListener('wheel', listener);
  }, [ref, handler]);
}
function sameDate(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
function mondayFirstWeekday(year: number, month: number, day: number) { return (new Date(year, month, day).getDay() + 6) % 7; }
function diffMonths(a: Date, b: Date) { return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()); }
// ---- circular 15-minute hour picker: 48 unique quarter-hour values,
// windowed via modulo — loops forever, never duplicates, always :00/:15/:30/:45 ----
const HOUR_LABELS: string[] = [];
for (let h = 0; h < 12; h++) {
  const displayHour = h === 0 ? 12 : h;
  for (const m of [0, 15, 30, 45]) HOUR_LABELS.push(`${displayHour}:${pad(m)}`);
}
const WHEEL_CYCLE = HOUR_LABELS.length;
const WHEEL_ITEM_H = 34;
const WHEEL_VISIBLE = 5;
function HourWheel({ hour12, minute, onSelect }: { hour12: number; minute: number; onSelect: (h12: number, m: number) => void }) {
  const initialIndex = useMemo(() => {
    const q = Math.round(minute / 15) % 4;
    const idx = HOUR_LABELS.indexOf(`${hour12}:${pad(q * 15)}`);
    return idx === -1 ? 0 : idx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [centerIndex, setCenterIndex] = useState(initialIndex);
  const accum = useRef(0);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const real = ((centerIndex % WHEEL_CYCLE) + WHEEL_CYCLE) % WHEEL_CYCLE;
    onSelect(real < 4 ? 12 : Math.floor(real / 4), (real % 4) * 15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerIndex]);
  const wheelAreaRef = useRef<HTMLDivElement | null>(null);
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    accum.current += e.deltaY;
    while (accum.current >= WHEEL_ITEM_H) { accum.current -= WHEEL_ITEM_H; setCenterIndex(i => i + 1); }
    while (accum.current <= -WHEEL_ITEM_H) { accum.current += WHEEL_ITEM_H; setCenterIndex(i => i - 1); }
  }, []);
  useNonPassiveWheel(wheelAreaRef, handleWheel);
  const half = Math.floor(WHEEL_VISIBLE / 2);
  const rows: { off: number; label: string }[] = [];
  for (let off = -half; off <= half; off++) {
    const real = (((centerIndex + off) % WHEEL_CYCLE) + WHEEL_CYCLE) % WHEEL_CYCLE;
    rows.push({ off, label: HOUR_LABELS[real] });
  }
  return (
    <div ref={wheelAreaRef} style={{ position: 'relative', userSelect: 'none', overflow: 'hidden', height: WHEEL_ITEM_H * WHEEL_VISIBLE }}>
      {rows.map(r => (
        <div
          key={r.off}
          onClick={() => setCenterIndex(centerIndex + r.off)}
          style={{
            position: 'absolute', left: 0, right: 0, top: (half + r.off) * WHEEL_ITEM_H, height: WHEEL_ITEM_H,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace',
            fontWeight: r.off === 0 ? 600 : 400, fontSize: r.off === 0 ? 15 : 13,
            color: r.off === 0 ? COL.text : COL.textDim, opacity: 1 - Math.abs(r.off) * 0.3,
            transition: 'opacity 100ms, color 100ms', cursor: r.off === 0 ? 'default' : 'pointer',
          }}
        >
          {r.label}
        </div>
      ))}
    </div>
  );
}
// computes a fixed, viewport-relative position for a popup anchored to a
// trigger element — prefers opening ABOVE the field, only falling back to
// below when there truly isn't room above. Fixed positioning + a portal to
// document.body means no ancestor's overflow:auto/hidden can clip it.
function usePopoverPosition(triggerRef: React.RefObject<HTMLElement>, open: boolean, width: number, estHeight: number, direction: 'above' | 'below' = 'above') {
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 });
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const gap = 8;
      let left = rect.left + rect.width / 2 - width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      if (direction === 'below') {
        setPos({ left, top: rect.bottom + gap, bottom: undefined });
        return;
      }
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openAbove = spaceAbove >= estHeight || spaceAbove >= spaceBelow;
      if (openAbove) setPos({ left, bottom: window.innerHeight - rect.top + gap, top: undefined });
      else setPos({ left, top: rect.bottom + gap, bottom: undefined });
    };
    update();
    window.addEventListener('resize', update);
    // capture phase so this also fires on scroll of the modal's inner
    // overflow:auto container, not just the window
    document.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, width, estHeight, direction]);
  return pos;
}
export default function UploadSchedulerNew({ value, onChange, minDate: minDateProp }: UploadSchedulerProps = {}) {
  const [liveNow, setLiveNow] = useState(() => new Date(Date.now() + 30 * 60 * 1000));
  useEffect(() => {
    if (minDateProp) return;
    const id = setInterval(() => setLiveNow(new Date(Date.now() + 30 * 60 * 1000)), 60000);
    return () => clearInterval(id);
  }, [minDateProp]);
  const minDate = minDateProp ?? liveNow;
  const [date, setDate] = useState<Date>(() => {
    if (value) return new Date(value);
    const d = new Date(minDate);
    const remainder = d.getMinutes() % 15;
    if (remainder !== 0 || d.getSeconds() !== 0 || d.getMilliseconds() !== 0) {
      d.setMinutes(d.getMinutes() + (15 - remainder), 0, 0);
    }
    return d;
  });
  useEffect(() => {
    if (value) setDate(new Date(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.getTime()]);
  const [editing, setEditing] = useState<{ field: FieldName | null; buffer: string }>({ field: null, buffer: '' });
  const [activeField, setActiveField] = useState<FieldName | null>(null);
  const [openPopup, setOpenPopup] = useState<'date' | 'time' | null>(null);
  const [viewIndex, setViewIndex] = useState(0);
  const [flash, setFlash] = useState(false);
  const [navHover, setNavHover] = useState<'prev' | 'next' | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const monthRefs = useRef<(HTMLDivElement | null)[]>([]);
  const dateGroupRef = useRef<HTMLDivElement | null>(null);
  const timeGroupRef = useRef<HTMLDivElement | null>(null);
  const datePopupRef = useRef<HTMLDivElement | null>(null);
  const timePopupRef = useRef<HTMLDivElement | null>(null);
  const flashTimeout = useRef<ReturnType<typeof setTimeout>>();
  const refs: Record<FieldName, React.RefObject<HTMLButtonElement>> = {
    day: useRef(null), month: useRef(null), year: useRef(null), hour: useRef(null), minute: useRef(null),
  };
  // Close popup on any click outside the popup itself (and outside the
  // date/time trigger groups so re-clicking a field still works).
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node;
      if (datePopupRef.current?.contains(t)) return;
      if (timePopupRef.current?.contains(t)) return;
      if (dateGroupRef.current?.contains(t)) return;
      if (timeGroupRef.current?.contains(t)) return;
      setOpenPopup(null);
    }
    document.addEventListener('mousedown', onClickOutside, true);
    return () => document.removeEventListener('mousedown', onClickOutside, true);
  }, []);
  const triggerFlash = useCallback(() => {
    setFlash(true);
    clearTimeout(flashTimeout.current);
    flashTimeout.current = setTimeout(() => setFlash(false), 350);
  }, []);
  // Keep the time the user chose whenever possible. If the chosen calendar
  // day falls before the minimum day, move only the Y/M/D to the minimum day
  // first. The time is clamped to minDate only when that preserved time is
  // still too early (for example, choosing today at 09:00 when min is 11:30).
  const clampToMin = useCallback((input: Date, min: Date) => {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) {
      triggerFlash();
      return new Date(min.getTime());
    }
    if (d.getTime() >= min.getTime()) return d;

    const preservedTimeOnMinDay = new Date(
      min.getFullYear(), min.getMonth(), min.getDate(),
      d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(),
    );
    triggerFlash();
    return preservedTimeOnMinDay.getTime() >= min.getTime()
      ? preservedTimeOnMinDay
      : new Date(min.getTime());
  }, [triggerFlash]);
  const commitDate = useCallback((d: Date) => { setDate(d); onChange?.(d); }, [onChange]);
  const changeField = useCallback((field: FieldName, dir: number) => {
    setDate(prev => {
      let d = new Date(prev);
      if (field === 'day') d.setDate(d.getDate() + dir);
      else if (field === 'month') {
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + dir);
        d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
      } else if (field === 'year') d.setFullYear(d.getFullYear() + dir);
      else if (field === 'hour') {
        // wrap 0–23, never change the day
        const h = (d.getHours() + dir + 24) % 24;
        d.setHours(h);
      } else if (field === 'minute') {
        // snap to nearest quarter, then step ±15, wrap 0–45, never change the hour
        let m = Math.round(d.getMinutes() / 15) * 15 % 60;
        m = (m + dir * 15 + 60) % 60;
        d.setMinutes(m);
      }
      const clamped = clampToMin(d, minDate);
      onChange?.(clamped);
      return clamped;
    });
  }, [minDate, clampToMin, onChange]);
  const commitTyped = useCallback((field: FieldName, buf: string) => {
    const n = parseInt(buf, 10);
    if (Number.isNaN(n)) return;
    setDate(prev => {
      let d = new Date(prev);
      if (field === 'day') d.setDate(Math.min(Math.max(n, 1), daysInMonth(d.getFullYear(), d.getMonth())));
      else if (field === 'month') {
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(Math.min(Math.max(n, 1), 12) - 1);
        d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
      } else if (field === 'year') d.setFullYear(Math.max(n, minDate.getFullYear()));
      else if (field === 'hour') {
        const h12 = Math.min(Math.max(n, 1), 12);
        const isPM = d.getHours() >= 12;
        d.setHours((h12 % 12) + (isPM ? 12 : 0));
      } else if (field === 'minute') {
        // snap typed value to nearest quarter-hour
        const snapped = Math.round(Math.min(Math.max(n, 0), 59) / 15) * 15 % 60;
        d.setMinutes(snapped);
      }
      const clamped = clampToMin(d, minDate);
      onChange?.(clamped);
      return clamped;
    });
  }, [minDate, clampToMin, onChange]);
  const focusNext = useCallback((field: FieldName) => {
    const next = FIELD_ORDER[FIELD_ORDER.indexOf(field) + 1];
    if (next && refs[next].current) refs[next].current!.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleKeyDown = useCallback((e: React.KeyboardEvent, field: FieldName, maxLen: number) => {
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      setEditing(prev => {
        const buf = (prev.field === field ? prev.buffer : '') + e.key;
        if (buf.length >= maxLen) {
          commitTyped(field, buf);
          setTimeout(() => focusNext(field), 0);
          return { field: null, buffer: '' };
        }
        return { field, buffer: buf };
      });
    } else if (e.key === 'ArrowUp') { e.preventDefault(); changeField(field, 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); changeField(field, -1); }
    else if (e.key === 'Backspace') { e.preventDefault(); setEditing(prev => (prev.field === field ? { field, buffer: prev.buffer.slice(0, -1) } : prev)); }
    else if (e.key === 'Enter' || e.key === 'Tab') {
      setEditing(prev => { if (prev.field === field && prev.buffer) commitTyped(field, prev.buffer); return { field: null, buffer: '' }; });
    }
  }, [changeField, commitTyped, focusNext]);
  const monthList = useMemo(() => {
    const count = Math.max(8, diffMonths(minDate, date) + 3);
    const list: { year: number; month: number }[] = [];
    let y = minDate.getFullYear(), m = minDate.getMonth();
    for (let i = 0; i < count; i++) {
      list.push({ year: y, month: m });
      m += 1; if (m > 11) { m = 0; y += 1; }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minDate.getFullYear(), minDate.getMonth(), date.getFullYear(), date.getMonth()]);
  const scrollToIndex = (idx: number) => {
    const el = monthRefs.current[idx];
    if (el && scrollAreaRef.current) scrollAreaRef.current.scrollTo({ top: el.offsetTop - 4, behavior: 'smooth' });
  };
  const openDatePopup = () => {
    const idx = Math.max(0, diffMonths(minDate, date));
    setOpenPopup('date'); setViewIndex(idx);
    setTimeout(() => scrollToIndex(idx), 0);
  };
  const openTimePopup = () => setOpenPopup('time');
  const dateSegmentProps = (field: FieldName, maxLen: number) => ({
    ref: refs[field], tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => handleKeyDown(e, field, maxLen),
    onClick: openDatePopup,
    onFocus: () => { setActiveField(field); openDatePopup(); },
    onBlur: () => {
      setEditing(prev => { if (prev.field === field && prev.buffer) commitTyped(field, prev.buffer); return { field: null, buffer: '' }; });
      setActiveField(a => (a === field ? null : a));
    },
  });
  const timeSegmentProps = (field: FieldName, maxLen: number) => ({
    ref: refs[field], tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => handleKeyDown(e, field, maxLen),
    onClick: openTimePopup,
    onFocus: () => { setActiveField(field); openTimePopup(); },
    onBlur: () => {
      setEditing(prev => { if (prev.field === field && prev.buffer) commitTyped(field, prev.buffer); return { field: null, buffer: '' }; });
      setActiveField(a => (a === field ? null : a));
    },
  });
  // Real non-passive listeners so scrolling over a field never leaks out to
  // the modal/page behind it — one per adjustable segment (year has none,
  // matching the original behavior).
  const wheelDay = useCallback((e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); changeField('day', e.deltaY < 0 ? 1 : -1); }, [changeField]);
  const wheelMonth = useCallback((e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); changeField('month', e.deltaY < 0 ? 1 : -1); }, [changeField]);
  const wheelHour = useCallback((e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); changeField('hour', e.deltaY < 0 ? 1 : -1); }, [changeField]);
  const wheelMinute = useCallback((e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); changeField('minute', e.deltaY < 0 ? 1 : -1); }, [changeField]);
  useNonPassiveWheel(refs.day, wheelDay);
  useNonPassiveWheel(refs.month, wheelMonth);
  useNonPassiveWheel(refs.hour, wheelHour);
  useNonPassiveWheel(refs.minute, wheelMinute);
  const hour24 = date.getHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const display = (field: FieldName, fallback: string) => (editing.field === field ? editing.buffer : fallback);
  const toggleMeridiem = () => changeField('hour', hour24 < 12 ? 12 : -12);
  const handleWheelSelect = (h12: number, m: number) => {
    setDate(prev => {
      const d = new Date(prev);
      const isPM = d.getHours() >= 12;
      d.setHours((h12 % 12) + (isPM ? 12 : 0));
      d.setMinutes(m);
      const clamped = clampToMin(d, minDate);
      onChange?.(clamped);
      return clamped;
    });
  };
  const todayOnly = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
  const pickDay = (year: number, month: number, day: number) => {
    const d = new Date(date);
    d.setFullYear(year); d.setMonth(month); d.setDate(day);
    commitDate(clampToMin(d, minDate));
    setOpenPopup(null);
  };
  const prevMonth = () => { if (viewIndex > 0) { setViewIndex(viewIndex - 1); scrollToIndex(viewIndex - 1); } };
  const nextMonth = () => { if (viewIndex < monthList.length - 1) { setViewIndex(viewIndex + 1); scrollToIndex(viewIndex + 1); } };
  const summary = `Se sube el ${date.getDate()} de ${MESES[date.getMonth()]} de ${date.getFullYear()} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const headerDateText = `${date.getDate()} ${MESES_CORTOS[date.getMonth()].toLowerCase()} ${date.getFullYear()}`;
  const segStyle = (field: FieldName): React.CSSProperties => ({
    fontFamily: 'monospace', fontVariantNumeric: 'tabular-nums', fontSize: 18, textAlign: 'center',
    padding: '4px 0', borderRadius: 6, border: 'none', cursor: 'pointer', outline: 'none',
    background: activeField === field ? COL.active : 'transparent',
    color: COL.text,
    boxShadow: activeField === field ? `inset 0 0 0 1px ${COL.activeRing}` : 'none',
    transition: 'background 100ms, color 100ms',
  });
  monthRefs.current = [];
  const DATE_POPUP_W = 288;
  const DATE_POPUP_EST_H = 300;
  const TIME_POPUP_W = 88;
  const TIME_POPUP_EST_H = 190;
  const datePos = usePopoverPosition(dateGroupRef, openPopup === 'date', DATE_POPUP_W, DATE_POPUP_EST_H, 'above');
  const timePos = usePopoverPosition(timeGroupRef, openPopup === 'time', TIME_POPUP_W, TIME_POPUP_EST_H, 'below');
  return (
    <div style={{ display: 'flex', justifyContent: 'center', width: '100%' }}>
      <div
        ref={containerRef}
        style={{
          position: 'relative', background: COL.bg, border: `1px solid ${flash ? COL.borderFlash : COL.border}`,
          borderRadius: 16, padding: 20, transition: 'border-color 150ms',
          width: 'fit-content', color: COL.text,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* date group */}
          <div ref={dateGroupRef} style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button {...dateSegmentProps('day', 2)} style={{ ...segStyle('day'), width: 32 }}>{display('day', pad(date.getDate()))}</button>
              <span style={{ color: COL.textFaint }}>/</span>
              <button {...dateSegmentProps('month', 2)} style={{ ...segStyle('month'), width: 32 }}>{display('month', pad(date.getMonth() + 1))}</button>
              <span style={{ color: COL.textFaint }}>/</span>
              <button {...dateSegmentProps('year', 4)} style={{ ...segStyle('year'), width: 56 }}>{display('year', String(date.getFullYear()))}</button>
            </div>
            {openPopup === 'date' && createPortal(
              <div ref={datePopupRef} style={{
                position: 'fixed', left: datePos.left, top: datePos.top, bottom: datePos.bottom, width: DATE_POPUP_W, background: COL.bg,
                border: `1px solid ${COL.border}`, borderRadius: 12, boxShadow: '0 20px 40px rgba(0,0,0,0.5)', padding: 12, zIndex: 1000,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 14, color: COL.text }}>{headerDateText}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button" onClick={prevMonth} disabled={viewIndex <= 0}
                      onMouseEnter={() => setNavHover('prev')} onMouseLeave={() => setNavHover(null)}
                      style={{
                        width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        borderRadius: 6, border: 'none', background: navHover === 'prev' && viewIndex > 0 ? COL.hover : 'transparent',
                        color: viewIndex <= 0 ? COL.textFaint : COL.text, cursor: viewIndex <= 0 ? 'default' : 'pointer',
                      }}
                    >‹</button>
                    <button
                      type="button" onClick={nextMonth}
                      onMouseEnter={() => setNavHover('next')} onMouseLeave={() => setNavHover(null)}
                      style={{
                        width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        borderRadius: 6, border: 'none', background: navHover === 'next' ? COL.hover : 'transparent',
                        color: COL.text, cursor: 'pointer',
                      }}
                    >›</button>
                  </div>
                </div>
                <div ref={scrollAreaRef} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', rowGap: 4, maxHeight: 256, overflowY: 'auto' }}>
                  {DIAS_SEMANA.map((d, i) => (
                    <div key={`wd-${i}`} style={{ position: 'sticky', top: 0, background: COL.bg, textAlign: 'center', fontSize: 10, color: COL.textDim, fontFamily: 'monospace', padding: '4px 0', zIndex: 10 }}>
                      {d}
                    </div>
                  ))}
                  {monthList.map((mo, mi) => {
                    const offset = mondayFirstWeekday(mo.year, mo.month, 1);
                    const total = daysInMonth(mo.year, mo.month);
                    const cells: (number | null)[] = [...Array(offset).fill(null), ...Array.from({ length: total }, (_, i) => i + 1)];
                    return (
                      <React.Fragment key={`${mo.year}-${mo.month}`}>
                        {mi > 0 && (
                          <div
                            ref={(el) => { monthRefs.current[mi] = el; }}
                            style={{ gridColumn: '1 / -1', fontSize: 11, fontWeight: 600, color: COL.textDim, padding: '8px 0 4px' }}
                          >
                            {MESES_CORTOS[mo.month].toUpperCase()} {mo.year}
                          </div>
                        )}
                        {mi === 0 && <div ref={(el) => { monthRefs.current[0] = el; }} style={{ gridColumn: '1 / -1', height: 0 }} />}
                        {cells.map((day, ci) => {
                          if (day === null) return <div key={ci} />;
                          const cellDate = new Date(mo.year, mo.month, day);
                          const disabled = cellDate < todayOnly;
                          const isToday = sameDate(cellDate, todayOnly);
                          const isSelected = sameDate(cellDate, date);
                          return (
                            <button
                              key={ci} type="button" disabled={disabled} onClick={() => pickDay(mo.year, mo.month, day)}
                              style={{
                                fontSize: 12, fontFamily: 'monospace', padding: '6px 0', borderRadius: 6, border: 'none',
                                background: isSelected ? COL.selectedBg : 'transparent',
                                color: disabled ? COL.textFaint : isSelected ? COL.selectedText : COL.text,
                                boxShadow: isToday && !isSelected ? `inset 0 0 0 1px ${COL.border}` : 'none',
                                cursor: disabled ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {day}
                            </button>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>,
              document.body
            )}
          </div>
          {/* time group */}
          <div ref={timeGroupRef} style={{ position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <button {...timeSegmentProps('hour', 2)} style={{ ...segStyle('hour'), width: 32 }}>{display('hour', pad(hour12))}</button>
              <span style={{ color: COL.textFaint }}>:</span>
              <button {...timeSegmentProps('minute', 2)} style={{ ...segStyle('minute'), width: 32 }}>{display('minute', pad(date.getMinutes()))}</button>
              <button
                type="button" onClick={toggleMeridiem}
                style={{ marginLeft: 4, fontSize: 12, fontFamily: 'monospace', padding: '6px 6px', borderRadius: 6, border: 'none', background: '#1c1c1c', color: COL.text, cursor: 'pointer' }}
              >
                {meridiem}
              </button>
            </div>
            {openPopup === 'time' && createPortal(
              <div ref={timePopupRef} style={{
                position: 'fixed', left: timePos.left, top: timePos.top, bottom: timePos.bottom, width: TIME_POPUP_W,
                background: COL.bg, border: `1px solid ${COL.border}`, borderRadius: 12, boxShadow: '0 20px 40px rgba(0,0,0,0.5)', padding: '8px 4px', zIndex: 1000,
              }}>
                <HourWheel hour12={hour12} minute={date.getMinutes()} onSelect={handleWheelSelect} />
              </div>,
              document.body
            )}
          </div>
        </div>
        <p style={{ marginTop: 12, fontSize: 12, color: COL.textDim, fontFamily: 'monospace', textAlign: 'center' }}>{summary}</p>
        <p style={{ marginTop: 4, fontSize: 10, color: COL.textFaint, textAlign: 'center' }}>scroll sobre un campo lo ajusta · clic lo abre · clic + números lo escribe</p>
      </div>
    </div>
  );
}