import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { CoverMode } from "../shared/coverSources";
import Player from "./Player";
import LabToolbar from "../shared/Toolbar";
import LabToolbarV2 from "../shared/ToolbarV2";
import type { LabSort } from "../shared/Toolbar";
import { SAMPLE_BEATS } from "./fixtures";
import type { Beat } from "./fixtures";
import "./master.css";

type Section = "margins" | "playbar" | "toolbar";
const SIDEBAR_START = 192; // Lab navigation only; not a BeatGaler product design token.
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 300;
const SIDEBAR_HIDE_AT = 136;

function initialSidebarWidth() {
  try {
    const stored = Number(window.localStorage.getItem("beatgaler.lab.master.sidebar-width"));
    return stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX ? stored : SIDEBAR_START;
  } catch { return SIDEBAR_START; }
}
function initialSidebarOpen() {
  try {
    return window.innerWidth > 800 && window.localStorage.getItem("beatgaler.lab.master.sidebar-hidden") !== "yes";
  } catch { return true; }
}

export default function MasterPage({ coverMode, setCoverMode }: {
  coverMode: CoverMode;
  setCoverMode: (mode: CoverMode) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0.32);
  const [volume, setVolume] = useState(0.65);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<"off" | "all" | "one">("off");
  const [queueIds, setQueueIds] = useState<string[]>([SAMPLE_BEATS[1].id, SAMPLE_BEATS[2].id]);
  const [showQueue, setShowQueue] = useState(false);
  const [message, setMessage] = useState("");
  const beats = useMemo<Beat[]>(() => SAMPLE_BEATS.map(b => ({ ...b, coverMode })), [coverMode]);
  const beat = beats[selected];
  const queue = beats.filter(b => queueIds.includes(b.id));
  const choose = useCallback((index: number) => { setSelected((index + SAMPLE_BEATS.length) % SAMPLE_BEATS.length); setProgress(0); }, []);
  const next = useCallback(() => {
    if (shuffleEnabled) choose(Math.floor(Math.random() * SAMPLE_BEATS.length));
    else if (selected + 1 >= SAMPLE_BEATS.length && repeatMode === "off") { setPlaying(false); setProgress(1); }
    else choose(selected + 1);
  }, [choose, selected, shuffleEnabled, repeatMode]);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setProgress(p => Math.min(1, p + 0.25 / beat.duration));
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing, beat.duration]);
  useEffect(() => {
    if (!playing || progress < 1) return;
    if (repeatMode === "one") setProgress(0);
    else next();
  }, [progress, playing, repeatMode, next]);
  const queueBeat = (item: Beat) => {
    setQueueIds(ids => ids.includes(item.id) ? ids : [...ids, item.id]);
    setMessage(`Añadido a la cola de prueba: ${item.name}`);
  };
  const [section, setSection] = useState<Section>("playbar");
  const [toolbarSearch, setToolbarSearch] = useState("");
  const [toolbarSort, setToolbarSort] = useState<LabSort>("manual");
  const [toolbarSelecting, setToolbarSelecting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const dragActive = useRef(false);
  const dragClientX = useRef(SIDEBAR_START);

  useEffect(() => {
    try { window.localStorage.setItem("beatgaler.lab.master.sidebar-width", String(sidebarWidth)); }
    catch { /* Preferences are optional. */ }
  }, [sidebarWidth]);
  useEffect(() => {
    // A responsive auto-collapse is not a permanent preference on desktop.
    if (window.matchMedia("(max-width: 800px)").matches) return;
    try { window.localStorage.setItem("beatgaler.lab.master.sidebar-hidden", sidebarOpen ? "no" : "yes"); }
    catch { /* Preferences are optional. */ }
  }, [sidebarOpen]);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 800px)");
    const collapseOnNarrow = (event: MediaQueryListEvent) => {
      if (event.matches) setSidebarOpen(false);
    };
    narrow.addEventListener("change", collapseOnNarrow);
    return () => narrow.removeEventListener("change", collapseOnNarrow);
  }, []);

  const openSection = (value: Section) => {
    setSection(value);
    setMessage("");
    if (window.matchMedia("(max-width: 800px)").matches) setSidebarOpen(false);
  };
  const onResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragClientX.current = event.clientX;
    dragActive.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActive.current) return;
    dragClientX.current = event.clientX;
    if (event.clientX >= SIDEBAR_HIDE_AT) {
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(event.clientX))));
    }
  };
  const onResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragActive.current) return;
    dragActive.current = false;
    if (dragClientX.current < SIDEBAR_HIDE_AT) setSidebarOpen(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home" || event.key === "Escape") {
      event.preventDefault();
      setSidebarOpen(false);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth(width => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width + (event.key === "ArrowLeft" ? -8 : 8))));
    }
  };

  return (
    <div className={`lab-master-shell ${sidebarOpen ? "is-sidebar-open" : "is-sidebar-closed"}`}
      style={{ "--master-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      {sidebarOpen ? (
        <aside className="lab-master-sidebar" aria-label="Navegación de MASTER">
          <div className="lab-master-sidebar-header">
            <strong>MASTER</strong>
            <button type="button" className="lab-master-sidebar-toggle" onClick={() => setSidebarOpen(false)} aria-label="Ocultar navegación" title="Ocultar navegación">‹</button>
          </div>
          <nav className="lab-master-sidebar-nav" aria-label="Secciones del Design System">
            <div className="lab-master-sidebar-heading">REGLAS</div>
            <button type="button" className={section === "margins" ? "is-active" : ""} aria-current={section === "margins" ? "page" : undefined} onClick={() => openSection("margins")}>Márgenes</button>
            <div className="lab-master-sidebar-heading">COMPONENTES</div>
            <button type="button" className={section === "playbar" ? "is-active" : ""} aria-current={section === "playbar" ? "page" : undefined} onClick={() => openSection("playbar")}>Playbar</button>
            <button type="button" className={section === "toolbar" ? "is-active" : ""} aria-current={section === "toolbar" ? "page" : undefined} onClick={() => openSection("toolbar")}>Toolbar</button>
          </nav>
          <div className="lab-master-resize-handle" role="separator" tabIndex={0} aria-label="Cambiar ancho de navegación"
            aria-orientation="vertical" aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={sidebarWidth}
            title="Arrastra para cambiar ancho. Lleva a la izquierda para ocultar. Flechas para ajustar."
            onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd} onLostPointerCapture={() => { dragActive.current = false; }}
            onKeyDown={onResizeKeyDown}/>
        </aside>
      ) : (
        <button type="button" className="lab-master-open-nav" aria-label="Mostrar navegación de MASTER"
          title="Mostrar navegación" onClick={() => setSidebarOpen(true)}>☰</button>
      )}
      <main className="lab-master-workspace" aria-label={section === "playbar" ? "Vista del componente Playbar" : section === "toolbar" ? "Vista del componente Toolbar" : "Vista de la regla Márgenes"}>
        {section === "playbar" ? (
          <div className="lab-master-specimens">
            <div className="lab-master-player-frame">
              <Player preview
                      beat={beat} playing={playing} progress={progress} duration={beat.duration} volume={volume}
                      queue={queue} currentIndex={queue.findIndex(b => b.id === beat.id)}
                      showQueue={showQueue} canShowQueue={queue.length > 0} shuffleEnabled={shuffleEnabled} repeatMode={repeatMode}
                      onToggle={() => { if (progress >= 1) setProgress(0); setPlaying(p => !p); }}
                      onSeek={setProgress} onPrev={() => choose(selected - 1)} onNext={next} onVolumeChange={setVolume}
                      onToggleShuffle={() => setShuffleEnabled(v => !v)}
                      onCycleRepeat={() => setRepeatMode(v => v === "off" ? "all" : v === "all" ? "one" : "off")}
                      onToggleQueue={() => setShowQueue(v => !v)}
                      onPlayQueueIndex={i => { const at = beats.findIndex(b => b.id === queue[i]?.id); if (at >= 0) { choose(at); setPlaying(true); } setShowQueue(false); }}
                      canAddBeat onAddBeat={() => queueBeat(beat)} onAddToQueue={queueBeat}
                      onDetail={b => setMessage(`Detalle de prueba: ${b.name}`)}
                      onEdit={b => setMessage(`Editar ${b.name}: todavía no se ha añadido este componente.`)}
                      onDelete={() => setMessage("La biblioteca ficticia no elimina archivos.")}
                    />
            </div>
          </div>
        ) : section === "toolbar" ? (
          <div className="lab-master-specimens">
            <div className="lab-master-toolbar-frame">
              <LabToolbar search={toolbarSearch} onSearchChange={setToolbarSearch} sort={toolbarSort} onSortChange={setToolbarSort}
                selecting={toolbarSelecting} onToggleSelect={() => setToolbarSelecting(value => !value)}
                onProfileAction={action => setMessage(action === "settings" ? "Settings: solo demostración." : "Log out: no hay sesión real en DESIGN.")} />
            </div>
            <div style={{display:"grid",gap:24,marginTop:48,justifyItems:"center"}}>
              <div style={{fontSize:11,letterSpacing:".11em",opacity:.52}}>TOOLBAR V2 · GLASS</div>
              <div style={{display:"grid",gap:22,width:"min(100%,520px)"}}>
                {(["#303034","#050506","linear-gradient(#ef91bc 50%,#09090d 50%)","linear-gradient(#ef91bc 39%,#09090d 39%)","#ef91bc"] as const).map((background,i)=>(
                  <div key={i} style={{background,borderRadius:18,padding:"48px 18px",display:"flex",justifyContent:"center",minHeight:144}}>
                    <ToolbarV2Sample onProfileAction={action => setMessage(action === "settings" ? "Settings: solo demostración." : "Log out: no hay sesión real en DESIGN.")}/>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="lab-master-specimens">
            <div className="lab-master-margin-example" aria-label="Muestra de márgenes del área de trabajo">
              <div className="lab-master-margin-inner" />
            </div>
          </div>
        )}
        {message && (
          <div className="lab-master-feedback" role="status">{message}
            <button type="button" onClick={() => setMessage("")} aria-label="Cerrar aviso">×</button>
          </div>
        )}
      </main>
    </div>
  );
}

/* Each optical-background specimen has its own interaction state and focus. */
function ToolbarV2Sample({onProfileAction}:{onProfileAction:(action:"settings"|"logout")=>void}) {
  const [search,setSearch] = useState("");
  const [sort,setSort] = useState<LabSort>("manual");
  const [selecting,setSelecting] = useState(false);
  return <LabToolbarV2 search={search} onSearchChange={setSearch} sort={sort} onSortChange={setSort}
    selecting={selecting} onToggleSelect={()=>setSelecting(v=>!v)} onProfileAction={onProfileAction}/>;
}
