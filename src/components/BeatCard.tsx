import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import type { Beat } from "../types";
import { Artwork, TagPill, PulsingBars } from "./ui";
import playFillPng from "../assets/player-icons/play.fill.png";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface Props {
  beat: Beat;
  playing: boolean;
  selected: boolean;
  selectMode: boolean;
  onPlay: (beat: Beat) => void;
  onDetail: (beat: Beat) => void;
  onEdit: (beat: Beat) => void;
  onDelete: (beat: Beat) => void;
  onAddToQueue: (beat: Beat) => void;
  onToggleSelect: (beat: Beat, e: React.MouseEvent) => void;
  animDelay?: number;
  dragEnabled: boolean;
}

function ContextMenu({ x, y, onEdit, onDetail, onAddToQueue, onDelete, onReveal, onClose }: {
  x: number; y: number;
  onEdit: () => void; onDetail: () => void;
  onAddToQueue: () => void;
  onDelete: () => void; onReveal: () => void; onClose: () => void;
}) {
  React.useEffect(() => {
    const onAnyClick = () => onClose();
    const onAnyContext = () => onClose();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    setTimeout(() => window.addEventListener("click", onAnyClick), 10);
    // Use capture so we close before the new card opens its menu
    window.addEventListener("contextmenu", onAnyContext, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", onAnyClick);
      window.removeEventListener("contextmenu", onAnyContext, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return ReactDOM.createPortal(
    <div onClick={e => e.stopPropagation()} style={{ position: "fixed", top: y, left: x, zIndex: 9999, background: "#1c1c1c", border: "1px solid #2a2a2a", borderRadius: 8, padding: "4px 0", minWidth: 180, boxShadow: "0 8px 32px rgba(0,0,0,0.85)", fontFamily: "'DM Sans',sans-serif" }}>
      {([["Edit metadata", onEdit], ["View detail", onDetail], ["Add to queue", onAddToQueue], ["Reveal in Explorer", onReveal], ["Remove from library", onDelete, true]] as [string, () => void, boolean?][]).map(([label, fn, danger]) => (
        <div key={label} onClick={() => { fn(); onClose(); }}
          style={{ padding: "9px 16px", fontSize: 13, color: danger ? "#f87171" : "#c0c0c0", cursor: "pointer" }}
          onMouseEnter={e => (e.currentTarget.style.background = "#242424")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
          {label}
        </div>
      ))}
    </div>,
    document.body
  );
}

export default function BeatCard({
  beat, playing, selected, selectMode,
  onPlay, onDetail, onEdit, onDelete, onAddToQueue, onToggleSelect,
  animDelay = 0, dragEnabled
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const dotsRef = useRef<HTMLDivElement>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: beat.id, disabled: !dragEnabled });

  const sortableTransform = CSS.Transform.toString(transform);
  const liftTransform = isDragging ? "scale(0.985)" : hovered && !selectMode ? "translateY(-2px)" : "translateY(0)";
  const composedTransform = sortableTransform ? `${sortableTransform} ${liftTransform}` : liftTransform;

  useEffect(() => {
    if (!isDragging) return;
    const root = document.documentElement;
    const prev = root.style.cursor;
    root.style.cursor = "grabbing";
    return () => {
      root.style.cursor = prev;
    };
  }, [isDragging]);

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = dotsRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({ x: rect.right - 180, y: rect.bottom + 4 });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (selectMode) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      ref={setNodeRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={e => { if (selectMode) onToggleSelect(beat, e); }}
      onContextMenu={handleContextMenu}
      style={{
        width: 160, position: "relative",
        cursor: selectMode ? "pointer" : "default",
        animation: "fadeUp 0.36s cubic-bezier(0.22, 1, 0.36, 1)",
        animationDelay: `${animDelay}s`,
        borderRadius: 12,
        transform: composedTransform,
        opacity: isDragging ? 0.72 : 1,
        transition: transition || "transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.16s ease",
        userSelect: "none",
      }}
    >
      {/* Checkbox — only visible in select mode */}
      {selectMode && (
        <div
          onClick={e => { e.stopPropagation(); onToggleSelect(beat, e); }}
          style={{
            position: "absolute", top: 6, left: 6, zIndex: 10,
            width: 20, height: 20, borderRadius: "50%",
            background: selected ? "#fff" : "rgba(0,0,0,0.55)",
            border: `1.5px solid ${selected ? "#fff" : "rgba(255,255,255,0.35)"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", backdropFilter: "blur(6px)",
            transition: "background 0.12s, border-color 0.12s",
          }}
        >
          {selected && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M1.5 5L4 7.5L8.5 2.5" stroke="#000" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      )}

      {/* Artwork */}
      <div
        ref={setActivatorNodeRef}
        {...(dragEnabled ? attributes : {})}
        {...(dragEnabled ? listeners : {})}
        style={{
          position: "relative", cursor: dragEnabled ? "grab" : "pointer",
          touchAction: "none",
          opacity: selectMode && selected ? 0.7 : 1,
          transition: "opacity 0.15s",
          // Slight ring when selected
          borderRadius: 10,
          boxShadow: selected && selectMode ? "0 0 0 2.5px #fff" : "none",
        }}
        onClick={e => {
          if (isDragging) { e.preventDefault(); return; }
          if (selectMode) { e.stopPropagation(); onToggleSelect(beat, e); return; }
          e.stopPropagation(); onPlay(beat);
        }}
      >
        <Artwork beat={beat} size={160} playing={playing} />
        {beat.has_wav && !selectMode && (
          <div style={{
            position: "absolute", top: 6, right: 6, zIndex: 5,
            background: "rgba(0,0,0,0.72)", border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 4, padding: "2px 5px",
            fontSize: 9, fontWeight: 600, color: "#e0e0e0", letterSpacing: 0.8,
            backdropFilter: "blur(4px)",
          }}>HQ</div>
        )}
        {!selectMode && (
          <div style={{ position: "absolute", inset: 0, borderRadius: 10, background: "rgba(0,0,0,0.42)", display: "flex", alignItems: "center", justifyContent: "center", opacity: hovered && !playing ? 1 : 0, transition: "opacity 0.15s" }}>
            <img
              aria-hidden
              src={playFillPng}
              alt=""
              style={{
                width: 26,
                height: 26,
                display: "inline-block",
                objectFit: "contain",
                filter: "brightness(0) saturate(100%) invert(100%)",
                opacity: 0.92,
              }}
            />
          </div>
        )}
      </div>

      {/* Info */}
      <div style={{ marginTop: 9 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div
            onClick={e => { if (!selectMode) { e.stopPropagation(); onDetail(beat); } }}
            style={{ fontWeight: 500, fontSize: 13, color: "#e0e0e0", lineHeight: 1.3, cursor: "pointer", maxWidth: 128, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {beat.name}
          </div>
          {!selectMode && (
            <div ref={dotsRef} onClick={openMenu}
              style={{ width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4, cursor: "pointer", color: "#555", fontSize: 15, letterSpacing: 2, opacity: hovered || menu ? 1 : 0, transition: "opacity 0.15s", background: menu ? "#2a2a2a" : "transparent", flexShrink: 0 }}>
              ···
            </div>
          )}
        </div>
        {beat.rating > 0 && (
          <div style={{ display: "flex", gap: 2, marginTop: 4 }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <span key={i} style={{ fontSize: 8, lineHeight: 1, color: i <= beat.rating ? "#7a7a7a" : "#2b2b2b" }}>★</span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {beat.tags.slice(0, 3).map(t => <TagPill key={t} label={t} />)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
          <span style={{ fontSize: 11, color: "#3a3a3a", fontWeight: 300 }}>
            {beat.bpm}{beat.bpm && beat.key ? " · " : ""}{beat.key}
          </span>
          {playing && <PulsingBars color="#f59e0b" />}
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y}
          onEdit={() => onEdit(beat)} onDetail={() => onDetail(beat)} onAddToQueue={() => onAddToQueue(beat)} onDelete={() => onDelete(beat)}
          onReveal={() => import("../lib/tauri").then(t => t.revealInExplorer(beat.folder_path))}
          onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
