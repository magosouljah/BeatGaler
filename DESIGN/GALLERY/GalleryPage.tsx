import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from "react";
import { LabBeatTile, LabButton, LabPlayer } from "../shared/components";
import { DEMO_BEATS, DEMO_TAGS } from "../shared/data";
import type { DemoBeat, DemoTag } from "../shared/data";
import type { CoverMode } from "../shared/coverSources";
import LabToolbar from "../shared/Toolbar";
import type { LabSort } from "../shared/Toolbar";

type TagFilter = "include" | "exclude";
const TAG_PALETTE = [
  {name:"Red",hex:"#FF3B30"},{name:"Orange",hex:"#FF9500"},
  {name:"Yellow",hex:"#FFCC00"},{name:"Green",hex:"#34C759"},
  {name:"Blue",hex:"#007AFF"},{name:"Purple",hex:"#AF52DE"},
  {name:"Gray",hex:"#8E8E93"}
] as const;

export default function GalleryPage({ playing, beat, toggle, selectBeat, coverMode, tagColors, setTagColors }: {
  playing: boolean; beat: DemoBeat; toggle: () => void; selectBeat: (beat: DemoBeat) => void;
  coverMode: CoverMode; tagColors: Record<string, string>;
  setTagColors: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LabSort>("manual");
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [filters, setFilters] = useState<Partial<Record<DemoTag, TagFilter>>>({});
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [editingTag, setEditingTag] = useState<DemoTag | null>(null);
  const paletteRef = useRef<HTMLDivElement>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextClick = useRef<DemoTag | null>(null);
  const clearLongPress = () => {
    if (longPress.current !== null) clearTimeout(longPress.current);
    longPress.current = null;
  };
  const openPalette = (tag: DemoTag) => { clearLongPress(); setEditingTag(tag); };
  const beginLongPress = (tag: DemoTag, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") return;
    clearLongPress();
    longPress.current = setTimeout(() => {
      suppressNextClick.current = tag;
      openPalette(tag);
    }, 550);
  };
  useEffect(() => {
    if (!editingTag) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditingTag(null);
    };
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
  useEffect(() => () => clearLongPress(), []);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const included = DEMO_TAGS.filter(name => filters[name] === "include");
    const excluded = DEMO_TAGS.filter(name => filters[name] === "exclude");
    // A beat can have several tags. Inclusion means "has ANY included tag";
    // exclusion takes precedence: "has NONE of the excluded tags".
    const beats = DEMO_BEATS.filter(item =>
      (included.length === 0 || included.some(name => item.tags.includes(name))) &&
      !excluded.some(name => item.tags.includes(name)) &&
      (!query || [item.title, ...item.tags, item.key, String(item.bpm)]
        .some(value => value.toLocaleLowerCase().includes(query)))
    );
    if (sort === "name") return [...beats].sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "bpm") return [...beats].sort((a, b) => a.bpm - b.bpm);
    if (sort === "stars") return [...beats].sort((a, b) => b.stars - a.stars);
    if (sort === "date") return [...beats].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return beats;
  }, [search, filters, sort]);

  const cycleTag = (name: DemoTag) => setFilters(current => {
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
        <LabToolbar search={search} onSearchChange={setSearch} sort={sort} onSortChange={setSort}
          selecting={selectMode} onToggleSelect={() => { if (selectMode) clearSelection(); else setSelectMode(true); }}
          onProfileAction={action => setToolbarNotice(action === "settings" ? "Settings: preview only." : "Log out: preview only; no session is active.")} />
      </header>
      {toolbarNotice && <div className="lab-gallery-toolbar-notice" role="status">{toolbarNotice}
        <button type="button" aria-label="Dismiss notice" onClick={() => setToolbarNotice("")}>×</button>
      </div>}
      <div className="lab-gallery-tag-bar" role="group" aria-label="Tag filters">
        <button type="button" className={Object.keys(filters).length === 0 ? "lab-gallery-tag is-included" : "lab-gallery-tag"}
          aria-pressed={Object.keys(filters).length === 0} onClick={() => setFilters({})}>All</button>
        {DEMO_TAGS.map(name => {
          const state = filters[name] ?? "idle";
          const color = tagColors[name];
          return <div key={name} className="lab-gallery-tag-wrap"
            ref={editingTag === name ? paletteRef : undefined}>
            <button type="button" className={`lab-gallery-tag is-${state}`}
              style={color ? { "--lab-tag-color": color } as CSSProperties : undefined}
              onClick={() => {
                if (suppressNextClick.current === name) {
                  suppressNextClick.current = null;
                  return;
                }
                cycleTag(name);
              }}
              onContextMenu={event => {
                event.preventDefault();
                openPalette(name);
              }}
              onPointerDown={event => beginLongPress(name,event)}
              onPointerUp={clearLongPress}
              onPointerCancel={clearLongPress}
              onPointerLeave={clearLongPress}
              onKeyDown={event => {
                if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                  event.preventDefault();openPalette(name);
                }
              }}
              title="Clic para filtrar · clic derecho o mantener para cambiar color"
              aria-pressed={state === "include"}
              aria-label={`${name}: ${state}. Click to filter; right-click, long-press or Shift+F10 to change color.`}>{name}</button>
            {editingTag === name && <div className="lab-tag-color-popover"
              role="group" aria-label={`Colores de ${name}`}>
              <div className="lab-tag-color-swatches">
                {TAG_PALETTE.map(option => <button type="button"
                  key={option.hex} className={color === option.hex ? "is-current" : ""}
                  style={{background: option.hex}} title={option.name}
                  aria-label={option.name} aria-pressed={color === option.hex}
                  onClick={() => {
                    setTagColors(current => ({...current,[name]:option.hex}));
                    setEditingTag(null);
                  }}/>)}
              </div>
              <button type="button" className="lab-tag-color-none"
                onClick={() => {
                  setTagColors(current => {
                    const next={...current};delete next[name];return next;
                  });
                  setEditingTag(null);
                }}>Sin color</button>
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
            <LabBeatTile beat={item} coverMode={coverMode} tagColors={tagColors}
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
