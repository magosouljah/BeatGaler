import { useCallback, useEffect, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { LabBeatTile, LabButton } from "../shared/components";
import { BeatTagPeekLayer, useBeatTagPeek } from "../shared/BeatTagPeek";
import { DEMO_BEATS, DEMO_TAGS } from "../shared/data";
import type { DemoBeat, DemoTag } from "../shared/data";
import type { CoverMode } from "../shared/coverSources";
import StudioToolbarCandidate from "../MASTER/StudioToolbarCandidate";
import TagNavigation from "./TagNavigation";
import GalleryPlayer from "./GalleryPlayer";
import type { TagBarVariant } from "../shared/tagBarVariant";
import type { LabSort } from "../shared/ToolbarV2";

type TagFilter = "include" | "exclude";
export default function GalleryPage({ playing, beat, toggle, selectBeat, coverMode, tagBarVariant, tagColors, setTagColors }: {
  playing: boolean; beat: DemoBeat; toggle: () => void; selectBeat: (beat: DemoBeat) => void;
  coverMode: CoverMode; tagBarVariant: TagBarVariant; tagColors: Record<string, string>;
  setTagColors: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const [search, setSearch] = useState("");
  const tagPeek = useBeatTagPeek();
  const openBeatActions = useCallback((item: DemoBeat) => setToolbarNotice(`Acciones de ${item.title}: pendientes en Studio.`), []);

  const [tagsOpen, setTagsOpen] = useState(() => typeof window !== "undefined" &&
    window.matchMedia("(hover: none), (pointer: coarse)").matches);
  const [hintSeen, setHintSeen] = useState(() => {
    try { return sessionStorage.getItem("beatgaler.lab.tags-hint-seen") === "yes"; }
    catch { return false; }
  });
  const [sort, setSort] = useState<LabSort>("manual");
  const [toolbarNotice, setToolbarNotice] = useState("");
  const [filters, setFilters] = useState<Partial<Record<DemoTag, TagFilter>>>({});
  const hasActiveFilters = Object.values(filters).some(Boolean);
  const tagsVisible = tagsOpen || hasActiveFilters;
  useEffect(() => {
    if(!tagsVisible || hintSeen) return;
    setHintSeen(true);
    try { sessionStorage.setItem("beatgaler.lab.tags-hint-seen","yes"); }
    catch { /* storage optional */ }
  }, [tagsVisible, hintSeen]);
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

  const cycleTag = (name: DemoTag, exclude: boolean) => setFilters(current => {
    const next = { ...current };
    const requested: TagFilter = exclude ? "exclude" : "include";
    // Click toggles inclusion; Alt+click toggles exclusion. Neither gesture
    // cycles through the opposite mode.
    if (next[name] === requested) delete next[name];
    else next[name] = requested;
    return next;
  });
  const clearSelection = () => { setSelected([]); setSelectMode(false); };
  const toggleSelection = (id: string) => setSelected(current =>
    current.includes(id) ? current.filter(item => item !== id) : [...current, id]
  );
  return (
    <div className="lab-gallery-page" data-tags-open={tagsVisible ? "true" : "false"}>
      <div className="lab-gallery-top-stack" data-tags-open={tagsVisible ? "true" : "false"} data-tag-variant={tagBarVariant}>
        <TagNavigation visible={tagsVisible} hasActiveFilters={hasActiveFilters} onVisibilityChange={setTagsOpen}
          filters={filters} onCycleTag={cycleTag} onClear={() => setFilters({})}
          tagColors={tagColors} setTagColors={setTagColors} />
      </div>
      <div className="lab-gallery-tag-shadow" aria-hidden="true" />
      <div className="lab-gallery-toolbar-float">
          <StudioToolbarCandidate gallery galleryTagsOpen={tagsVisible} search={search} onSearchChange={setSearch}
            sort={sort} onSortChange={setSort}
            selecting={selectMode} onToggleSelect={() => { if (selectMode) clearSelection(); else setSelectMode(true); }}
            onProfileAction={action => setToolbarNotice(action === "settings" ? "Settings: preview only." : "Log out: preview only; no session is active.")} />
      </div>
      {!hintSeen && <div className="lab-gallery-tag-cue" aria-hidden="true">Tags ↑</div>}
      {toolbarNotice && <div className="lab-gallery-toolbar-notice" role="status">{toolbarNotice}
        <button type="button" aria-label="Dismiss notice" onClick={() => setToolbarNotice("")}>×</button>
      </div>}
      {selectMode && selected.length > 0 && <div className="lab-gallery-selection-status" role="status">
        {selected.length} selected <button type="button" onClick={() => setSelected([])}>Clear selection</button>
      </div>}
      <main className="lab-gallery-main">
        {filtered.length ? <div className="lab-gallery-grid" onPointerOver={tagPeek.onPointerOver} onPointerOut={tagPeek.onPointerOut}
          onFocusCapture={tagPeek.onFocusCapture} onBlurCapture={tagPeek.onBlurCapture}>
          {filtered.map(item => <div className="lab-gallery-item" key={item.id}>
            <LabBeatTile beat={item} coverMode={coverMode} tagColors={tagColors}
              selected={playing && item.id === beat.id} onPlay={selectBeat} onMore={openBeatActions} />
            {selectMode && <label className="lab-gallery-select">
              <input type="checkbox" aria-label={`Select ${item.title}`} checked={selected.includes(item.id)} onChange={() => toggleSelection(item.id)} />
            </label>}
          </div>)}
        </div> : <div className="lab-empty" role="status"><strong>No beats found</strong>
          <LabButton onClick={() => { setSearch(""); setFilters({}); }}>Clear filters</LabButton></div>}
      </main>
      <BeatTagPeekLayer peek={tagPeek.peek} />
      <GalleryPlayer beat={beat} playing={playing} onToggle={toggle} onPlayBeat={selectBeat} coverMode={coverMode} />
    </div>
  );
}
