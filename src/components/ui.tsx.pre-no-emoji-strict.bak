import React, { useState } from "react";
import { useTagColor } from "../lib/tagColors";

// ── Icons ────────────────────────────────────────────────────
export function PlayIcon({ size = 13, color = "#000" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M4 2.5L13.5 8L4 13.5V2.5Z" fill={color} />
    </svg>
  );
}
export function PauseIcon({ size = 13, color = "#000" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <rect x="3" y="2" width="3.5" height="12" rx="1.2" fill={color} />
      <rect x="9.5" y="2" width="3.5" height="12" rx="1.2" fill={color} />
    </svg>
  );
}
export function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M14 14L18 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
export function FolderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <path d="M2 6a2 2 0 012-2h3.17a2 2 0 011.42.59L9.41 5.41A2 2 0 0010.83 6H16a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
export function PlusIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none">
      <path d="M5.5 1v9M1 5.5h9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
export function RevealIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M2 8a6 6 0 1112 0A6 6 0 012 8z" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 5.5v5M5.5 8h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ── Pulsing bars (now playing indicator) ────────────────────
export function PulsingBars({ color = "#fff" }: { color?: string }) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 14 }}>
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          style={{
            width: 2.5, borderRadius: 2, background: color,
            height: "100%", transformOrigin: "bottom",
            animation: `pgb${i} 0.8s ease-in-out infinite alternate`,
            animationDelay: `${i * 0.1}s`,
          }}
        />
      ))}
    </div>
  );
}

// ── Stars ────────────────────────────────────────────────────
export function Stars({
  n, onChange,
}: {
  n: number;
  onChange?: (v: number) => void;
}) {
  const [hov, setHov] = useState<number | null>(null);
  return (
    <div style={{ display: "flex", gap: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          onClick={onChange ? () => onChange(i) : undefined}
          onMouseEnter={() => onChange && setHov(i)}
          onMouseLeave={() => onChange && setHov(null)}
          style={{
            fontSize: 13, cursor: onChange ? "pointer" : "default",
            color: i <= (hov ?? n) ? "#f59e0b" : "#252525",
            transition: "color 0.1s",
          }}
        >★</span>
      ))}
    </div>
  );
}

// ── Tag pill ─────────────────────────────────────────────────
export function TagPill({
  label, onRemove,
}: {
  label: string;
  onRemove?: () => void;
}) {
  const color = useTagColor(label);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 11, padding: "2px 8px", borderRadius: 20,
      background: color ? `${color}26` : "#1e1e1e",
      color: color ?? "#777",
      border: `1px solid ${color ? `${color}66` : "#272727"}`,
    }}>
      {label}
      {onRemove && (
        <span
          onClick={onRemove}
          style={{ color: color ?? "#444", opacity: color ? 0.75 : 1, cursor: "pointer", fontSize: 10, lineHeight: 1 }}
        >✕</span>
      )}
    </span>
  );
}

// ── Tag editor (add / remove tags) ──────────────────────────
export function TagEditor({
  tags, onChange, suggestions = [],
}: {
  tags: string[];
  onChange: (t: string[]) => void;
  suggestions?: string[];
}) {
  const [input, setInput] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  // Keep tags deliberately conservative for maximum ID3/Windows compatibility.
  // TCON has legacy genre-code syntax such as "(9)" = Metal, so punctuation
  // is rejected instead of silently transformed.
  const normalizeTag = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const isSafeTag = (value: string) => /^[a-z0-9]+(?:[ _-][a-z0-9]+)*$/.test(value) && value.length <= 40;
  const pushUniqueTag = (nextTag: string) => {
    const normalized = normalizeTag(nextTag);
    if (!normalized) return;
    if (!isSafeTag(normalized)) {
      setTagError("Use only letters, numbers, spaces, - or _. No parentheses or separators.");
      return;
    }
    setTagError(null);
    const existing = new Set(tags.map(normalizeTag));
    if (existing.has(normalized)) return;
    if (tags.length >= 30) {
      setTagError("Maximum 30 tags per beat.");
      return;
    }
    onChange([...tags.map(normalizeTag).filter(Boolean), normalized]);
  };

  const normalizedInput = normalizeTag(input);
  const add = () => {
    pushUniqueTag(input);
    setInput("");
  };

  const predictedTags = suggestions
    .map(normalizeTag)
    .filter((s, i, arr) => !!s && arr.indexOf(s) === i)
    .filter((s) => !tags.map(normalizeTag).includes(s) && (!normalizedInput || s.includes(normalizedInput)))
    .slice(0, 8);

  return (
    <div data-prevent-enter-save="true">
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: tags.length ? 8 : 0 }}>
        {tags.map((t) => (
          <TagPill key={t} label={t} onRemove={() => onChange(tags.filter((x) => x !== t))} />
        ))}
      </div>
      {predictedTags.length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
          {predictedTags.map((t) => (
            <button
              key={t}
              onClick={() => pushUniqueTag(t)}
              style={{
                fontSize: 11,
                padding: "3px 8px",
                borderRadius: 20,
                background: "#121212",
                color: "#8d8d8d",
                border: "1px solid #252525",
                cursor: "pointer",
              }}
            >
              + {t}
            </button>
          ))}
        </div>
      )}
      {tagError && <div style={{ fontSize: 10, color: "#f87171", marginBottom: 6 }}>{tagError}</div>}
      <div style={{ display: "flex", gap: 7 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              e.stopPropagation();
              add();
            }
            if (e.key === "Tab" && predictedTags.length > 0) {
              e.preventDefault();
              e.stopPropagation();
              pushUniqueTag(predictedTags[0]);
              setInput("");
            }
          }}
          placeholder="Add tag, press Enter…"
          style={{
            flex: 1, background: "#161616", border: "1px solid #222", borderRadius: 7,
            padding: "6px 10px", color: "#ccc", fontSize: 12, outline: "none",
          }}
        />
        <button
          onClick={add}
          style={{
            padding: "6px 12px", background: "#232323", border: "1px solid #2e2e2e",
            borderRadius: 7, color: "#999", fontSize: 12, cursor: "pointer",
          }}
        >Add</button>
      </div>
    </div>
  );
}

// ── Artwork ──────────────────────────────────────────────────
export function Artwork({
  beat, size = 160, playing,
}: {
  beat: { name: string; image_base64: string | null; image_preview_base64?: string | null; color: string; color2: string; id: string };
  size?: number;
  playing?: boolean;
}) {
  const initials = beat.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: size, height: size, borderRadius: 10, flexShrink: 0,
      position: "relative", overflow: "hidden",
      background: (beat.image_preview_base64 || beat.image_base64) ? "#000" : `linear-gradient(135deg, ${beat.color}, ${beat.color2})`,
      boxShadow: playing ? "0 0 0 2px rgba(255,255,255,0.15)" : "none",
      transition: "box-shadow 0.2s",
    }}>
      { (beat.image_preview_base64 || beat.image_base64) ? (
        <img src={beat.image_preview_base64 ?? beat.image_base64 ?? undefined} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt={beat.name} />
      ) : (
        <>
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.07 }}>
            <filter id={`n${beat.id}`}>
              <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect width="100%" height="100%" filter={`url(#n${beat.id})`} />
          </svg>
          <span style={{
            position: "absolute", bottom: 8, left: 10,
            fontWeight: 300, fontSize: 11,
            color: "rgba(255,255,255,0.3)", letterSpacing: 1,
          }}>{initials}</span>
        </>
      )}
      {playing && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(0,0,0,0.45)",
        }}>
          <PulsingBars color="#fff" />
        </div>
      )}
    </div>
  );
}
