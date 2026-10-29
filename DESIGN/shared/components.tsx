import { useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import type { DemoBeat } from "./data";
import { getCoverSrc } from "./coverSources";
import type { CoverMode } from "./coverSources";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg" | "hero";
type ButtonShape = "rounded" | "pill";
type LabButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  trailingIcon?: ReactNode;
  loading?: boolean;
};
export function LabButton({ variant = "secondary", size = "sm", shape = "rounded", trailingIcon, loading = false, className = "", disabled, children, ...props }: LabButtonProps) {
  return (
    <button {...props} type={props.type ?? "button"} disabled={disabled || loading} aria-busy={loading || undefined}
      className={["lab-button", `lab-button--${variant}`, `lab-button--${size}`, `lab-button--${shape}`, loading && "lab-button--loading", className].filter(Boolean).join(" ")}>
      <span className="lab-button__content">
        <span className="lab-button__label">{children}</span>
        {trailingIcon && <span className="lab-button__icon" aria-hidden="true">{trailingIcon}</span>}
      </span>
      {loading && <span className="lab-spinner" aria-hidden="true" />}
    </button>
  );
}

export function LabTag({ active = false, children, onClick }: {
  active?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  if (onClick) return <button type="button" className="lab-chip lab-chip--interactive" aria-pressed={active} onClick={onClick}>{children}</button>;
  return <span className="lab-chip">{children}</span>;
}

export function LabArtwork({ beat, coverMode, className = "" }: { beat: DemoBeat; coverMode: CoverMode; className?: string }) {
  // Generated calls exact bg-v1; real artwork uses local bundled images only.
  let artwork: string | null = null;
  try { artwork = getCoverSrc(beat.id, coverMode, Math.max(0, Number(beat.id.slice(-2)) - 1)); } catch { /* canvas unavailable */ }
  return (
    <div className={`lab-artwork ${className}`} aria-hidden="true">
      {artwork && <img src={artwork} alt="" draggable={false} />}
    </div>
  );
}


export function LabBeatTile({ beat, selected, onPlay, coverMode, tagColor }: {
  beat: DemoBeat; coverMode: CoverMode; tagColor?: string;
  selected: boolean; onPlay: (beat: DemoBeat) => void;
}) {
  return (
    <article className="lab-beat-tile">
      <div className="lab-beat-tile__cover">
        <LabArtwork beat={beat} coverMode={coverMode} />
        <button type="button" className="lab-beat-tile__play"
          aria-label={selected ? `Pause ${beat.title} demo` : `Play ${beat.title} demo`}
          aria-pressed={selected} onClick={() => onPlay(beat)}>
          {selected ? "Ⅱ" : "▶"}
        </button>
      </div>
      <div className="lab-beat-tile__meta">
        <div className="lab-beat-tile__title" title={beat.title}>{beat.title}</div>
        <div className="lab-beat-tile__tags"><span className="lab-beat-tile__tag" style={tagColor ? { color:tagColor, borderColor: `${tagColor}77`, background: `${tagColor}19` } : undefined}>{beat.tag}</span></div>
        <div className="lab-beat-tile__details">{beat.key}<span aria-hidden="true">·</span>{beat.bpm} BPM</div>
      </div>
    </article>
  );
}

type PlayerIconName = "shuffle"|"previous"|"play"|"pause"|"next"|"repeat"|"queue"|"volume"|"more";
function PlayerIcon({ name }: { name: PlayerIconName }) {
  const common = { width:20, height:20, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:1.8, strokeLinecap:"round" as const, strokeLinejoin:"round" as const, "aria-hidden":true as const };
  if(name==="play") return <svg {...common}><path d="M8 5.5 19 12 8 18.5z" fill="currentColor" stroke="none" /></svg>;
  if(name==="pause") return <svg {...common}><path d="M8 5v14M16 5v14" strokeWidth="3" /></svg>;
  if(name==="previous"||name==="next") return <svg {...common}><path d={name==="previous"?"M17 5 7 12l10 7z":"M7 5l10 7-10 7z"} fill="currentColor" stroke="none" /><path d={name==="previous"?"M6 5v14":"M18 5v14"} strokeWidth="2.4" /></svg>;
  if(name==="shuffle") return <svg {...common}><path d="M3 6h3c6 0 6 12 12 12h3M18 15l3 3-3 3M3 18h3c2 0 3.5-2 5-4M15 8c1-1.5 2-2 3-2h3M18 3l3 3-3 3"/></svg>;
  if(name==="repeat") return <svg {...common}><path d="M4 9V7a3 3 0 0 1 3-3h12l-3-3m3 3-3 3M20 15v2a3 3 0 0 1-3 3H5l3 3m-3-3 3-3"/></svg>;
  if(name==="queue") return <svg {...common}><path d="M3 6h18M3 12h13M3 18h10M17 16l5 3-5 3z" /></svg>;
  if(name==="volume") return <svg {...common}><path d="M3 9v6h4l5 4V5L7 9H3ZM16 9c2 1.5 2 4.5 0 6M19 6c4 3 4 9 0 12"/></svg>;
  return <svg {...common}><circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>;
}

export function LabPlayer({ beat, playing, onToggle, coverMode, beats = [], onPlayBeat, variant = "preview" }: {
  beat: DemoBeat; coverMode: CoverMode; playing: boolean; onToggle: () => void;
  beats?: readonly DemoBeat[]; onPlayBeat?: (beat: DemoBeat) => void; variant?: "dock"|"preview";
}) {
  const root = useRef<HTMLElement>(null);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off"|"all"|"one">("off");
  const [progress, setProgress] = useState(32);
  const [volume, setVolume] = useState(65);
  const [popover, setPopover] = useState<"queue"|"volume"|"more"|null>(null);
  const [queueItems, setQueueItems] = useState<readonly DemoBeat[]>([]);
  useEffect(() => { setProgress(32); }, [beat.id]);
  useEffect(() => {
    if(!popover) return;
    const closeKey=(e:KeyboardEvent)=>{ if(e.key==="Escape") setPopover(null); };
    const closeOutside=(e:PointerEvent)=>{ if(!root.current?.contains(e.target as Node)) setPopover(null); };
    document.addEventListener("keydown",closeKey);
    document.addEventListener("pointerdown",closeOutside);
    return ()=>{document.removeEventListener("keydown",closeKey);document.removeEventListener("pointerdown",closeOutside);};
  },[popover]);
  const choose=(offset:number)=>{
    if(!onPlayBeat || !beats.length) return;
    const i=Math.max(0,beats.findIndex(item=>item.id===beat.id));
    const next=shuffle ? beats[(i+3)%beats.length] : beats[(i+offset+beats.length)%beats.length];
    onPlayBeat(next);
  };
  const togglePopover=(next:"queue"|"volume"|"more")=>setPopover(open=>open===next?null:next);
  const addToQueue=()=>setQueueItems(current=>[...current,beat]);
  const percent=Math.min(100,Math.max(0,progress));
  const durationSeconds=Number(beat.duration.split(":")[0])*60+Number(beat.duration.split(":")[1]);
  const stamp=Math.round(durationSeconds*percent/100);
  const elapsed=`${Math.floor(stamp/60)}:${String(stamp%60).padStart(2,"0")}`;
  return (
    <section ref={root} className={`lab-player lab-player--${variant}`} aria-label="BeatGaler player preview, no audio">
      <div className="lab-player__transport">
        <button type="button" className={`lab-player__icon ${shuffle?"is-active":""}`} aria-label="Shuffle" aria-pressed={shuffle} onClick={()=>setShuffle(x=>!x)}><PlayerIcon name="shuffle"/></button>
        <button type="button" className="lab-player__icon" aria-label="Previous beat" onClick={()=>choose(-1)}><PlayerIcon name="previous"/></button>
        <button type="button" className="lab-player__icon lab-player__toggle" aria-label={playing?"Pause preview":"Play preview"} aria-pressed={playing} onClick={onToggle}><PlayerIcon name={playing?"pause":"play"}/></button>
        <button type="button" className="lab-player__icon" aria-label="Next beat" onClick={()=>choose(1)}><PlayerIcon name="next"/></button>
        <button type="button" className={`lab-player__icon ${repeat!=="off"?"is-active":""}`} aria-label={`Repeat: ${repeat}`} onClick={()=>setRepeat(current=>current==="off"?"all":current==="all"?"one":"off")}><PlayerIcon name="repeat"/>{repeat==="one"&&<span className="lab-player__repeat-one">1</span>}</button>
      </div>
      <div className="lab-player__now">
        <LabArtwork beat={beat} coverMode={coverMode} />
        <div className="lab-player__track-data">
          <div className="lab-player__track-top"><strong title={beat.title}>{beat.title}</strong><span>{elapsed} / {beat.duration}</span></div>
          <div className="lab-player__subtitle">{beat.key} · {beat.bpm} BPM</div>
          <input className="lab-player__seek" aria-label="Demo playback position" type="range" min="0" max="100" value={percent} onChange={e=>setProgress(Number(e.target.value))} style={{"--lab-player-progress":`${percent}%`} as CSSProperties}/>
        </div>
      </div>
      <div className="lab-player__utilities">
        <button type="button" className="lab-player__icon lab-player__add" aria-label="Add current beat to demo queue" onClick={addToQueue}>+</button>
        <div className="lab-player__popover-holder">
          <button type="button" className={`lab-player__icon ${popover==="queue"?"is-active":""}`} aria-expanded={popover==="queue"} aria-label="Up next" onClick={()=>togglePopover("queue")}><PlayerIcon name="queue"/></button>
          {popover==="queue"&&<div className="lab-player__popover lab-player__queue"><strong>Up Next</strong>{queueItems.length?queueItems.map((item,i)=><button type="button" key={i} onClick={()=>{onPlayBeat?.(item);setQueueItems(rows=>rows.filter((_,j)=>j!==i));setPopover(null);}}>{item.title}</button>):<span>Queue is empty</span>}</div>}
        </div>
        <div className="lab-player__popover-holder">
          <button type="button" className={`lab-player__icon ${popover==="volume"?"is-active":""}`} aria-expanded={popover==="volume"} aria-label="Volume" onClick={()=>togglePopover("volume")}><PlayerIcon name="volume"/></button>
          {popover==="volume"&&<div className="lab-player__popover lab-player__volume"><label htmlFor="lab-volume-range">Volume {volume}%</label><input id="lab-volume-range" aria-label="Demo volume" type="range" min="0" max="100" value={volume} onChange={e=>setVolume(Number(e.target.value))}/></div>}
        </div>
        <div className="lab-player__popover-holder">
          <button type="button" className="lab-player__icon" aria-label="More beat information" aria-expanded={popover==="more"} onClick={()=>togglePopover("more")}><PlayerIcon name="more"/></button>
          {popover==="more"&&<div className="lab-player__popover lab-player__more"><strong>{beat.title}</strong><span>{beat.key} · {beat.bpm} BPM</span><span>Visual preview only · no audio</span></div>}
        </div>
      </div>
    </section>
  );
}

export function LabField({ label, id, hint, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; hint?: string; error?: string }) {
  const describedBy = [props["aria-describedby"], hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="lab-field-group">
      <label htmlFor={id}>{label}</label>
      <input {...props} id={id} className="lab-field" aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={describedBy} />
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && <small id={`${id}-error`} className="lab-field-error" role="alert">{error}</small>}
    </div>
  );
}

export function LabPanel({ title, children, className = "", ...props }: HTMLAttributes<HTMLElement> & { title: string; children: ReactNode }) {
  return <section {...props} className={["lab-panel", className].filter(Boolean).join(" ")}><h3>{title}</h3>{children}</section>;
}
