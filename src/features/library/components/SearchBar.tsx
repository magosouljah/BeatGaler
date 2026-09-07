import { useState } from "react";
import { SearchIcon } from "../../../components/ui";

export default function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const hasText = value.trim().length > 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {open && (
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <input autoFocus value={value} onChange={e => onChange(e.target.value)}
            onBlur={() => { if (!hasText) setOpen(false); }}
            placeholder="Search beats…"
            style={{ background: "#181818", border: "1px solid #252525", borderRadius: 8, padding: "6px 32px 6px 12px", color: "#fff", fontSize: 13, width: 220, outline: "none" }} />
          {hasText && (
            <button
              onMouseDown={e => { e.preventDefault(); onChange(""); }}
              style={{ position: "absolute", right: 6, background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "2px 4px", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center" }}
              onMouseEnter={e => (e.currentTarget.style.color = "#aaa")}
              onMouseLeave={e => (e.currentTarget.style.color = "#555")}
            ></button>
          )}
        </div>
      )}
      <button onClick={() => setOpen(o => !o)}
        style={{ width: 32, height: 32, borderRadius: 8, background: "transparent", border: "none", color: open ? "#ccc" : "#444", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <SearchIcon />
      </button>
    </div>
  );
}
