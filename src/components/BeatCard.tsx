import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import type { Beat } from "../types";
import { Artwork, TagPill, PulsingBars } from "./ui";
import playFillPng from "../assets/player-icons/play.fill.png";
import uploadStatusSymbolPng from "../assets/upload-status/upload-symbol.png";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useTagColors } from "../lib/tagColors";
import { getProjectCloudStatus, type ProjectCloudStatus } from "../lib/tauri";

const uploadAnimationStyles = `
  @keyframes beatgaler-upload-spin {
    from { transform: rotate(0deg) scale(1); }
    to { transform: rotate(360deg) scale(1); }
  }
  @keyframes beatgaler-upload-success {
    0% { transform: translateY(0) scale(1) rotate(0deg); opacity: 1; }
    28% { transform: translateY(-3px) scale(1.08) rotate(8deg); opacity: 1; }
    100% { transform: translateY(34px) scale(0.82) rotate(20deg); opacity: 0; }
  }
  @keyframes beatgaler-upload-glow {
    0% { opacity: 0; }
    25% { opacity: .52; }
    100% { opacity: 0; }
  }
`;

interface Props {
  beat: Beat;
  cloudUploadErrorDetail?: string;
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
  onUploadTelegram: (beat: Beat) => void;
  onDownloadTelegram: (beat: Beat) => void;
  onUploadProjectTelegram: (beat: Beat) => void;
  onOpenProject: (beat: Beat) => void;
  onUpdateProject: (beat: Beat) => void;
  onCloudFiles: (beat: Beat) => void;
  onBulkEdit: () => void;
  onBulkUpload: () => void;
  onBulkDelete: () => void;
  onToggleSelect: (beat: Beat, e: React.MouseEvent) => void;
  onDropArtwork: (beat: Beat, imageBase64: string) => void;
  animDelay?: number;
  dragEnabled: boolean;
}

