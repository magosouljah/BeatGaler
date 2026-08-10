import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import type { Beat } from "../types";
import { Artwork, TagPill, PulsingBars } from "./ui";
import playFillPng from "../assets/player-icons/play.fill.png";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTagColors } from "../lib/tagColors";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "./AccountGate";

function remoteImageUrlFromDrop(dataTransfer: DataTransfer): string | null {
  const normalizeCandidate = (raw: string | null | undefined): string | null => {
    const value = String(raw || "").trim().replace(/^["']|["']$/g, "");
    if (!value) return null;
    if (/^data:image\//i.test(value)) return value;
    if (!/^https?:\/\//i.test(value)) return null;

    // Search engines often drag a result-page URL that contains the real image
    // in imgurl/mediaurl/url. Prefer that embedded URL when present.
    try {
      const parsed = new URL(value);
      for (const key of ["imgurl", "mediaurl", "image_url", "imageurl"]) {
        const nested = parsed.searchParams.get(key);
        if (nested && /^https?:\/\//i.test(nested)) return nested;
      }
    } catch {}
    return value;
  };

  const html = dataTransfer.getData("text/html");
  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const img = doc.querySelector("img");
      if (img) {
        const attrs = [
          img.getAttribute("src"),
          img.getAttribute("data-src"),
          img.getAttribute("data-original"),
          img.getAttribute("data-lazy-src"),
        ];
        const srcset = img.getAttribute("srcset");
        if (srcset) {
          for (const entry of srcset.split(",")) {
            attrs.push(entry.trim().split(/\s+/)[0] || null);
          }
        }
        for (const raw of attrs) {
          const candidate = normalizeCandidate(raw);
          if (candidate) return candidate;
        }
      }

      // Some image-search pages put the original image URL on the wrapping link.
      for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
        const candidate = normalizeCandidate(anchor.getAttribute("href"));
        if (candidate) return candidate;
      }
    } catch {}
  }

  const downloadUrl = dataTransfer.getData("DownloadURL");
  if (downloadUrl) {
    // Chrome format: mime:type:URL. URLs themselves contain ":" so only strip
    // the first two fields.
    const first = downloadUrl.indexOf(":");
    const second = first >= 0 ? downloadUrl.indexOf(":", first + 1) : -1;
    const raw = second >= 0 ? downloadUrl.slice(second + 1) : downloadUrl;
    const candidate = normalizeCandidate(raw);
    if (candidate) return candidate;
  }

  for (const type of ["text/uri-list", "text/plain"]) {
    const raw = dataTransfer.getData(type);
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const candidate = normalizeCandidate(line);
      if (candidate) return candidate;
    }
  }
  return null;
}

function dragLooksLikeInternetImage(dataTransfer: DataTransfer): boolean {
  const types = Array.from(dataTransfer.types || []);
  return types.includes("DownloadURL") || types.includes("text/html") || types.includes("text/uri-list");
}

async function downloadInternetArtwork(url: string): Promise<string> {
  const base = getResolvedCloudApiBase();
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("BeatGaler session expired. Sign in again.");
  const response = await fetch(`${base}/image/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ url }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.data_url) {
    throw new Error(body?.error || `Could not download internet image (HTTP ${response.status}).`);
  }
  return String(body.data_url);
}

interface Props {
  beat: Beat;
  tagFrequency: ReadonlyMap<string, number>;
  showIncompleteWarnings: boolean;
  playing: boolean;
  selected: boolean;
  selectedCount: number;
  selectMode: boolean;
  onPlay: (beat: Beat) => void;
  onDetail: (beat: Beat) => void;
  onEdit: (beat: Beat) => void;
  onDelete: (beat: Beat) => void;
  onAddToQueue: (beat: Beat) => void;
  onUpload: (beat: Beat) => void;
  onBulkEdit: () => void;
  onBulkUpload: () => void;
  onBulkDelete: () => void;
  onToggleSelect: (beat: Beat, e: React.MouseEvent) => void;
  onDropArtwork: (beat: Beat, imageBase64: string) => void;
  animDelay?: number;
  dragEnabled: boolean;
}

function ContextMenu({ x, y, onEdit, onDetail, onAddToQueue, onDelete, onReveal, onUpload, onOpenProject, onClose }: {
  x: number; y: number;
  onEdit: () => void; onDetail: () => void;
  onAddToQueue: () => void;
  onDelete: () => void; onReveal: () => void;
  onUpload: () => void;
  onOpenProject: (() => void) | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const onAnyClick = () => onClose();
    const onAnyContext = () => onClose();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Fired by any card right before it opens ITS menu — guarantees only
    // one context menu is ever open at a time, even though the opening
    // click itself stops propagation (so it never reaches the window
    // "click" listener above).
    window.addEventListener("beatcard:close-menus", onClose);
    setTimeout(() => window.addEventListener("click", onAnyClick), 10);
    // Use capture so we close before the new card opens its menu
    window.addEventListener("contextmenu", onAnyContext, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("beatcard:close-menus", onClose);
      window.removeEventListener("click", onAnyClick);
      window.removeEventListener("contextmenu", onAnyContext, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return ReactDOM.createPortal(
    <div onClick={e => e.stopPropagation()} style={{ position: "fixed", top: y, left: x, zIndex: 9999, background: "#1c1c1c", border: "1px solid #2a2a2a", borderRadius: 8, padding: "4px 0", minWidth: 180, boxShadow: "0 8px 32px rgba(0,0,0,0.85)", fontFamily: "'DM Sans',sans-serif" }}>
      {([
        ["Upload to YouTube", onUpload],
        ...(onOpenProject ? [["Open project", onOpenProject] as [string, () => void]] : []),
        ["Edit metadata", onEdit],
        ["View detail", onDetail],
        ["Add to queue", onAddToQueue],
        ["Reveal in Explorer", onReveal],
        ["Remove from library", onDelete, true],
      ] as [string, () => void, boolean?][]).map(([label, fn, danger]) => (
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

function BulkContextMenu({ x, y, onEditAll, onUploadBulk, onRemoveAll, onClose }: {
  x: number;
  y: number;
  onEditAll: () => void;
  onUploadBulk: () => void;
  onRemoveAll: () => void;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const close = () => onClose();
    const keydown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("beatcard:close-menus", onClose);
    setTimeout(() => window.addEventListener("click", close), 10);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("beatcard:close-menus", onClose);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("keydown", keydown);
    };
  }, [onClose]);

  const items: [string, () => void, boolean?][] = [
    ["Edit all", onEditAll],
    ["Upload to YouTube (bulk)", onUploadBulk],
    ["Remove all", onRemoveAll, true],
  ];

  return ReactDOM.createPortal(
    <div onClick={e => e.stopPropagation()} style={{ position: "fixed", top: y, left: x, zIndex: 9999, background: "#1c1c1c", border: "1px solid #2a2a2a", borderRadius: 8, padding: "4px 0", minWidth: 205, boxShadow: "0 8px 32px rgba(0,0,0,0.85)", fontFamily: "'DM Sans',sans-serif" }}>
      {items.map(([label, fn, danger]) => (
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
  beat, tagFrequency, showIncompleteWarnings, playing, selected, selectedCount, selectMode,
  onPlay, onDetail, onEdit, onDelete, onAddToQueue, onUpload,
  onBulkEdit, onBulkUpload, onBulkDelete, onToggleSelect, onDropArtwork,
  animDelay = 0, dragEnabled
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [warningInfoOpen, setWarningInfoOpen] = useState(false);
  const dotsRef = useRef<HTMLDivElement>(null);
  const tagColors = useTagColors();

  useEffect(() => {
    const onArtworkDrag = (event: Event) => {
      const detail = (event as CustomEvent<{ beatId: string | null; active: boolean }>).detail;
      const active = Boolean(detail?.active && detail?.beatId === beat.id);
      setImageDragOver(active);
      if (active) setFileDragOver(false);
    };
    const onFileDrag = (event: Event) => {
      const detail = (event as CustomEvent<{ beatId: string | null; active: boolean }>).detail;
      const active = Boolean(detail?.active && detail?.beatId === beat.id);
      setFileDragOver(active);
      if (active) setImageDragOver(false);
    };
    window.addEventListener("beatgaler:artwork-drag", onArtworkDrag);
    window.addEventListener("beatgaler:beat-update-drag", onFileDrag);
    return () => {
      window.removeEventListener("beatgaler:artwork-drag", onArtworkDrag);
      window.removeEventListener("beatgaler:beat-update-drag", onFileDrag);
    };
  }, [beat.id]);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: beat.id, disabled: !dragEnabled });

  const incompleteReasons = useMemo(() => {
    const reasons: string[] = [];
    if (!beat.has_flp && !beat.has_als) reasons.push("No project file was found (.flp or .als).");
    if (!beat.has_samples) reasons.push("No Samples folder was found.");
    return reasons;
  }, [beat.has_flp, beat.has_als, beat.has_samples]);
  const showIncompleteWarning = showIncompleteWarnings && incompleteReasons.length > 0;

  // Ignore the tag order stored in ID3 metadata. Sort a display-only copy by
  // global usage (most used first), then alphabetically for stable ties.
  const sortedTags = useMemo(() => {
    const uniqueByNormalized = new Map<string, string>();
    for (const rawTag of beat.tags) {
      const normalized = rawTag.trim().toLowerCase();
      if (normalized && !uniqueByNormalized.has(normalized)) {
        uniqueByNormalized.set(normalized, rawTag.trim());
      }
    }
    return [...uniqueByNormalized.entries()]
      .sort(([a], [b]) =>
        (tagFrequency.get(b) ?? 0) - (tagFrequency.get(a) ?? 0) || a.localeCompare(b)
      )
      .map(([, display]) => display);
  }, [beat.tags, tagFrequency]);

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
    window.dispatchEvent(new Event("beatcard:close-menus"));
    const rect = dotsRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({ x: rect.right - 180, y: rect.bottom + 4 });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (selectMode) {
      // Only open the bulk menu when right-clicking one of multiple selected cards.
      if (!selected || selectedCount <= 1) return;
    }
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new Event("beatcard:close-menus"));
    setMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      ref={setNodeRef}
      data-beat-card-id={beat.id}
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
        outline: fileDragOver ? "2px solid #f5b942" : "none",
        outlineOffset: fileDragOver ? "4px" : "0px",
        transition: transition || "transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.16s ease",
        userSelect: "none",
          // Red border when beat needs resolution — applied to artwork instead. Outer container keeps compact layout.
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
        data-beat-artwork-id={beat.id}
        {...(dragEnabled ? attributes : {})}
        {...(dragEnabled ? listeners : {})}
        style={{
          position: "relative", cursor: dragEnabled ? "grab" : "pointer",
          touchAction: "none",
          opacity: selectMode && selected ? 0.7 : 1,
          transition: "opacity 0.15s, box-shadow 0.15s",
          // Slight ring when selected, dashed ring while dragging an image over it
          borderRadius: 10,
          boxShadow: imageDragOver
            ? "0 0 0 2.5px #4ade80"
            : selected && selectMode ? "0 0 0 2.5px #fff" : "none",
        }}
        onClick={e => {
          if (isDragging) { e.preventDefault(); return; }
          if (selectMode) { e.stopPropagation(); onToggleSelect(beat, e); return; }
          e.stopPropagation(); onPlay(beat);
        }}
        onDragOver={e => {
          const files = Array.from(e.dataTransfer.files || []);
          const items = Array.from(e.dataTransfer.items || []);
          const hasImageFile = files.some(file => file.type.startsWith("image/")) ||
            items.some(item => item.kind === "file" && item.type.startsWith("image/"));
          const internetImage = dragLooksLikeInternetImage(e.dataTransfer);
          const hasFiles = e.dataTransfer.types.includes("Files") || items.some(item => item.kind === "file");

          if (hasImageFile || internetImage) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setImageDragOver(true);
            setFileDragOver(false);
            return;
          }

          if (hasFiles) {
            // Non-image files are beat-file updates, not artwork. Keep them
            // yellow so they cannot be confused with the green cover target.
            setImageDragOver(false);
            setFileDragOver(true);
          }
        }}
        onDragLeave={() => { setImageDragOver(false); setFileDragOver(false); }}
        onDrop={e => {
          const file = Array.from(e.dataTransfer.files || []).find(f => f.type.startsWith("image/"));
          const remoteUrl = remoteImageUrlFromDrop(e.dataTransfer);
          if (!file && !remoteUrl) return;

          e.preventDefault();
          e.stopPropagation();
          setImageDragOver(false);
          setFileDragOver(false);

          if (file) {
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === "string") onDropArtwork(beat, reader.result);
            };
            reader.readAsDataURL(file);
            return;
          }

          if (remoteUrl) {
            if (/^data:image\//i.test(remoteUrl)) {
              onDropArtwork(beat, remoteUrl);
              return;
            }
            void downloadInternetArtwork(remoteUrl)
              .then(imageData => onDropArtwork(beat, imageData))
              .catch(error => console.error("Failed to set artwork from internet image:", error));
          }
        }}
      >
        <div style={{ borderRadius: 10, overflow: "hidden", position: "relative", display: "inline-block",
                      boxShadow: showIncompleteWarning ? "0 0 0 4px rgba(245,158,11,0.28)" : undefined }}>
          <Artwork beat={beat} size={160} playing={playing} />
        </div>
        {showIncompleteWarning && hovered && !selectMode && (
          <div
            onClick={e => e.stopPropagation()}
            onMouseEnter={() => setWarningInfoOpen(true)}
            onMouseLeave={() => setWarningInfoOpen(false)}
            aria-label="Why this beat is highlighted"
            style={{
              position: "absolute", top: 7, right: 7, zIndex: 30,
              width: 21, height: 21, borderRadius: "50%",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(15,15,15,0.9)", border: "1px solid rgba(245,158,11,0.75)",
              color: "#f5a623", fontSize: 12, fontWeight: 700,
              cursor: "help", boxShadow: "0 2px 8px rgba(0,0,0,0.55)",
            }}
          >
            i
            {warningInfoOpen && (
              <div style={{
                position: "absolute", top: 27, right: 0, width: 245, zIndex: 50,
                padding: "11px 12px", borderRadius: 9,
                background: "#171717", border: "1px solid #34302a",
                boxShadow: "0 12px 34px rgba(0,0,0,0.75)",
                color: "#bbb", fontSize: 11, lineHeight: 1.55,
                fontWeight: 400, textAlign: "left", pointerEvents: "none",
              }}>
                <div style={{ color: "#e8e8e8", fontWeight: 600, marginBottom: 6 }}>Incomplete beat files</div>
                {incompleteReasons.map(reason => (
                  <div key={reason} style={{ display: "flex", gap: 7, marginTop: 3 }}>
                    <span style={{ color: "#f5a623" }}>•</span><span>{reason}</span>
                  </div>
                ))}
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #292929", color: "#777" }}>
                  You can turn off these yellow warnings in Settings → Preferences.
                </div>
              </div>
            )}
          </div>
        )}
        {fileDragOver && !imageDragOver && (
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10, background: "rgba(245,185,66,0.16)",
            border: "2px dashed #f5b942", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 600, color: "#fff", textAlign: "center", padding: 8,
            pointerEvents: "none", zIndex: 40,
          }}>
            Drop file
          </div>
        )}
        {imageDragOver && (
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10, background: "rgba(74,222,128,0.18)",
            border: "2px dashed #4ade80", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 600, color: "#fff", textAlign: "center", padding: 8,
            pointerEvents: "none", zIndex: 41,
          }}>
            Drop image
          </div>
        )}
        {beat.needs_resolution && (
          <div onClick={(e) => { e.stopPropagation(); onEdit(beat); }}
            title="Conflicto — editar metadata"
            style={{ position: "absolute", left: 8, top: 8, zIndex: 20, width: 20, height: 20, borderRadius: 6, background: "#f87171", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, cursor: "pointer", boxShadow: "0 2px 6px rgba(0,0,0,0.5)" }}>
            <span style={{ lineHeight: 1 }}>?{/* simple question mark */}</span>
          </div>
        )}
        {beat.has_wav && !selectMode && (
          <div style={{
            position: "absolute", top: showIncompleteWarning && hovered ? 34 : 6, right: 6, zIndex: 5,
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
          {sortedTags.slice(0, 3).map(t => <TagPill key={t} label={t} />)}
          {sortedTags.slice(3).map(t => {
            const color = tagColors[t.trim().toLowerCase()];
            if (!color) return null;
            return (
              <span
                key={`tag-dot-${t}`}
                title={t}
                aria-label={t}
                style={{
                  width: 7, height: 7, borderRadius: "50%", background: color,
                  display: "inline-block", alignSelf: "center", flexShrink: 0,
                }}
              />
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
          <span style={{ fontSize: 11, color: "#3a3a3a", fontWeight: 300 }}>
            {beat.bpm}{beat.bpm && beat.key ? " · " : ""}{beat.key}
          </span>
          {playing && <PulsingBars color="#f59e0b" />}
        </div>
      </div>

      {menu && selectMode && selected && selectedCount > 1 ? (
        <BulkContextMenu
          x={menu.x}
          y={menu.y}
          onEditAll={onBulkEdit}
          onUploadBulk={onBulkUpload}
          onRemoveAll={onBulkDelete}
          onClose={() => setMenu(null)}
        />
      ) : menu ? (
        <ContextMenu x={menu.x} y={menu.y}
          onEdit={() => onEdit(beat)} onDetail={() => onDetail(beat)} onAddToQueue={() => onAddToQueue(beat)} onDelete={() => onDelete(beat)}
          onReveal={() => import("../lib/tauri").then(t => t.revealInExplorer(beat.folder_path))}
          onUpload={() => onUpload(beat)}
          onOpenProject={
            (beat.flp_path || beat.als_path)
              ? () => import("../lib/tauri").then(t => t.openProjectFile((beat.flp_path || beat.als_path)!))
              : null
          }
          onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
