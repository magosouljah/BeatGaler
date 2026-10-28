import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import { LabArtwork, LabBeatTile, LabButton, LabField, LabPanel, LabPlayer, LabTag } from "./components";
import { DEMO_BEATS } from "./data";
import type { DemoBeat } from "./data";
import { getCoverSrc, REAL_COVER_COUNT } from "./coverSources";
import type { CoverMode } from "./coverSources";

type View = "landing" | "gallery" | "components";
const COVER_BLACK = "#0c0c0c"; // Same color as BeatGaler's proceduralBeatBackground.ts
const ORBIT_IDS = Array.from({ length: 24 }, (_, i) => "landing-orbit-" + String(i + 1).padStart(2, "0"));

const DEFAULT_COLORS = {
  canvas: COVER_BLACK, surface: "#101010", raised: "#151515",
  ink: "#f2f2f2", secondary: "#b0b0b0", accent: "#c8b7ff",
};
type ColorKey = keyof typeof DEFAULT_COLORS;
type Colors = Record<ColorKey, string>;
const COLOR_LABELS: { key: ColorKey; title: string }[] = [
  { key: "surface", title: "Surface" }, { key: "raised", title: "Raised" },
  { key: "ink", title: "Ink" }, { key: "secondary", title: "Secondary" },
  { key: "accent", title: "Accent (experimental)" },
];

function Brand({ onClick }: { onClick: () => void }) {
  return <button type="button" className="lab-brand-link" onClick={onClick} aria-label="Back to BeatGaler landing">beat galer</button>;
}

function Orbit({ coverMode }: { coverMode: CoverMode }) {
  const stage = useRef<HTMLDivElement>(null);
  const cards = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let paused = reduced.matches;
    let frame = 0;
    let angle = 0;
    let last: number | null = null;

    // The geometry follows the user's original circular landing, with a tighter
    // ellipse and a much shallower size difference between back and front covers.
    const paint = (time: number) => {
      if (last === null) last = time;
      const elapsed = Math.min(time - last, 45);
      last = time;
      if (!paused) angle += elapsed * 0.000075;
      const w = element.clientWidth;
      const h = element.clientHeight;
      const mobile = w <= 720;
      const count = mobile ? 15 : ORBIT_IDS.length;
      const size = mobile ? Math.min(105, Math.max(72, w * 0.23)) : Math.min(156, Math.max(112, w * 0.105));
      const rx = Math.min(w * (mobile ? 0.39 : 0.37), mobile ? 242 : 545);
      const ry = Math.min(h * (mobile ? 0.34 : 0.315), mobile ? 248 : 268);
      const cy = h * (mobile ? 0.51 : 0.49);

      cards.current.forEach((card, index) => {
        if (!card) return;
        if (index >= count) { card.style.display = "none"; return; }
        card.style.display = "block";
        const theta = index * Math.PI * 2 / count + angle - Math.PI / 2;
        const co = Math.cos(theta);
        const si = Math.sin(theta);
        const depth = (si + 1) / 2;
        // 0.79–1.06 instead of 0.54–1.09: the rear covers never become tiny.
        const scale = 0.79 + depth * 0.27;
        const tilt = mobile ? -0.065 : -0.15;
        const dx = co * rx;
        const dy = si * ry;
        const x = w / 2 + dx * Math.cos(tilt) - dy * Math.sin(tilt);
        const y = cy + dx * Math.sin(tilt) + dy * Math.cos(tilt);
        const rotation = -co * (mobile ? 12 : 18);
        card.style.width = size + "px";
        card.style.height = size + "px";
        card.style.transform = `translate3d(${x - size / 2}px,${y - size / 2}px,0) rotateY(${rotation}deg) rotateZ(${-co * 4}deg) scale(${scale})`;
        card.style.zIndex = String(Math.floor(depth * 15) + 1);
        card.style.opacity = String(0.57 + depth * 0.4);
        card.style.filter = `brightness(${0.73 + depth * 0.28})`;
      });
      if (!paused) frame = requestAnimationFrame(paint);
    };
    const stopForMotion = (event: MediaQueryListEvent) => {
      paused = event.matches;
      if (!paused) { last = null; frame = requestAnimationFrame(paint); }
      else { cancelAnimationFrame(frame); paint(performance.now()); }
    };
    reduced.addEventListener("change", stopForMotion);
    frame = requestAnimationFrame(paint);
    const resize = new ResizeObserver(() => { if (paused) paint(performance.now()); });
    resize.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      reduced.removeEventListener("change", stopForMotion);
      resize.disconnect();
    };
  }, []);

  const pictures = useMemo(() => ORBIT_IDS.map((id, index) => {
    try { return { id, src: getCoverSrc(id, coverMode, index) }; }
    catch { return { id, src: null }; }
  }), [coverMode]);

  return (
    <div ref={stage} className="lab-landing-orbit" aria-hidden="true">
      {pictures.map((picture, i) => (
        <div key={picture.id} ref={node => { cards.current[i] = node; }} className="lab-landing-cover">
          {picture.src && <img src={picture.src} alt="" draggable={false} />}
        </div>
      ))}
    </div>
  );
}

