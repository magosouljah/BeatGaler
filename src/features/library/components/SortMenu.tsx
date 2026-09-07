import { useEffect, useRef, useState } from "react";

export type SortKey = "name" | "bpm" | "rating" | "manual";

export default function SortMenu({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const options: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "bpm", label: "BPM" },
    { key: "rating", label: "Rating" },
    { key: "manual", label: "Manual" },
  ];

  const activeLabel = options.find(o => o.key === value)?.label ?? "Sort";

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(v => !v);
        }}
        style={{
          minWidth: 0,
          height: 32,
          padding: "0 18px 0 10px",
          borderRadius: 8,
          background: open ? "#222" : "#161616",
          border: `1px solid ${open ? "#323232" : "#1e1e1e"}`,
          color: open ? "#d2d2d2" : "#8a8a8a",
          fontSize: 11,
          cursor: "pointer",
          outline: "none",
          display: "flex",
          position: "relative",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span>{activeLabel}</span>
        <span style={{ fontSize: 9, opacity: 0.75, position: "absolute", right: 6 }}></span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 36,
            right: 0,
            zIndex: 120,
            width: "fit-content",
            minWidth: 0,
            background: "rgba(24,24,24,0.96)",
            backdropFilter: "blur(12px)",
            border: "1px solid #2a2a2a",
            borderRadius: 10,
            padding: "4px 0",
            boxShadow: "0 12px 30px rgba(0,0,0,0.6)",
          }}
        >
          {options.map((opt) => {
            const active = opt.key === value;
            return (
              <button
                key={opt.key}
                onClick={() => {
                  onChange(opt.key);
                  setOpen(false);
                }}
                style={{
                  width: "auto",
                  border: "none",
                  background: "transparent",
                  color: active ? "#f1f1f1" : "#bebebe",
                  cursor: "pointer",
                  textAlign: "center",
                  padding: "7px 8px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  whiteSpace: "nowrap",
                }}
              >
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
