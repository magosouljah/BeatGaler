import { useEffect, useState } from "react";
import { LabButton } from "./components";
import { DEMO_BEATS } from "./data";
import type { DemoBeat } from "./data";
import GalleryPage from "./GalleryPage";
import type { CoverMode } from "./coverSources";
import MasterPage from "./system/MasterPage";
import Orbit from "./motion/Orbit";
import { DEFAULT_COLORS, DEFAULT_FOUNDATIONS, toLabVariables } from "./system/foundations";
import type { FoundationSettings, Colors } from "./system/foundations";

type View = "landing" | "gallery" | "components";
const COVER_BLACK = "#0c0c0c"; // Same color as BeatGaler's proceduralBeatBackground.ts

function Brand({ onClick }: { onClick: () => void }) {
  return <button type="button" className="lab-brand-link" onClick={onClick} aria-label="Back to BeatGaler landing">beat galer</button>;
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
  const [settings, setSettings] = useState<FoundationSettings>({ ...DEFAULT_FOUNDATIONS });
  const [tagColors, setTagColors] = useState<Record<string,string>>({});
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState<DemoBeat>(DEMO_BEATS[0]);
  const selectBeat = (selected: DemoBeat) => {
    if (beat.id === selected.id) setPlaying(value => !value);
    else { setBeat(selected); setPlaying(true); }
  };
  const tokens = toLabVariables(colors, settings);
  return (
    <div className="lab-root" style={tokens}>
      {view === "landing" && <LandingPage goHome={() => setView("landing")} openGallery={() => setView("gallery")} coverMode={coverMode} />}
      {view === "gallery" && <GalleryPage coverMode={coverMode} beat={beat} playing={playing} toggle={() => setPlaying(x => !x)} selectBeat={selectBeat} tagColors={tagColors} setTagColors={setTagColors} />}
      {view === "components" && <MasterPage colors={colors} setColors={setColors} settings={settings} setSettings={setSettings} coverMode={coverMode} setCoverMode={setCoverMode} beat={beat} playing={playing} toggle={() => setPlaying(x => !x)} selectBeat={selectBeat} onNavigate={setView} />}
      <nav className="lab-dev-switches" aria-label="Design Lab-only navigation">
        <button type="button" aria-current={view === "landing" ? "page" : undefined} onClick={() => setView("landing")}>Landing</button>
        <button type="button" aria-current={view === "components" ? "page" : undefined} onClick={() => setView("components")}>MASTER</button>
      </nav>
    </div>
  );
}
