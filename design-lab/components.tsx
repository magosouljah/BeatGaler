import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import type { DemoBeat } from "./data";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type LabButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  hero?: boolean;
  loading?: boolean;
};

export function LabButton({ variant = "secondary", hero = false, loading = false, className = "", disabled, children, ...props }: LabButtonProps) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={["lab-button", `lab-button--${variant}`, hero && "lab-button--hero", className].filter(Boolean).join(" ")}
    >
      {loading ? <span className="lab-spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
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

export function LabArtwork({ beat, className = "" }: { beat: DemoBeat; className?: string }) {
  return (
    <div className={`lab-artwork lab-artwork--${beat.art} ${className}`} aria-hidden="true">
      <div className="lab-artwork__halo" />
      <div className="lab-artwork__arc" />
      <span className="lab-artwork__monogram">{beat.monogram}</span>
      <span className="lab-artwork__edition">BG / STUDY 0{beat.id.slice(-1)}</span>
    </div>
  );
}

export function LabBeatTile({ beat, selected, onPlay }: {
  beat: DemoBeat;
  selected: boolean;
  onPlay: (beat: DemoBeat) => void;
}) {
  return (
    <article className="lab-beat-tile">
      <div className="lab-beat-tile__cover">
        <LabArtwork beat={beat} />
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

export function LabPlayer({ beat, playing, onToggle }: {
  beat: DemoBeat;
  playing: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="lab-player" aria-label="Reproductor visual ficticio, sin audio">
      <div className="lab-player__track">
        <LabArtwork beat={beat} />
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