function LandingPage({ goHome, openGallery, coverMode }: { goHome: () => void; openGallery: () => void; coverMode: CoverMode }) {
  return (
    <div className="lab-landing-page">
      <header className="lab-landing-header">
        <Brand onClick={goHome} />
        <button className="lab-login" type="button" onClick={openGallery} title="Open the fictional gallery demo">Log in</button>
      </header>
      <main className="lab-landing-hero">
        <Orbit coverMode={coverMode} />
        <div className="lab-center-scrim" aria-hidden="true" />
        <section className="lab-landing-center" aria-labelledby="lab-hero-title">
          <h1 id="lab-hero-title">BeatGaler</h1>
          <p>Unlimited cloud storage for your beats. Organize everything with tags, metadata, and cover art. Profiles and sharing coming soon.</p>
          <LabButton className="lab-create" variant="primary" size="hero" shape="pill" trailingIcon={<span>→</span>} onClick={openGallery}>Create ur Galer</LabButton>
        </section>
      </main>
    </div>
  );
}

function GalleryPage({ goHome, playing, beat, toggle, selectBeat, coverMode }: {
  goHome: () => void; playing: boolean; beat: DemoBeat; coverMode: CoverMode; toggle: () => void;
  selectBeat: (beat: DemoBeat) => void;
}) {
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("All");
  const [sort, setSort] = useState("default");
  const filtered = useMemo(() => {
    const query = search.toLocaleLowerCase().trim();
    const rows = DEMO_BEATS.filter(item =>
      (tag === "All" || item.tag === tag) &&
      (!query || [item.title, item.artist, item.tag, item.key].some(v => v.toLocaleLowerCase().includes(query)))
    );
    if (sort === "name") return [...rows].sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "bpm") return [...rows].sort((a, b) => a.bpm - b.bpm);
    return rows;
  }, [search, tag, sort]);
  return (
    <div className="lab-gallery-page">
      <header className="lab-internal-header">
        <Brand onClick={goHome} />
        <button className="lab-back" type="button" onClick={goHome}>← Landing</button>
      </header>
      <main className="lab-gallery-main">
        <div className="lab-gallery-heading">
          <div><span className="lab-quiet-label">PRIVATE LIBRARY / DEMO</span><h1>Your Galer</h1><p>Your beats, organized in one place.</p></div>
          <span className="lab-demo-label">Fictional beats only</span>
        </div>
        <div className="lab-gallery-tools">
          <LabField label="Search beats" id="lab-gallery-search" type="search" placeholder="Search beats…" value={search} onChange={e => setSearch(e.target.value)} />
          <div className="lab-field-group lab-gallery-sort"><label htmlFor="lab-gallery-sort">Sort by</label>
            <select id="lab-gallery-sort" className="lab-field" value={sort} onChange={e => setSort(e.target.value)}>
              <option value="default">Recently added</option><option value="name">Name</option><option value="bpm">BPM</option>
            </select>
          </div>
        </div>
        <div className="lab-gallery-chips" aria-label="Filter beats by genre">
          {["All", "Ambient", "Trap", "Electronic"].map(value => <LabTag key={value} active={tag === value} onClick={() => setTag(value)}>{value}</LabTag>)}
        </div>
        <span className="lab-gallery-count">{filtered.length} {filtered.length === 1 ? "beat" : "beats"}</span>
        {filtered.length ? (
          <div className="lab-gallery-grid">
            {filtered.map(item => <LabBeatTile key={item.id} beat={item} coverMode={coverMode} selected={playing && item.id === beat.id} onPlay={selectBeat} />)}
          </div>
        ) : <div className="lab-empty" role="status"><strong>No beats found.</strong><p>Try another search or filter.</p><LabButton onClick={() => { setSearch(""); setTag("All"); }}>Clear filters</LabButton></div>}
        <div className="lab-gallery-player"><LabPlayer beat={beat} coverMode={coverMode} playing={playing} onToggle={toggle} /></div>
      </main>
    </div>
  );
}

