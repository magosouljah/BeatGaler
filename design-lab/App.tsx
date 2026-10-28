import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { LabArtwork, LabBeatTile, LabButton, LabField, LabPanel, LabPlayer, LabTag } from "./components";
import { DEMO_BEATS } from "./data";
import type { DemoBeat } from "./data";

type View = "components" | "landing" | "gallery";
const TABS: { id: View; label: string }[] = [
  { id: "components", label: "Components" },
  { id: "landing", label: "Landing" },
  { id: "gallery", label: "Gallery" },
];

const DEFAULT_COLORS = {
  canvas: "#090909",
  surface: "#101010",
  raised: "#151515",
  ink: "#f2f2f2",
  secondary: "#b0b0b0",
  accent: "#c8b7ff",
};
type ColorKey = keyof typeof DEFAULT_COLORS;
type ColorValues = Record<ColorKey, string>;
const COLOR_CONTROLS: { id: ColorKey; label: string; status: string }[] = [
  { id: "canvas", label: "Canvas", status: "Existente" },
  { id: "surface", label: "Surface", status: "Existente" },
  { id: "raised", label: "Raised", status: "Existente" },
  { id: "ink", label: "Ink", status: "Existente" },
  { id: "secondary", label: "Secondary", status: "Existente" },
  { id: "accent", label: "Accent", status: "Propuesta" },
];

function LabMark() {
  return <span className="lab-mark" aria-hidden="true"><span /><span /><span /></span>;
}

function Intro({ kicker, title, description }: { kicker: string; title: string; description: string }) {
  return <div className="lab-intro"><span className="lab-kicker">{kicker}</span><h1>{title}</h1><p>{description}</p></div>;
}

