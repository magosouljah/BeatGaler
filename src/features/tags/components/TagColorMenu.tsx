import React from "react";
import ReactDOM from "react-dom";
import { TAG_COLOR_PALETTE } from "../../../lib/tagColors";

export default function TagColorMenu({
  x, y, current, onSelect, onRename, onClose,
}: {
  x: number; y: number; current: string | null;
  onSelect: (hex: string | null) => void; onRename: () => void; onClose: () => void;
}) {
  React.useEffect(() => {
    const onAnyClick = () => onClose();
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("beatcard:close-menus", onClose);
    setTimeout(() => window.addEventListener("click", onAnyClick), 10);
    window.addEventListener("contextmenu", onAnyClick, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("beatcard:close-menus", onClose);
      window.removeEventListener("click", onAnyClick);
      window.removeEventListener("contextmenu", onAnyClick, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return ReactDOM.createPortal(
    <div onClick={e => e.stopPropagation()} style={{
      position: "fixed", top: y, left: x, zIndex: 9999,
      background: "#1c1c1c", border: "1px solid #2a2a2a", borderRadius: 10,
      padding: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.85)",
    }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        {TAG_COLOR_PALETTE.map(c => (
          <button key={c.key} onClick={() => onSelect(c.hex)} title={c.label}
            style={{
              width: 24, height: 24, borderRadius: "50%", background: c.hex,
              border: current === c.hex ? "2px solid #fff" : "1px solid rgba(255,255,255,0.2)",
              cursor: "pointer", padding: 0,
            }} />
        ))}
      </div>
      <button onClick={() => onSelect(null)}
        style={{ marginTop: 8, width: "100%", padding: "5px 0", background: "transparent", border: "1px solid #333", borderRadius: 6, color: "#999", fontSize: 11, cursor: "pointer" }}>
        Ninguno
      </button>
      <button onClick={onRename}
        style={{ marginTop: 6, width: "100%", padding: "6px 0", background: "#222", border: "1px solid #383838", borderRadius: 6, color: "#ddd", fontSize: 11, cursor: "pointer" }}>
        Renombrar…
      </button>
    </div>,
    document.body
  );
}
