import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
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

export function LabBeatTile({ beat, selected, onPlay, coverMode }: {
  beat: DemoBeat; coverMode: CoverMode;
  selected: boolean;
  onPlay: (beat: DemoBeat) => void;
}) {
  return (
    <article className="lab-beat-tile">
      <div className="lab-beat-tile__cover">
        <LabArtwork beat={beat} coverMode={coverMode} />
        <button
          type="button"
          className="lab-beat-tile__play"
          aria-label={selected ? `Pausar simulación de ${beat.title}` : `Simular reproducción de ${beat.title}`}
          aria-pressed={selected}
          onClick={() => onPlay(beat)}
        >{selected ? "Ⅱ" : "▶"}</button>
      </div>
      <div className="lab-beat-tile__meta">
        <div className="lab-beat-tile__title" title={beat.title}>{beat.title}</div>
        <div className="lab-beat-tile__artist" title={beat.artist}>{beat.artist}</div>
        <div className="lab-beat-tile__details"><span>{beat.tag}</span><span>{beat.bpm} BPM</span></div>
      </div>
    </article>
  );
}

export function LabPlayer({ beat, playing, onToggle, coverMode }: {
  beat: DemoBeat; coverMode: CoverMode;
  playing: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="lab-player" aria-label="Reproductor visual ficticio, sin audio">
      <div className="lab-player__track">
        <LabArtwork beat={beat} coverMode={coverMode} />
        <div className="lab-player__description">
          <strong title={beat.title}>{beat.title}</strong>
          <span>{beat.artist}</span>
        </div>
      </div>
      <div className="lab-player__control">
        <button type="button" className="lab-player__toggle" onClick={onToggle} aria-pressed={playing}
          aria-label={playing ? "Pausar simulación" : "Iniciar simulación"}>
          {playing ? "Ⅱ" : "▶"}
        </button>
        <div className="lab-player__progress" aria-hidden="true"><span style={{ width: playing ? "32%" : "18%" }} /></div>
        <span className="lab-player__time">{playing ? "0:52" : "0:00"} / {beat.duration}</span>
      </div>
      <span className="lab-player__fake">DEMO · SIN AUDIO</span>
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
