import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import type { Beat } from "../types";
import { Artwork } from "./ui";
import { revealInExplorer } from "../lib/tauri";
import shufflePng from "../assets/player-icons/shuffle.png";
import repeatPng from "../assets/player-icons/repeat.png";
import backwardFillPng from "../assets/player-icons/backward.fill.png";
import forwardFillPng from "../assets/player-icons/forward.fill.png";
import ellipsisPng from "../assets/player-icons/ellipsis.png";
import plusPng from "../assets/player-icons/plus.png";
import queuePng from "../assets/player-icons/music.note.list.png";
import playFillPng from "../assets/player-icons/play.fill.png";
import pauseFillPng from "../assets/player-icons/pause.fill.png";
import speakerFillPng from "../assets/player-icons/speaker.fill.png";
import speakerSlashFillPng from "../assets/player-icons/speaker.slash.fill.png";
import speaker1FillPng from "../assets/player-icons/speaker.1.fill.png";
import speaker2FillPng from "../assets/player-icons/speaker.2.fill.png";
import speaker3FillPng from "../assets/player-icons/speaker.3.fill.png";
import { playerMetaLabel, playerToggleTitle } from "../features/components/componentLogic";

interface Props {
  beat: Beat;
  playing: boolean;
  progress: number;
  duration: number;
  volume: number;
  queue: Beat[];
  currentIndex: number;
  showQueue: boolean;
  canShowQueue: boolean;
  shuffleEnabled: boolean;
  repeatMode: "off" | "all" | "one";
  onToggle: () => void;
  onSeek: (ratio: number) => void;
  onPrev: () => void;
  onNext: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  onToggleQueue: () => void;
  onPlayQueueIndex: (index: number) => void;
  onAddBeat: () => void;
  onDetail: (beat: Beat) => void;
  onEdit: (beat: Beat) => void;
  onDelete: (beat: Beat) => void;
  onAddToQueue: (beat: Beat) => void;
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
    window.addEventListener("beatcard:close-menus", onClose);
    setTimeout(() => window.addEventListener("click", onAnyClick), 10);
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



function controlButtonStyle(active = false, size = 30): React.CSSProperties {
  return {
    width: size,
    height: size,
    border: "none",
    borderRadius: 999,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    background: active
      ? "rgba(255,255,255,0.12)"
      : "rgba(255,255,255,0.04)",
    color: active ? "#ffffff" : "rgba(255,255,255,0.45)",
    transition: "all 0.2s ease-in-out",
    transform: "scale(1)",
  };
}

function transportButtonStyle(size = 28): React.CSSProperties {
  return {
    width: size,
    height: size,
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    background: "transparent",
    color: "rgba(255,255,255,0.86)",
    transition: "all 0.18s ease-in-out",
    transform: "scale(1)",
  };
}

function iconButtonStateHandlers<T extends HTMLElement>(on = true) {
  return {
    onMouseEnter: (e: React.MouseEvent<T>) => {
      e.currentTarget.style.transform = on ? "scale(1.1)" : "scale(1)";
      e.currentTarget.style.opacity = "1";
    },
    onMouseLeave: (e: React.MouseEvent<T>) => {
      e.currentTarget.style.transform = "scale(1)";
      e.currentTarget.style.opacity = "1";
    },
    onMouseDown: (e: React.MouseEvent<T>) => {
      e.currentTarget.style.transform = "scale(0.95)";
    },
    onMouseUp: (e: React.MouseEvent<T>) => {
      e.currentTarget.style.transform = "scale(1.1)";
    },
  };
}

function MaskSymbol({
  src,
  size = 20,
  color,
  gradient,
}: {
  src: string;
  size?: number;
  color?: string;
  gradient?: string;
}) {
  const opacity = (() => {
    if (gradient) return 1;
    if (!color) return 1;

    const rgbaMatch = color.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\s*\)/i);
    if (rgbaMatch) {
      const alpha = Number.parseFloat(rgbaMatch[1]);
      return Number.isNaN(alpha) ? 1 : Math.max(0, Math.min(1, alpha));
    }

    return 1;
  })();

  return (
    <img
      aria-hidden
      src={src}
      alt=""
      style={{
        width: size,
        height: size,
        display: "inline-block",
        objectFit: "contain",
        filter: "brightness(0) saturate(100%) invert(100%)",
        opacity,
      }}
    />
  );
}

