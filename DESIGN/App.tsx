import { useEffect, useState } from "react";
import { DEMO_BEATS } from "./shared/data";
import type { DemoBeat } from "./shared/data";
import type { CoverMode } from "./shared/coverSources";
import LandingPage from "./LANDING/LandingPage";
import GalleryPage from "./GALLERY/GalleryPage";
import MasterPage from "./MASTER/MasterPage";
type View = "landing" | "gallery" | "components";

export default function App() {
  const [view, setView] = useState<View>("landing");
  const [coverMode, setCoverMode] = useState<CoverMode>(() => {
    try { return window.sessionStorage.getItem("beatgaler.lab.cover-mode") === "real" ? "real" : "generated"; }
    catch { return "generated"; }
  });
  useEffect(() => {
    try { window.sessionStorage.setItem("beatgaler.lab.cover-mode", coverMode); } catch { /* storage disabled */ }
  }, [coverMode]);
  const [tagColors, setTagColors] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState<DemoBeat>(DEMO_BEATS[0]);
  const selectBeat = (selected: DemoBeat) => {
    if (beat.id === selected.id) setPlaying(value => !value);
    else { setBeat(selected); setPlaying(true); }
  };
  return (
    <div className="lab-root">
      {view === "landing" && <LandingPage goHome={() => setView("landing")} openGallery={() => setView("gallery")} coverMode={coverMode} />}
      {view === "gallery" && <GalleryPage coverMode={coverMode} beat={beat} playing={playing} toggle={() => setPlaying(x => !x)} selectBeat={selectBeat} tagColors={tagColors} setTagColors={setTagColors} />}
      {view === "components" && <MasterPage coverMode={coverMode} setCoverMode={setCoverMode} />}
      <nav className="lab-dev-switches" aria-label="Design Lab-only navigation">
        <button type="button" aria-current={view === "landing" ? "page" : undefined} onClick={() => setView("landing")}>Landing</button>
        <button type="button" aria-current={view === "components" ? "page" : undefined} onClick={() => setView("components")}>MASTER</button>
      </nav>
    </div>
  );
}