function ComponentPage({ goHome, colors, setColors, playing, beat, toggle, selectBeat, coverMode, setCoverMode }: {
  goHome: () => void; colors: Colors; setColors: Dispatch<SetStateAction<Colors>>;
  coverMode: CoverMode; setCoverMode: (mode: CoverMode) => void;
  playing: boolean; beat: DemoBeat; toggle: () => void; selectBeat: (beat: DemoBeat) => void;
}) {
  const [example, setExample] = useState("");
  const [filter, setFilter] = useState("All");
  return (
    <div className="lab-master-page">
      <header className="lab-internal-header">
        <Brand onClick={goHome} />
        <button type="button" className="lab-back" onClick={goHome}>← Landing</button>
      </header>
      <main className="lab-master-main">
        <div className="lab-master-heading"><span className="lab-quiet-label">ISOLATED DESIGN LAB / MASTER</span><h1>Design foundations</h1><p>Componentes ficticios y tokens de laboratorio. Nada se guarda en producción.</p></div>
        <div className="lab-master-grid">
          <LabPanel title="Colors & tokens" className="lab-master-wide">
            <div className="lab-token-grid">
              <div className="lab-fixed-token"><span>Artwork black · locked</span><strong>#0c0c0c</strong><i style={{ background: COVER_BLACK }} /></div>
              {COLOR_LABELS.map(({key,title}) => <label className="lab-token-control" key={key}>
                <span>{title}</span><code>{colors[key]}</code>
                <input type="color" value={colors[key]} aria-label={`Edit ${title}`} onChange={e => setColors(prev => ({ ...prev, [key]: e.target.value }))}/>
              </label>)}
            </div>
            <LabButton className="lab-reset" onClick={() => setColors({ ...DEFAULT_COLORS })}>Restablecer tokens</LabButton>
          </LabPanel>
          <LabPanel title="Artwork mode" className="lab-master-wide">
            <fieldset className="lab-cover-modes">
              <legend>Sample cover source</legend>
              <label className={coverMode === "generated" ? "lab-cover-mode is-active" : "lab-cover-mode"}>
                <input type="radio" name="lab-cover-source" value="generated" checked={coverMode === "generated"} onChange={() => setCoverMode("generated")} />
                Generated
              </label>
              <label className={coverMode === "real" ? "lab-cover-mode is-active" : "lab-cover-mode"}>
                <input type="radio" name="lab-cover-source" value="real" checked={coverMode === "real"} onChange={() => setCoverMode("real")} />
                Real covers
              </label>
            </fieldset>
            <p className="lab-cover-note" role="status">{REAL_COVER_COUNT} local real covers · shared across Landing, Gallery and MASTER. {REAL_COVER_COUNT === 0 ? "Import covers to enable the visual comparison; Generated remains the fallback." : "The 24-slot orbit repeats covers when needed."}</p>
          </LabPanel>
          <LabPanel title="Buttons">
            <div className="lab-inline"><LabButton variant="primary" onClick={() => selectBeat(DEMO_BEATS[1])}>Primary</LabButton><LabButton onClick={toggle}>Secondary</LabButton><LabButton variant="ghost" onClick={() => setFilter("All")}>Ghost</LabButton><LabButton variant="danger" onClick={() => setExample("Demo error")}>Danger</LabButton></div>
            <div className="lab-inline"><LabButton disabled>Disabled</LabButton><LabButton loading>Loading</LabButton><LabButton size="hero" shape="pill" variant="primary" trailingIcon={<span>→</span>} onClick={toggle}>Hero action</LabButton></div>
          </LabPanel>
          <LabPanel title="Inputs & filters">
            <LabField label="Input demo" id="master-input" value={example} onChange={e => setExample(e.target.value)} placeholder="Type a title…" hint="Local-only example." />
            <div className="lab-inline">{["All", "Ambient", "Trap", "Electronic"].map(item => <LabTag key={item} active={filter === item} onClick={() => setFilter(item)}>{item}</LabTag>)}</div>
          </LabPanel>
          <LabPanel title="Artwork from BeatGaler">
            <div className="lab-panel-artwork"><LabArtwork beat={DEMO_BEATS[0]} coverMode={coverMode} /><div><strong>Afterimage</strong><span>{coverMode === "generated" ? "Original procedural generator · bg-v1" : "Local real cover sample"}</span><LabTag>Ambient</LabTag></div></div>
          </LabPanel>
          <LabPanel title="Beat card & player">
            <div className="lab-mini-grid"><LabBeatTile beat={DEMO_BEATS[1]} coverMode={coverMode} selected={playing && beat.id === DEMO_BEATS[1].id} onPlay={selectBeat}/></div>
            <div className="lab-master-player"><LabPlayer beat={beat} coverMode={coverMode} playing={playing} onToggle={toggle}/></div>
          </LabPanel>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("landing");
  const [coverMode, setCoverMode] = useState<CoverMode>(() => {
    try { return window.sessionStorage.getItem("beatgaler.lab.cover-mode") === "real" ? "real" : "generated"; }
    catch { return "generated"; }
  });
  useEffect(() => {
    try { window.sessionStorage.setItem("beatgaler.lab.cover-mode", coverMode); } catch { /* storage disabled */ }
  }, [coverMode]);
  const [colors, setColors] = useState<Colors>({ ...DEFAULT_COLORS });
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState<DemoBeat>(DEMO_BEATS[0]);
  const selectBeat = (selected: DemoBeat) => {
    if (beat.id === selected.id) setPlaying(value => !value);
    else { setBeat(selected); setPlaying(true); }
  };
  const tokens = {
    "--lab-canvas": COVER_BLACK,
    "--lab-surface": colors.surface,
    "--lab-raised": colors.raised,
    "--lab-ink": colors.ink,
    "--lab-secondary": colors.secondary,
    "--lab-accent": colors.accent,
  } as CSSProperties;
  return (
    <div className="lab-root" style={tokens}>
      {view === "landing" && <LandingPage goHome={() => setView("landing")} openGallery={() => setView("gallery")} coverMode={coverMode} />}
      {view === "gallery" && <GalleryPage goHome={() => setView("landing")} coverMode={coverMode} beat={beat} playing={playing} toggle={() => setPlaying(x => !x)} selectBeat={selectBeat} />}
      {view === "components" && <ComponentPage goHome={() => setView("landing")} colors={colors} setColors={setColors} coverMode={coverMode} setCoverMode={setCoverMode} beat={beat} playing={playing} toggle={() => setPlaying(x => !x)} selectBeat={selectBeat} />}
      {view !== "components" && <button type="button" className="lab-master-switch" onClick={() => setView("components")} aria-label="Open internal design components">MASTER</button>}
    </div>
  );
}