function ShuffleIcon({ active }: { active: boolean }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
      <MaskSymbol src={shufflePng} size={20} color={active ? "#FFFFFF" : "rgba(255,255,255,0.36)"} />
      {active && <span style={{ position: "absolute", bottom: -2, left: "50%", width: 2.3, height: 2.3, borderRadius: 999, background: "#FFFFFF", transform: "translateX(-50%)" }} />}
    </span>
  );
}

function RepeatIcon({ mode }: { mode: "off" | "all" | "one" }) {
  const active = mode !== "off";
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
      <MaskSymbol src={repeatPng} size={20} color={active ? "#FFFFFF" : "rgba(255,255,255,0.36)"} />
      {mode === "one" && (
        <span style={{ position: "absolute", right: -0.5, top: -1.5, fontSize: 8, lineHeight: 1, fontWeight: 700, color: active ? "#FFFFFF" : "rgba(255,255,255,0.36)" }}>
          1
        </span>
      )}
      {active && <span style={{ position: "absolute", bottom: -2, left: "50%", width: 2.3, height: 2.3, borderRadius: 999, background: "#FFFFFF", transform: "translateX(-50%)" }} />}
    </span>
  );
}

function PrevIcon() {
  return <MaskSymbol src={backwardFillPng} size={23} color="rgba(255,255,255,0.78)" />;
}

function NextIcon() {
  return <MaskSymbol src={forwardFillPng} size={23} color="rgba(255,255,255,0.78)" />;
}

function MoreIcon() {
  return <MaskSymbol src={ellipsisPng} size={18} color="rgba(255,255,255,0.56)" />;
}

function QueueIcon({ active }: { active: boolean }) {
  return <MaskSymbol src={queuePng} size={18} color={active ? "#FFFFFF" : "rgba(255,255,255,0.36)"} />;
}

function PlusIcon() {
  return <MaskSymbol src={plusPng} size={18} color="rgba(255,255,255,0.56)" />;
}

function VolumeIcon({ volume }: { volume: number }) {
  const v = Math.max(0, Math.min(1, volume));
  const baseOpacity = v <= 0.01 ? 0.36 : 0.88;
  const boxWidth = 28;
  const boxHeight = 20;

  // 5-step order:
  // slash -> fill -> fill1 -> fill2 -> fill3
  const states = [
    speakerSlashFillPng,
    speakerFillPng,
    speaker1FillPng,
    speaker2FillPng,
    speaker3FillPng,
  ];

  // Volume mapping requested:
  // 0% => slash
  // >0% to 24% => fill
  // 25% to 66.666% => fill1
  // 66.666% to 99.99% => fill2
  // 100% => fill3
  let targetIndex = 0;
  if (v <= 0) {
    targetIndex = 0;
  } else if (v >= 1) {
    targetIndex = 4;
  } else if (v < 0.25) {
    targetIndex = 1;
  } else if (v < 2 / 3) {
    targetIndex = 2;
  } else {
    targetIndex = 3;
  }

  const symbol = states[targetIndex];

  return (
    <span
      style={{
        position: "relative",
        width: boxWidth,
        height: boxHeight,
        display: "inline-block",
        flexShrink: 0,
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      <img
        key={symbol}
        aria-hidden
        src={symbol}
        alt=""
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: "auto",
          height: "auto",
          transform: "translate(-50%, -50%) scale(0.5)",
          filter: "brightness(0) saturate(100%) invert(100%)",
          opacity: baseOpacity,
          transition: "opacity 120ms linear",
          pointerEvents: "none",
        }}
      />
    </span>
  );
}

