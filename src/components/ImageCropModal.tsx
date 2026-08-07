import React, { useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };

interface Props {
  imageSrc: string;
  onCancel: () => void;
  // onConfirm returns the cropped data URL plus normalized crop rect (ratios)
  onConfirm: (croppedDataUrl: string, crop: { x: number; y: number; w: number; h: number; unit: 'ratio' }) => void;
}

const VIEWPORT = 340;
const OUTPUT = 900;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export default function ImageCropModal({ imageSrc, onCancel, onConfirm }: Props) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);

  const imgRef = useRef<HTMLImageElement>(null);
  const dragStart = useRef<Point>({ x: 0, y: 0 });
  const dragOrigin = useRef<Point>({ x: 0, y: 0 });

  const baseScale = useMemo(() => {
    if (!natural) return 1;
    return Math.max(VIEWPORT / natural.w, VIEWPORT / natural.h);
  }, [natural]);

  const effectiveScale = baseScale * zoom;

  const clampOffset = (next: Point, scale: number) => {
    if (!natural) return next;
    const displayW = natural.w * scale;
    const displayH = natural.h * scale;
    const maxX = Math.max(0, (displayW - VIEWPORT) / 2);
    const maxY = Math.max(0, (displayH - VIEWPORT) / 2);
    return {
      x: clamp(next.x, -maxX, maxX),
      y: clamp(next.y, -maxY, maxY),
    };
  };

  useEffect(() => {
    setOffset((prev) => clampOffset(prev, effectiveScale));
  }, [effectiveScale]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragOrigin.current = offset;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.preventDefault();
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setOffset(clampOffset({ x: dragOrigin.current.x + dx, y: dragOrigin.current.y + dy }, effectiveScale));
  };

  const onPointerUp = () => setDragging(false);

  const handleConfirm = async () => {
    if (!imgRef.current || !natural) return;
    setSaving(true);
    try {
      const sx = natural.w / 2 - (VIEWPORT / 2 + offset.x) / effectiveScale;
      const sy = natural.h / 2 - (VIEWPORT / 2 + offset.y) / effectiveScale;
      const sWidth = VIEWPORT / effectiveScale;
      const sHeight = VIEWPORT / effectiveScale;

      const clampedSx = clamp(sx, 0, Math.max(0, natural.w - sWidth));
      const clampedSy = clamp(sy, 0, Math.max(0, natural.h - sHeight));

      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not crop image");

      ctx.drawImage(
        imgRef.current,
        clampedSx,
        clampedSy,
        sWidth,
        sHeight,
        0,
        0,
        OUTPUT,
        OUTPUT
      );

      const dataUrl = canvas.toDataURL("image/jpeg", 0.94);
      // normalized crop rect
      const nx = clampedSx / natural.w;
      const ny = clampedSy / natural.h;
      const nw = sWidth / natural.w;
      const nh = sHeight / natural.h;
      onConfirm(dataUrl, { x: nx, y: ny, w: nw, h: nh, unit: 'ratio' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 700, background: "rgba(0,0,0,0.68)", backdropFilter: "blur(5px)" }} />
      <div style={{
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 710,
        width: 430,
        maxWidth: "92vw",
        background: "#0f0f0f",
        border: "1px solid #1e1e1e",
        borderRadius: 12,
        padding: 16,
        boxShadow: "0 26px 80px rgba(0,0,0,0.9)",
      }}>
        <div style={{ fontSize: 14, color: "#ddd", marginBottom: 10, fontWeight: 500 }}>Crop cover (1:1)</div>

        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          style={{
            width: VIEWPORT,
            height: VIEWPORT,
            maxWidth: "100%",
            margin: "0 auto",
            borderRadius: 10,
            overflow: "hidden",
            position: "relative",
            border: "1px solid #262626",
            background: "#090909",
            cursor: dragging ? "grabbing" : "grab",
            touchAction: "none",
          }}
        >
          <img
            ref={imgRef}
            src={imageSrc}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${effectiveScale})`,
              transformOrigin: "center center",
              userSelect: "none",
              pointerEvents: "none",
            }}
            alt="crop"
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#666", marginBottom: 6 }}>
            <span>Zoom</span>
            <span>{zoom.toFixed(2)}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
          <button
            onClick={onCancel}
            disabled={saving}
            style={{
              flex: 1,
              padding: "9px 12px",
              borderRadius: 8,
              border: "1px solid #2a2a2a",
              background: "#161616",
              color: "#888",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            style={{
              flex: 1,
              padding: "9px 12px",
              borderRadius: 8,
              border: "none",
              background: "#fff",
              color: "#000",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {saving ? "Cropping..." : "Apply crop"}
          </button>
        </div>
      </div>
    </>
  );
}
