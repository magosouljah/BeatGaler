import { useMemo, useState } from "react";
import { LabBeatTile, LabButton, LabPlayer } from "../shared/components";
import { DEMO_BEATS, DEMO_TAGS } from "../shared/data";
import type { DemoBeat, DemoTag } from "../shared/data";
import type { CoverMode } from "../shared/coverSources";
import LabToolbar from "../shared/Toolbar";
import type { LabSort } from "../shared/Toolbar";

type TagFilter = "include" | "exclude";

export default function GalleryPage({ playing, beat, toggle, selectBeat, coverMode }: {
  playing: boolean; beat: DemoBeat; toggle: () => void; selectBeat: (beat: DemoBeat) => void;
  coverMode: CoverMode;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LabSort>("manual");
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [filters, setFilters] = useState<Partial<Record<DemoTag, TagFilter>>>({});
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

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
          return <button type="button" key={name} className={`lab-gallery-tag is-${state}`}
            onClick={() => cycleTag(name)}
            aria-pressed={state === "include"}
            aria-label={`${name}: ${state}. Activate to cycle included, excluded, off.`}>{name}</button>;
        })}
      </div>
      {selectMode && selected.length > 0 && <div className="lab-gallery-selection-status" role="status">
        {selected.length} selected <button type="button" onClick={() => setSelected([])}>Clear selection</button>
      </div>}
      <main className="lab-gallery-main">
        {filtered.length ? <div className="lab-gallery-grid">
          {filtered.map(item => <div className="lab-gallery-item" key={item.id}>
            <LabBeatTile beat={item} coverMode={coverMode}
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
