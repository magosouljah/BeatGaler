import { useEffect, useMemo, useRef, useState } from "react";
import "../shared/tokens.css";
import "./landing.css";
import { getProceduralBeatBackgroundDataUrl } from "../../../lib/proceduralBeatBackground";
const ORBIT_IDS = Array.from({ length: 24 }, (_, i) => "landing-orbit-" + String(i + 1).padStart(2, "0"));

function Orbit({ stopped }: { stopped: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const cards = useRef<Array<HTMLDivElement | null>>([]);
  const pausedByUser = useRef(stopped);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => { pausedByUser.current = stopped; refresh.current(); }, [stopped]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let paused = reduced.matches || pausedByUser.current || document.hidden;
    let frame = 0;
    let angle = 0;
    let last: number | null = null;
    let pointer: { x: number; y: number } | null = null;
    let initialized = false;
    const positions = ORBIT_IDS.map(() => ({ x: 0, y: 0 }));
    const onPointerMove = (event: PointerEvent) => {
      if (paused || event.pointerType === "touch") return;
      const bounds = element.getBoundingClientRect();
      pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      if (paused) paint(performance.now());
    };
    const onPointerLeave = () => { pointer = null; if (paused) paint(performance.now()); };
    element.addEventListener("pointermove", onPointerMove, { passive: true });
    element.addEventListener("pointerleave", onPointerLeave, { passive: true });

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
        let x = w / 2 + dx * Math.cos(tilt) - dy * Math.sin(tilt);
        let y = cy + dx * Math.sin(tilt) + dy * Math.cos(tilt);
        // Original landing: covers gently repel away from the pointer.
        if (pointer && !reduced.matches) {
          const deltaX = x - pointer.x;
          const deltaY = y - pointer.y;
          const distance = Math.hypot(deltaX, deltaY);
          const reach = mobile ? 120 : 205;
          if (distance > 0.01 && distance < reach) {
            const force = (1 - distance / reach) ** 2 * (mobile ? 45 : 105);
            x += deltaX / distance * force;
            y += deltaY / distance * force;
          }
        }
        const position = positions[index];
        if (!initialized) { position.x = x; position.y = y; }
        else { position.x += (x - position.x) * 0.19; position.y += (y - position.y) * 0.19; }
        const rotation = -co * (mobile ? 12 : 18);
        card.style.width = size + "px";
        card.style.height = size + "px";
        card.style.transform = `translate3d(${position.x - size / 2}px,${position.y - size / 2}px,0) rotateY(${rotation}deg) rotateZ(${-co * 4}deg) scale(${scale})`;
        card.style.zIndex = String(Math.floor(depth * 15) + 1);
        card.style.opacity = String(0.57 + depth * 0.4);
        card.style.filter = `brightness(${0.73 + depth * 0.28})`;
      });
      initialized = true;
      if (!paused) frame = requestAnimationFrame(paint);
    };
    const stopForMotion = (event: { matches: boolean }) => {
      cancelAnimationFrame(frame);
      paused = event.matches || pausedByUser.current || document.hidden;
      if (!paused) { last = null; frame = requestAnimationFrame(paint); }
      else { cancelAnimationFrame(frame); paint(performance.now()); }
    };
    const visibility = () => stopForMotion({ matches: reduced.matches });
    refresh.current = visibility;
    document.addEventListener("visibilitychange", visibility);
    reduced.addEventListener("change", stopForMotion);
    frame = requestAnimationFrame(paint);
    const resize = new ResizeObserver(() => { if (paused) paint(performance.now()); });
    resize.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      reduced.removeEventListener("change", stopForMotion);
      document.removeEventListener("visibilitychange", visibility);
      resize.disconnect();
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      refresh.current = () => {};
    };
  }, []);

  const pictures = useMemo(() => ORBIT_IDS.map((id, index) => {
    try { return { id, src: getProceduralBeatBackgroundDataUrl(id) }; }
    catch { return { id, src: null }; }
  }), []);

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


export default function LandingPage() {
  const [stopped, setStopped] = useState(false);
  return <div className="bg-design lab-landing-page" data-public-page-ready="true">
    <header className="lab-landing-header">
      <a className="lab-brand-link" href="/" aria-label="BeatGaler home">beat galer</a>
      <a className="lab-login" href="/gallery">Log in</a>
    </header>
    <main className="lab-landing-hero">
      <Orbit stopped={stopped} />
      <div className="lab-center-scrim" aria-hidden="true" />
      <section className="lab-landing-center" aria-labelledby="lab-hero-title">
        <h1 id="lab-hero-title">BeatGaler</h1>
        <p>Unlimited cloud storage for your beats. Organize everything with tags, metadata, and cover art. Profiles and sharing coming soon.</p>
        <a className="lab-button lab-button--primary lab-button--hero lab-button--pill lab-create" href="/signup">
          <span className="lab-button__content"><span className="lab-button__label">Create Gallery</span><span className="lab-button__icon" aria-hidden="true">→</span></span>
        </a>
      </section>
      <button className="lab-orbit-pause" type="button" aria-pressed={stopped} onClick={() => setStopped(value => !value)}>{stopped ? "Resume motion" : "Pause motion"}</button>
    </main>
  </div>;
}
