import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { LabBeatTile, LabButton, LabPlayer } from "./components";
import { DEMO_BEATS } from "./data";
import type { DemoBeat } from "./data";
import type { CoverMode } from "./coverSources";
import "./gallery.css";

const TAG_PALETTE = [
  { name: "Red", hex: "#FF3B30" }, { name: "Orange", hex: "#FF9500" },
  { name: "Yellow", hex: "#FFCC00" }, { name: "Green", hex: "#34C759" },
  { name: "Blue", hex: "#007AFF" }, { name: "Purple", hex: "#AF52DE" },
  { name: "Gray", hex: "#8E8E93" },
] as const;
type TagFilter = "include" | "exclude";
const TAGS = ["Ambient", "Trap", "Electronic"] as const;

export default function GalleryPage({ playing, beat, toggle, selectBeat, coverMode, tagColors, setTagColors }: {
  playing: boolean; beat: DemoBeat; toggle: () => void; selectBeat: (beat: DemoBeat) => void;
  coverMode: CoverMode; tagColors: Record<string, string>;
  setTagColors: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("manual");
  const [filters, setFilters] = useState<Record<string, TagFilter>>({});
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const paletteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editingTag) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setEditingTag(null); };
    const outside = (event: PointerEvent) => {
      if (!paletteRef.current?.contains(event.target as Node)) setEditingTag(null);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [editingTag]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const included = Object.keys(filters).filter(name => filters[name] === "include");
    const excluded = Object.keys(filters).filter(name => filters[name] === "exclude");
    const beats = DEMO_BEATS.filter(item =>
      (included.length === 0 || included.includes(item.tag)) && !excluded.includes(item.tag) &&
      (!query || [item.title, item.tag, item.key, String(item.bpm)]
        .some(value => value.toLocaleLowerCase().includes(query)))
    );
    if (sort === "name") return [...beats].sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "bpm") return [...beats].sort((a, b) => a.bpm - b.bpm);
    return beats;
  }, [search, filters, sort]);

  const cycleTag = (name: string) => setFilters(current => {
    const next = { ...current };
    if (!next[name]) next[name] = "include";
    else if (next[name] === "include") next[name] = "exclude";
    else delete next[name];
    return next;
  });
  const clearSelection = () => { setSelected([]); setSelectMode(false); };
  const toggleSelection = (id: string) => setSelected(current =>
    current.includes(id) ? current.filter(item => item !== id) : [...current, id]
  );
  return (
    <div className="lab-gallery-page">
      <header className="lab-gallery-header">
        <span className="lab-gallery-wordmark">beat galer</span>
        <div className="lab-glass-toolbar" role="group" aria-label="Library tools">
          <label className="lab-glass-search">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <circle cx="10.8" cy="10.8" r="6.7" /><path d="m16 16 5 5" />
            </svg>
            <input type="search" aria-label="Search beats" placeholder="Search beats" value={search} onChange={e => setSearch(e.target.value)} />
          </label>
          <span className="lab-glass-divider" aria-hidden="true" />
          <label className="lab-glass-sort">
            <span className="lab-sr-only">Sort by</span>
            <select value={sort} aria-label="Sort by" onChange={e => setSort(e.target.value)}>
              <option value="manual">Manual</option><option value="name">Name</option><option value="bpm">BPM</option>
            </select>
            <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="m5 8 5 5 5-5" stroke="currentColor" fill="none" strokeWidth="1.5" /></svg>
          </label>
          <span className="lab-glass-divider" aria-hidden="true" />
          {selectMode ? <>
            <button type="button" className="lab-glass-action" onClick={() => setSelected(selected.length === filtered.length ? [] : filtered.map(item => item.id))}>
              {selected.length === filtered.length && filtered.length ? "Deselect all" : "Select all"}
            </button>
            <button type="button" className="lab-glass-action is-selected" onClick={clearSelection}>Done</button>
          </> : <button type="button" className="lab-glass-action" onClick={() => setSelectMode(true)}>Select</button>}
        </div>
      </header>
      <div className="lab-gallery-tag-bar" role="group" aria-label="Tag filters">
        <button type="button" className={Object.keys(filters).length === 0 ? "lab-gallery-tag is-included" : "lab-gallery-tag"}
          aria-pressed={Object.keys(filters).length === 0} onClick={() => setFilters({})}>All</button>
        {TAGS.map(name => {
          const color = tagColors[name];
          const state = filters[name] ?? "idle";
          return <div className="lab-gallery-tag-wrap" key={name} ref={editingTag === name ? paletteRef : undefined}>
            <button type="button" className={`lab-gallery-tag is-${state}`}
              style={color ? { "--lab-tag-color": color } as CSSProperties : undefined}
              onClick={() => cycleTag(name)} onContextMenu={event => { event.preventDefault(); setEditingTag(name); }}
              aria-pressed={state === "include"} aria-label={`${name}: ${state}. Activate to cycle included, excluded, off.`}>{name}</button>
            <button type="button" className="lab-tag-color-trigger" onClick={() => setEditingTag(editingTag === name ? null : name)}
              aria-label={`Change ${name} tag color`} aria-expanded={editingTag === name}>···</button>
            {editingTag === name && <div className="lab-tag-color-popover" role="group" aria-label={`${name} colors`}>
              <div className="lab-tag-color-swatches">{TAG_PALETTE.map(option =>
                <button type="button" key={option.hex} style={{ background: option.hex }}
                  className={color === option.hex ? "is-current" : ""} aria-label={option.name} title={option.name}
                  onClick={() => { setTagColors(current => ({ ...current, [name]: option.hex })); setEditingTag(null); }} />
              )}</div>
              <button type="button" className="lab-tag-color-none" onClick={() => {
                setTagColors(current => { const next = { ...current }; delete next[name]; return next; });
                setEditingTag(null);
              }}>No color</button>
            </div>}
          </div>;
        })}
      </div>
      {selectMode && selected.length > 0 && <div className="lab-gallery-selection-status" role="status">
        {selected.length} selected <button type="button" onClick={() => setSelected([])}>Clear selection</button>
      </div>}
      <main className="lab-gallery-main">
        {filtered.length ? <div className="lab-gallery-grid">
          {filtered.map(item => <div className="lab-gallery-item" key={item.id}>
            <LabBeatTile beat={item} coverMode={coverMode} tagColor={tagColors[item.tag]}
              selected={playing && item.id === beat.id} onPlay={selectBeat} />
            {selectMode && <label className="lab-gallery-select">
              <input type="checkbox" aria-label={`Select ${item.title}`} checked={selected.includes(item.id)} onChange={() => toggleSelection(item.id)} />
            </label>}
          </div>)}
        </div> : <div className="lab-empty" role="status"><strong>No beats found</strong>
          <LabButton onClick={() => { setSearch(""); setFilters({}); }}>Clear filters</LabButton></div>}
      </main>
      <LabPlayer beat={beat} playing={playing} onToggle={toggle} coverMode={coverMode}
        beats={DEMO_BEATS} onPlayBeat={selectBeat} variant="dock" />
    </div>
  );
}