function ContextMenu({ x, y, onEdit, onDetail, onAddToQueue, onDelete, onReveal, onUpload, onUploadTelegram, onDownloadTelegram, onUploadProjectTelegram, telegramSynced, projectCloudState, canOpenProject, onOpenProject, onUpdateProject, onCloudFiles, onClose }: {
  x: number; y: number;
  onEdit: () => void; onDetail: () => void;
  onAddToQueue: () => void;
  onDelete: () => void; onReveal: () => void;
  onUpload: () => void;
  onUploadTelegram: () => void;
  onDownloadTelegram: () => void;
  onUploadProjectTelegram: () => void;
  telegramSynced: boolean;
  projectCloudState: ProjectCloudStatus["state"] | null;
  canOpenProject: boolean;
  onOpenProject: () => void;
  onUpdateProject: () => void;
  onCloudFiles: () => void;
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
        ...(canOpenProject || telegramSynced ? [["Open project", onOpenProject] as [string, () => void]] : []),
        ...(projectCloudState && projectCloudState !== "LOCAL" ? [["Update project", onUpdateProject] as [string, () => void]] : []),
        ["Edit metadata", onEdit],
        ["View detail", onDetail],
        ["Add to queue", onAddToQueue],
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
  beat, cloudUploadErrorDetail, tagFrequency, showIncompleteWarnings, playing, selected, selectedCount, selectMode,
  onPlay, onDetail, onEdit, onDelete, onAddToQueue, onUpload, onUploadTelegram, onDownloadTelegram, onUploadProjectTelegram, onOpenProject, onUpdateProject, onCloudFiles,
  onBulkEdit, onBulkUpload, onBulkDelete, onToggleSelect, onDropArtwork,
  animDelay = 0, dragEnabled
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const [imageDragOver, setImageDragOver] = useState(false);
  const [warningInfoOpen, setWarningInfoOpen] = useState(false);
  const [uploadErrorOpen, setUploadErrorOpen] = useState(false);
  const [projectCloud, setProjectCloud] = useState<ProjectCloudStatus | null>(null);
  const dotsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleNativeArtworkDrag = (event: Event) => {
      const detail = (event as CustomEvent<{ beatId: string | null; active: boolean }>).detail;
      setImageDragOver(Boolean(detail?.active && detail?.beatId === beat.id));
    };
    window.addEventListener("beatgaler:artwork-drag", handleNativeArtworkDrag);

  return () => window.removeEventListener("beatgaler:artwork-drag", handleNativeArtworkDrag);
  }, [beat.id]);
  const tagColors = useTagColors();

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (!(beat.cloud_status === "SYNCED" || beat.cloud_status === "CLOUD_ONLY" || beat.flp_path)) {
        if (!cancelled) setProjectCloud(null);
        return;
      }
      getProjectCloudStatus(beat)
        .then(status => { if (!cancelled) setProjectCloud(status); })
        .catch(() => { if (!cancelled) setProjectCloud(null); });
    };
    const onCloudUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ beatId?: string }>).detail;
      if (!detail?.beatId || detail.beatId === beat.id) refresh();
    };
    refresh();
    window.addEventListener("beatgaler:project-cloud-updated", onCloudUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener("beatgaler:project-cloud-updated", onCloudUpdate);
    };
  }, [beat.id, beat.flp_path, beat.folder_path, beat.cloud_status]);
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
    if (projectCloud === null) return [];
    return projectCloud.valid
      ? []
      : ["No valid PROJECT.zip was found. A valid project ZIP must contain a root-level .flp file."];
  }, [projectCloud]);
  const showIncompleteWarning = showIncompleteWarnings && incompleteReasons.length > 0;
  const cloudUploading = beat.cloud_status === "UPLOADING";
  const cloudUploadComplete = beat.cloud_status === "UPLOAD_COMPLETE";
  const cloudUploadError = beat.cloud_status === "ERROR";

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
          // Red border when beat needs resolution — applied to artwork instead. Outer container keeps compact layout.
        }}
    >
      <style>{uploadAnimationStyles}</style>
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
        data-beat-artwork-id={beat.id}
        ref={setActivatorNodeRef}
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
          if (!e.dataTransfer.types.includes("Files")) return;
          const items = Array.from(e.dataTransfer.items);
          // Some OS/browser combinations expose an empty MIME type during
          // dragover. In that case we deliberately do not highlight: the
          // actual drop handler will still accept a real image.
          const hasImage = items.some(item => item.kind === "file" && item.type.startsWith("image/"));
          if (!hasImage) {
            setImageDragOver(false);
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setImageDragOver(true);
        }}
        onDragLeave={() => setImageDragOver(false)}
        onDrop={e => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setImageDragOver(false);
          const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith("image/"));
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === "string") onDropArtwork(beat, reader.result);
          };
          reader.readAsDataURL(file);
        }}
      >
        <div style={{ borderRadius: 10, overflow: "hidden", position: "relative", display: "inline-block",
                      boxShadow: showIncompleteWarning ? "0 0 0 4px rgba(245,158,11,0.28)" : undefined }}>
          <Artwork beat={beat} size={160} playing={playing} />
          {(cloudUploading || cloudUploadComplete) && (
            <div
              aria-label={cloudUploading ? "Uploading beat to Telegram" : "Upload complete"}
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 24,
                borderRadius: 10,
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: cloudUploading ? "rgba(0,0,0,0.66)" : "rgba(4,35,18,0.26)",
                backdropFilter: cloudUploading ? "blur(1.5px)" : "none",
                WebkitBackdropFilter: cloudUploading ? "blur(1.5px)" : "none",
                transition: "background 220ms ease",
                pointerEvents: "none",
              }}
            >
              {cloudUploadComplete && (
                <div style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(34,197,94,0.26)",
                  animation: "beatgaler-upload-glow 900ms cubic-bezier(.22,.8,.2,1) forwards",
                }} />
              )}
              <div
                style={{
                  width: 44,
                  height: 44,
                  backgroundColor: cloudUploadComplete ? "#40d86c" : "rgba(255,255,255,0.94)",
                  WebkitMaskImage: `url(${uploadStatusSymbolPng})`,
                  maskImage: `url(${uploadStatusSymbolPng})`,
                  WebkitMaskRepeat: "no-repeat",
                  maskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  maskPosition: "center",
                  WebkitMaskSize: "contain",
                  maskSize: "contain",
                  filter: cloudUploadComplete
                    ? "drop-shadow(0 5px 16px rgba(64,216,108,.35))"
                    : "drop-shadow(0 4px 14px rgba(0,0,0,.42))",
                  animation: cloudUploadComplete
                    ? "beatgaler-upload-success 900ms cubic-bezier(.2,.78,.22,1) forwards"
                    : "beatgaler-upload-spin 1.15s linear infinite",
                  willChange: "transform, opacity",
                }}
              />
            </div>
          )}
        </div>
        {showIncompleteWarning && !selectMode && !cloudUploading && !cloudUploadComplete && (
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
                <div style={{ color: "#e8e8e8", fontWeight: 600, marginBottom: 6 }}>Project warning</div>
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
        {imageDragOver && (
          <div style={{
            position: "absolute", inset: 0, borderRadius: 10, background: "rgba(74,222,128,0.18)",
            border: "2px dashed #4ade80", display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 600, color: "#fff", textAlign: "center", padding: 8,
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
        {cloudUploadError && !selectMode && (
          <div
            onMouseEnter={() => setUploadErrorOpen(true)}
            onMouseLeave={() => setUploadErrorOpen(false)}
            aria-label="Background upload failed"
            style={{
              position: "absolute", left: 8, bottom: 8, zIndex: 35,
              width: 20, height: 20, borderRadius: "50%",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(20,20,20,.94)", border: "1px solid rgba(248,113,113,.8)",
              color: "#f87171", fontSize: 12, fontWeight: 800,
              boxShadow: "0 4px 12px rgba(0,0,0,.45)",
              cursor: "help",
            }}
          >
            !
            {uploadErrorOpen && (
              <div style={{
                position: "absolute", left: 26, bottom: 0, zIndex: 80,
                width: 380, maxWidth: "min(380px, calc(100vw - 70px))",
                padding: "12px 13px", borderRadius: 9,
                background: "#171717", border: "1px solid rgba(248,113,113,.45)",
                boxShadow: "0 14px 38px rgba(0,0,0,.78)",
                color: "#d8d8d8", fontSize: 11, lineHeight: 1.5,
                fontWeight: 400, textAlign: "left",
                whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                pointerEvents: "none",
              }}>
                {cloudUploadErrorDetail || [
                  "UPLOAD FAILED",
                  "",
                  "No detailed diagnostic was recorded for this failure.",
                  "Retry the Telegram upload from the beat menu. If it fails again, the next error should include the exact stage and raw error.",
                ].join("\n")}
              </div>
            )}
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
          <div style={{ position: "absolute", inset: 0, borderRadius: 10, background: "rgba(0,0,0,0.42)", display: "flex", alignItems: "center", justifyContent: "center", opacity: hovered && !playing && !cloudUploading && !cloudUploadComplete ? 1 : 0, transition: "opacity 0.15s" }}>
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
          {(beat.cloud_status === "SYNCED" || beat.cloud_status === "CLOUD_ONLY") && (
            <span
              title={beat.cloud_status === "CLOUD_ONLY" ? "Stored in Telegram Cloud · not local" : "Synced to Telegram Cloud"}
              aria-label={beat.cloud_status === "CLOUD_ONLY" ? "Cloud only" : "Synced to Telegram Cloud"}
              style={{ marginLeft: 5, marginRight: 3, flexShrink: 0, fontSize: 11, lineHeight: "18px", color: "#7fa98a", opacity: 0.95 }}
            >
              ☁
            </span>
          )}
          {projectCloud && projectCloud.state !== "LOCAL" && (
            <span
              title={projectCloud.state === "NEEDS_SYNC" ? "Project changed locally · sync needed" : projectCloud.state === "CLOUD_ONLY" ? "Project stored in Telegram Cloud" : "Project synced to Telegram Cloud"}
              aria-label={`Project ${projectCloud.state.toLowerCase()}`}
              style={{ marginRight: 3, flexShrink: 0, fontSize: 10, lineHeight: "18px", opacity: 0.9 }}
            >
              {projectCloud.state === "NEEDS_SYNC" ? "↻" : "📦"}
            </span>
          )}
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
          onUploadTelegram={() => onUploadTelegram(beat)}
          onDownloadTelegram={() => onDownloadTelegram(beat)}
          onUploadProjectTelegram={() => onUploadProjectTelegram(beat)}
          telegramSynced={beat.cloud_status === "SYNCED" || beat.cloud_status === "CLOUD_ONLY"}
          projectCloudState={projectCloud?.state ?? null}
          canOpenProject={Boolean(projectCloud?.valid)}
          onOpenProject={() => onOpenProject(beat)}
          onUpdateProject={() => onUpdateProject(beat)}
          onCloudFiles={() => onCloudFiles(beat)}
          onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
