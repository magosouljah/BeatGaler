import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { LabBeatTile, LabButton } from "../shared/components";
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
  const toolbarFloatRef = useRef<HTMLDivElement>(null);
  const tagStackRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const toolbar = toolbarFloatRef.current;
    const stack = tagStackRef.current;
    if (!toolbar || !stack) return;
    const sync = () => {
      const style = getComputedStyle(toolbar);
      const baseTop = parseFloat(style.top) || 20;
      const tokenGap = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue("--lab-space-2")) || 8;
      // Align the rightmost lens 10px inside the rightmost first-row beat,
      // irrespective of the number of columns at this viewport size.
      const grid = document.querySelector<HTMLElement>(".lab-gallery-grid");
      const items = Array.from(grid?.children ?? []) as HTMLElement[];
      const first = items[0]?.getBoundingClientRect();
      if (first) {
        const row = items.map(item => item.getBoundingClientRect())
          .filter(rect => Math.abs(rect.top-first.top) <= 2);
        const lastRight = Math.max(...row.map(rect => rect.right));
        toolbar.style.right = Math.max(0, window.innerWidth - lastRight + 10) + "px";
      }
      const tagsBottom = stack.getBoundingClientRect().top + (window.matchMedia("(max-width: 750px)").matches ? 46 : 50);
      const coverTarget = first ? first.top + 10 : baseTop;
      const finalTop = tagsVisible ? Math.max(baseTop, tagsBottom + tokenGap, coverTarget) : baseTop;
      // CSS transitions the transform from its current painted value, so
      // rapidly closing/reopening the bar never teleports the Studio optics.
      toolbar.style.setProperty("--gallery-tags-push", (finalTop - baseTop) + "px");
    };
    sync();
    const observer = new ResizeObserver(sync);
    const grid = document.querySelector(".lab-gallery-grid");
    if (grid) observer.observe(grid);
    window.addEventListener("resize",sync,{passive:true});
    window.addEventListener("scroll",sync,{passive:true});
    return () => {
      observer.disconnect();
      window.removeEventListener("resize",sync);
      window.removeEventListener("scroll",sync);
    };
  }, [tagsVisible]);
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
    <div className="lab-gallery-page">
      <div ref={tagStackRef} className="lab-gallery-top-stack" data-tags-open={tagsVisible ? "true" : "false"} data-tag-variant={tagBarVariant}>
        <TagNavigation visible={tagsVisible} hasActiveFilters={hasActiveFilters} onVisibilityChange={setTagsOpen}
          filters={filters} onCycleTag={cycleTag} onClear={() => setFilters({})}
          tagColors={tagColors} setTagColors={setTagColors} />
      </div>
      <div className="lab-gallery-tag-shadow" aria-hidden="true" />
      <div ref={toolbarFloatRef} className="lab-gallery-toolbar-float">
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
      <GalleryPlayer beat={beat} playing={playing} onToggle={toggle} onPlayBeat={selectBeat} coverMode={coverMode} />
    </div>
  );
}