export default function Player({
  beat,
  playing,
  progress,
  duration,
  volume,
  queue,
  currentIndex,
  showQueue,
  canShowQueue,
  shuffleEnabled,
  repeatMode,
  onToggle,
  onSeek,
  onPrev,
  onNext,
  onVolumeChange,
  onToggleShuffle,
  onCycleRepeat,
  onToggleQueue,
  onPlayQueueIndex,
  onAddBeat,
  onDetail,
  onEdit,
  onDelete,
  onAddToQueue,
}: Props) {
  const [viewportWidth, setViewportWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1920);
  const [showVolume, setShowVolume] = useState(false);
  const [showEmptyQueueHint, setShowEmptyQueueHint] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const [isDraggingProgress, setIsDraggingProgress] = useState(false);
  const [dragProgress, setDragProgress] = useState(0);
  const [hoveringScrubber, setHoveringScrubber] = useState(false);
  const queueButtonRef = useRef<HTMLButtonElement | null>(null);
  const queuePopoverRef = useRef<HTMLDivElement | null>(null);
  const volumeButtonRef = useRef<HTMLButtonElement | null>(null);
  const volumePopoverRef = useRef<HTMLDivElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (
        showQueue &&
        !queuePopoverRef.current?.contains(target) &&
        !queueButtonRef.current?.contains(target)
      ) {
        setShowVolume(false);
        onToggleQueue();
      }

      if (
        showVolume &&
        !volumePopoverRef.current?.contains(target) &&
        !volumeButtonRef.current?.contains(target)
      ) {
        setShowVolume(false);
      }
    };

    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [showQueue, showVolume, onToggleQueue]);

  useEffect(() => {
    if (!showEmptyQueueHint) return;
    const timer = window.setTimeout(() => setShowEmptyQueueHint(false), 1500);
    return () => window.clearTimeout(timer);
  }, [showEmptyQueueHint]);

  const computeSeekRatio = (clientX: number) => {
    const rect = scrubberRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  useEffect(() => {
    if (!isDraggingProgress) return;
    const onMove = (e: MouseEvent) => {
      const ratio = computeSeekRatio(e.clientX);
      setDragProgress(ratio);
      onSeek(ratio);
    };
    const onUp = (e: MouseEvent) => {
      const ratio = computeSeekRatio(e.clientX);
      onSeek(ratio);
      setIsDraggingProgress(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraggingProgress]);

  const isCompact = viewportWidth < 1100;
  const isSmall = viewportWidth < 860;
  const isTiny = viewportWidth < 700;
  const playerHeight = isSmall ? 62 : 68;
  const playerPadding = isTiny ? 10 : isSmall ? 14 : 18;
  const controlsGap = isTiny ? 5 : isSmall ? 7 : 10;
  const rightGap = isTiny ? 7 : 10;
  const playerWidth = `min(${isCompact ? 980 : 1100}px, calc(100vw - ${isTiny ? 16 : 24}px))`;
  const transportSize = 23;
  const playPauseSize = 30;
  const utilityBtnSize = isTiny ? 26 : 30;
  const infoGap = isTiny ? 8 : 12;
  const artworkSize = isTiny ? 42 : 48;
  const volContainerW = isTiny ? 32 : 36;
  const volContainerH = isTiny ? 150 : 168;
  const volPadY = 14;
  const volTrackH = volContainerH - volPadY * 2;
  const volThumbD = 12;
  const volThumbBottom = volume * (volTrackH - volThumbD);

  return (
    <div
      ref={rootRef}
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        bottom: 24,
        width: playerWidth,
        height: playerHeight,
        background: "rgba(20, 20, 20, 0.75)",
        backdropFilter: "blur(20px)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: 34,
        boxShadow: "0px 10px 30px 0px rgba(0, 0, 0, 0.5)",
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        padding: `10px ${playerPadding}px`,
        gap: isTiny ? 10 : 14,
        overflow: "visible",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: controlsGap, flexShrink: 0 }}>
        <button
          onClick={onToggleShuffle}
          style={controlButtonStyle(shuffleEnabled, utilityBtnSize)}
          title="Shuffle"
          {...iconButtonStateHandlers<HTMLButtonElement>()}
        >
          <ShuffleIcon active={shuffleEnabled} />
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: isTiny ? 4 : 6 }}>
          <button onClick={onPrev} style={transportButtonStyle(transportSize)} title="Previous" {...iconButtonStateHandlers<HTMLButtonElement>()}>
            <PrevIcon />
          </button>
          <button
            onClick={onToggle}
            style={transportButtonStyle(playPauseSize)}
            {...iconButtonStateHandlers<HTMLButtonElement>()}
            title={playerToggleTitle(playing)}
          >
            <MaskSymbol
              src={playing ? pauseFillPng : playFillPng}
              size={isTiny ? 24 : 26}
              color="rgba(255,255,255,0.92)"
            />
          </button>
          <button onClick={onNext} style={transportButtonStyle(transportSize)} title="Next" {...iconButtonStateHandlers<HTMLButtonElement>()}>
            <NextIcon />
          </button>
        </div>

        <button
          onClick={onCycleRepeat}
          style={controlButtonStyle(repeatMode !== "off", utilityBtnSize)}
          title="Repeat"
          {...iconButtonStateHandlers<HTMLButtonElement>()}
        >
          <RepeatIcon mode={repeatMode} />
        </button>
      </div>

      {/* CENTER: Now Playing + Scrubber */}
      <div style={{ display: "flex", alignItems: "center", gap: infoGap, flex: 1, minWidth: 0 }}>
        <Artwork beat={beat} size={artworkSize} playing={false} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0 }}>
          {/* Beat info + More button row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 0, paddingTop: 5 }}>
              <div style={{ fontSize: isTiny ? 12 : 14, fontWeight: 600, color: "#FFFFFF", lineHeight: "1.2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {beat.name}
              </div>
              <div style={{ fontSize: isTiny ? 11 : 12, color: "rgba(255, 255, 255, 0.6)", lineHeight: "1.2", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {playerMetaLabel(beat.key, beat.bpm)}
              </div>
            </div>
              <button
                ref={moreButtonRef}
                onClick={(e) => {
                  e.stopPropagation();
                  window.dispatchEvent(new Event("beatcard:close-menus"));
                  const rect = moreButtonRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  setShowVolume(false);
                  if (showQueue) onToggleQueue();
                  const menuHeight = 170;
                  setMenu({ x: rect.right - 180, y: Math.max(8, rect.top - menuHeight - 4) });
                }}
                style={{ ...controlButtonStyle(false, utilityBtnSize), alignSelf: "flex-end", marginTop: 6, marginBottom: 0, background: "none", padding: 0 }}
                title="More"
                {...iconButtonStateHandlers(false)}
              >
              <MoreIcon />
            </button>
          </div>
          {/* Scrubber bar */}
          <div
            ref={scrubberRef}
            onMouseEnter={() => setHoveringScrubber(true)}
            onMouseLeave={() => setHoveringScrubber(false)}
            style={{
              marginTop: 6,
              paddingTop: 6, paddingBottom: 6, marginBottom: -6, // wider invisible hit area, same visual position
              cursor: "pointer",
              position: "relative",
            }}
            onMouseDown={(e) => {
              const ratio = computeSeekRatio(e.clientX);
              setDragProgress(ratio);
              setIsDraggingProgress(true);
              onSeek(ratio);
            }}
          >
            <div style={{ height: 4, background: "rgba(255, 255, 255, 0.2)", borderRadius: 2, position: "relative" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.max(0, Math.min(1, isDraggingProgress ? dragProgress : progress)) * 100}%`,
                  background: "#FFFFFF",
                  borderRadius: 2,
                  transition: isDraggingProgress ? "none" : "width 0.1s linear",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: `${Math.max(0, Math.min(1, isDraggingProgress ? dragProgress : progress)) * 100}%`,
                  width: isDraggingProgress ? 12 : 10,
                  height: isDraggingProgress ? 12 : 10,
                  borderRadius: "50%",
                  background: "#FFFFFF",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
                  transform: "translate(-50%, -50%)",
                  opacity: isDraggingProgress || hoveringScrubber ? 1 : 0,
                  transition: "opacity 0.15s, width 0.1s, height 0.1s",
                  pointerEvents: "none",
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: Auxiliary Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: rightGap, flexShrink: 0, position: "relative" }}>
        <button onClick={onAddBeat} style={controlButtonStyle(false, utilityBtnSize)} title="Add beat" {...iconButtonStateHandlers<HTMLButtonElement>()}>
          <PlusIcon />
        </button>
        <button
          ref={queueButtonRef}
          onClick={() => {
            setShowVolume(false);
            if (!canShowQueue) {
              if (showQueue) onToggleQueue();
              setShowEmptyQueueHint(true);
              return;
            }
            onToggleQueue();
          }}
          style={controlButtonStyle(showQueue && canShowQueue, utilityBtnSize)}
          title="Queue"
          {...iconButtonStateHandlers<HTMLButtonElement>()}
        >
          <QueueIcon active={showQueue && canShowQueue} />
        </button>
        <div style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          <button
            ref={volumeButtonRef as any}
            onClick={() => {
              if (showQueue) onToggleQueue();
              setShowVolume((v) => !v);
            }}
            style={{
              position: "relative",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              padding: 0,
              background: "none",
              border: "none",
              overflow: "visible",
              transition: "opacity 0.15s",
              opacity: showVolume ? 1 : 0.56,
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = "0.88")}
            onMouseLeave={e => (e.currentTarget.style.opacity = showVolume ? "1" : "0.56")}
            title="Volume"
          >
            <span
              aria-hidden
              style={{
                position: "absolute",
                inset: -14,
                background: "transparent",
              }}
            />
            <VolumeIcon volume={volume} />
          </button>

          {showVolume && (
            <div
              ref={volumePopoverRef}
              style={{
                position: "absolute",
                left: "50%",
                transform: "translateX(-50%)",
                bottom: playerHeight + 8,
                width: volContainerW,
                height: volContainerH,
                paddingTop: volPadY,
                paddingBottom: volPadY,
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(20, 20, 20, 0.82)",
                backdropFilter: "blur(20px) saturate(120%)",
                boxShadow: "0px 8px 20px rgba(0,0,0,0.4)",
                zIndex: 91,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
            {/* Custom vertical slider */}
            <div style={{ position: "relative", width: 3, height: volTrackH }}>
              {/* Track background */}
              <div style={{
                position: "absolute",
                inset: 0,
                borderRadius: 2,
                background: "rgba(255,255,255,0.2)",
              }} />
              {/* Fill */}
              <div style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: `${volume * 100}%`,
                borderRadius: 2,
                background: "#ffffff",
              }} />
              {/* Thumb */}
              <div style={{
                position: "absolute",
                left: "50%",
                bottom: volThumbBottom,
                width: volThumbD,
                height: volThumbD,
                borderRadius: "50%",
                background: "#ffffff",
                boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
                transform: "translateX(-50%)",
                pointerEvents: "none",
              }} />
              {/* Invisible interaction layer */}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                style={{
                  position: "absolute",
                  width: volTrackH,
                  height: volContainerW,
                  left: "50%",
                  top: "50%",
                  transform: "translateX(-50%) translateY(-50%) rotate(-90deg)",
                  opacity: 0,
                  cursor: "pointer",
                  margin: 0,
                  padding: 0,
                }}
              />
            </div>
            </div>
          )}
        </div>

        {showQueue && (
          <div
            ref={queuePopoverRef}
            style={{
              position: "absolute",
              right: utilityBtnSize + rightGap,
              bottom: playerHeight + 8,
              width: isTiny ? 260 : 320,
              maxHeight: 360,
              overflowY: "auto",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(20, 20, 20, 0.9)",
              backdropFilter: "blur(10px)",
              boxShadow: "0px 8px 20px rgba(0,0,0,0.4)",
              padding: 10,
              zIndex: 91,
            }}
          >
            <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 11, padding: "4px 6px 8px", fontWeight: 600 }}>Up Next</div>
            {queue.map((item, idx) => (
              <button
                key={item.id}
                onClick={() => onPlayQueueIndex(idx)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 6px",
                  borderRadius: 8,
                  border: "none",
                  background: idx === currentIndex ? "rgba(255,255,255,0.1)" : "transparent",
                  color: "#FFFFFF",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "all 0.2s ease-in-out",
                }}
              >
                <Artwork beat={item} size={32} playing={false} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#FFFFFF", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.name}
                  </div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
                    {item.bpm}{item.bpm && item.key ? " • " : ""}{item.key}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {showEmptyQueueHint && !showQueue && (
          <div
            style={{
              position: "absolute",
              right: utilityBtnSize + rightGap,
              bottom: playerHeight + 8,
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(20, 20, 20, 0.9)",
              color: "rgba(255,255,255,0.8)",
              fontSize: 12,
              whiteSpace: "nowrap",
              zIndex: 91,
            }}
          >
            Nothing in queue
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onEdit={() => onEdit(beat)}
          onDetail={() => onDetail(beat)}
          onAddToQueue={() => onAddToQueue(beat)}
          onDelete={() => onDelete(beat)}
          onReveal={() => revealInExplorer(beat.folder_path)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