function ComponentPage({ playing, beat, toggle, selectBeat }: {
  playing: boolean; beat: DemoBeat; toggle: () => void; selectBeat: (beat: DemoBeat) => void;
}) {
  const [demoText, setDemoText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [filter, setFilter] = useState("All");
  return (
    <>
      <Intro kicker="01 / SYSTEM" title="The building blocks." description="Componentes básicos y estados de diseño. Todo es ficticio; los cambios no afectan la aplicación." />
      <div className="lab-components-grid">
        <LabPanel title="Buttons">
          <div className="lab-inline">
            <LabButton variant="primary" onClick={() => selectBeat(DEMO_BEATS[1])}>Primary</LabButton>
            <LabButton variant="secondary" onClick={toggle}>Secondary</LabButton>
            <LabButton variant="ghost" onClick={() => setFilter("All")}>Ghost</LabButton>
            <LabButton variant="danger" onClick={() => setErrorText("Este es un ejemplo de mensaje, sin acción real.")}>Danger</LabButton>
          </div>
          <div className="lab-inline lab-inline--spaced">
            <LabButton disabled>Disabled</LabButton>
            <LabButton loading>Loading</LabButton>
            <LabButton hero variant="primary" onClick={toggle}>Hero action</LabButton>
          </div>
          <p className="lab-hint">Altura estándar 44px · CTA hero 52px · foco exterior visible.</p>
        </LabPanel>
        <LabPanel title="Inputs & feedback">
          <LabField label="Search demo" id="components-search" placeholder="Type a title…" value={demoText} onChange={e => setDemoText(e.target.value)} />
          <LabField label="Validation demo" id="components-validation" placeholder="Enter any value…" value={errorText} aria-invalid={errorText.length > 0} onChange={e => setErrorText(e.target.value)} hint="Los ejemplos no se envían a ningún servicio." />
          {errorText && <div role="status" className="lab-feedback">Estado de ejemplo: {errorText}</div>}
        </LabPanel>
        <LabPanel title="Tags & filters">
          <div className="lab-inline">
            {["All", "Ambient", "Trap", "Electronic"].map(item => <LabTag key={item} active={filter === item} onClick={() => setFilter(item)}>{item}</LabTag>)}
          </div>
          <p className="lab-hint">Área táctil de filtros ≥44px · selección por forma y contraste.</p>
        </LabPanel>
        <LabPanel title="Panels & artwork">
          <div className="lab-panel-artwork">
            <LabArtwork beat={DEMO_BEATS[0]} />
            <div><strong>Afterimage</strong><span>Artwork procedural de muestra</span><LabTag>Ambient</LabTag></div>
          </div>
        </LabPanel>
        <LabPanel title="Beat cards">
          <div className="lab-mini-grid">
            {DEMO_BEATS.slice(0, 2).map(item => <LabBeatTile beat={item} key={item.id} selected={playing && beat.id === item.id} onPlay={selectBeat} />)}
          </div>
        </LabPanel>
        <LabPanel title="Player / simulated">
          <LabPlayer beat={beat} playing={playing} onToggle={toggle} />
          <p className="lab-hint">Progreso ilustrativo, sin audio, timers, streaming ni archivos.</p>
        </LabPanel>
      </div>
    </>
  );
}

function LandingPage({ openGallery }: { openGallery: () => void }) {
  return (
    <div className="lab-landing">
      <header className="lab-landing-nav">
        <span className="lab-brand"><LabMark /> BeatGaler</span>
        <LabButton variant="ghost" onClick={openGallery}>Explore the gallery</LabButton>
      </header>
      <main className="lab-landing-hero">
        <div className="lab-landing-copy">
          <span className="lab-kicker">YOUR SOUND, IN ITS OWN SPACE</span>
          <h1>Make space for your sound.</h1>
          <p>A private canvas for beats, ideas, and the next thing you create.</p>
          <LabButton variant="primary" hero onClick={openGallery}>Explore demo gallery <span aria-hidden="true">↗</span></LabButton>
          <span className="lab-note">Concept study · No account required · Fictional content</span>
        </div>
        <div className="lab-landing-composition" aria-label="Composición estática de portadas ficticias">
          {DEMO_BEATS.slice(0, 5).map((item, index) => (
            <div className={`lab-orbit-item lab-orbit-item--${index + 1}`} key={item.id}>
              <LabArtwork beat={item} />
            </div>
          ))}
          <span className="lab-orbit-caption">COLLECTION / STUDY 01</span>
        </div>
      </main>
      <div className="lab-landing-bottom"><span>01 / FIRST EXPLORATION</span><span>Quiet UI. Loud ideas.</span></div>
    </div>
  );
}

function GalleryPage({ playing, beat, toggle, selectBeat }: {
  playing: boolean; beat: DemoBeat; toggle: () => void; selectBeat: (beat: DemoBeat) => void;
}) {
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("All");
  const [sort, setSort] = useState("default");
  const filtered = useMemo(() => {
    const query = search.toLocaleLowerCase().trim();
    const result = DEMO_BEATS.filter(b =>
      (tag === "All" || b.tag === tag) &&
      (!query || [b.title, b.artist, b.tag, b.key].some(v => v.toLocaleLowerCase().includes(query)))
    );
    if (sort === "name") return [...result].sort((a, b) => a.title.localeCompare(b.title));
    if (sort === "bpm") return [...result].sort((a, b) => a.bpm - b.bpm);
    return result;
  }, [search, tag, sort]);
  return (
    <div className="lab-gallery">
      <div className="lab-gallery-head">
        <span className="lab-brand"><LabMark /> BeatGaler</span>
        <span className="lab-gallery-status">DESIGN STUDY / DEMO</span>
      </div>
      <div className="lab-gallery-body">
        <Intro kicker="02 / YOUR LIBRARY" title="Gallery." description="A quiet place for what you make. This library contains invented beats only." />
        <div className="lab-gallery-tools">
          <LabField id="gallery-search" label="Search demo beats" type="search" placeholder="Search beats…" value={search} onChange={e => setSearch(e.target.value)} />
          <div className="lab-gallery-sort">
            <label htmlFor="gallery-sort">Sort by</label>
            <select className="lab-field" id="gallery-sort" value={sort} onChange={e => setSort(e.target.value)}>
              <option value="default">Recently added</option>
              <option value="name">Name</option>
              <option value="bpm">BPM</option>
            </select>
          </div>
        </div>
        <div className="lab-gallery-filter" aria-label="Filter by genre">
          {["All", "Ambient", "Trap", "Electronic"].map(item => <LabTag key={item} active={tag === item} onClick={() => setTag(item)}>{item}</LabTag>)}
        </div>
        <div className="lab-gallery-count">{filtered.length} demo {filtered.length === 1 ? "beat" : "beats"}</div>
        {filtered.length > 0 ? (
          <div className="lab-gallery-grid">{filtered.map(item => <LabBeatTile beat={item} key={item.id} onPlay={selectBeat} selected={playing && beat.id === item.id} />)}</div>
        ) : (
          <section className="lab-empty" role="status"><strong>No demo beats found.</strong><p>Try another search or reset the filter.</p><LabButton onClick={() => {setTag("All");setSearch("");}}>Clear filters</LabButton></section>
        )}
      </div>
      <LabPlayer beat={beat} playing={playing} onToggle={toggle} />
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("components");
  const [colors, setColors] = useState<ColorValues>({ ...DEFAULT_COLORS });
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState<DemoBeat>(DEMO_BEATS[0]);
  const setSelectedBeat = (selected: DemoBeat) => {
    if (beat.id === selected.id) setPlaying(value => !value);
    else { setBeat(selected); setPlaying(true); }
  };
  const cssTokens = {
    "--lab-canvas": colors.canvas,
    "--lab-surface": colors.surface,
    "--lab-raised": colors.raised,
    "--lab-ink": colors.ink,
    "--lab-secondary": colors.secondary,
    "--lab-accent": colors.accent,
  } as CSSProperties;
  return (
    <div className="lab-root" style={cssTokens}>
      <header className="lab-shell-header">
        <div><span className="lab-brand"><LabMark /> BeatGaler</span><span className="lab-shell-header__label">Design Lab / v0.1</span></div>
        <span className="lab-label-pill">ISOLATED MOCK · NO REAL DATA</span>
      </header>
      <div className="lab-shell-layout">
        <div className="lab-content">
          <nav className="lab-tabs" aria-label="Design Lab previews">
            {TABS.map(tab => <button type="button" key={tab.id} className="lab-tab" aria-current={view === tab.id ? "page" : undefined} onClick={() => setView(tab.id)}>{tab.label}</button>)}
          </nav>
          <div className="lab-preview" key={view}>
            {view === "components" && <ComponentPage beat={beat} playing={playing} toggle={() => setPlaying(x => !x)} selectBeat={setSelectedBeat} />}
            {view === "landing" && <LandingPage openGallery={() => setView("gallery")} />}
            {view === "gallery" && <GalleryPage beat={beat} playing={playing} toggle={() => setPlaying(x => !x)} selectBeat={setSelectedBeat} />}
          </div>
        </div>
        <aside className="lab-tokens" aria-label="Editable Design Lab tokens">
          <div className="lab-tokens__top"><span className="lab-kicker">LIVE TOKENS</span><h2>Experiment freely.</h2><p>Los colores cambian en las tres vistas. Solo en memoria, nunca en producción.</p></div>
          <div className="lab-token-list">
            {COLOR_CONTROLS.map(control => (
              <label className="lab-token" key={control.id}>
                <span className="lab-token__name">{control.label}<small>{control.status}</small></span>
                <span className="lab-token__value">{colors[control.id]}</span>
                <input type="color" aria-label={`Editar ${control.label}`} value={colors[control.id]}
                  onChange={e => setColors(prev => ({...prev, [control.id]: e.target.value}))} />
              </label>
            ))}
          </div>
          <LabButton variant="secondary" className="lab-reset" onClick={() => setColors({ ...DEFAULT_COLORS })}>Restablecer tokens</LabButton>
          <div className="lab-tokens__footer"><span className="lab-token-dot" /> Accent is experimental and unapproved.<p>Si cambias colores, vuelve a comprobar contrastes WCAG AA.</p></div>
        </aside>
      </div>
    </div>
  );
}
