import { useEffect, useId, useRef } from "react";
import "./shape-glass.css";

/**
 * Rounded-rectangle displacement / specular mapping adapted from:
 * https://github.com/archisvaze/liquid-glass (MIT, Copyright 2026 Archis Vaze).
 *
 * Unlike the old two fixed circular SVG arcs, both optical maps are generated
 * from the actual border radius and current width of the element.
 * No WebGL, screenshots, network calls, or production dependencies.
 */
type Maps = { displacement: string; specular: string; scale: number };
const mapCache = new Map<string, Maps>();
const CACHE_LIMIT = 180;

function surfaceHeight(t: number) {
  return Math.pow(1 - Math.pow(1 - t, 4), 0.25);
}

function refractiveProfile(thickness: number, bezel: number, ior: number) {
  const eta = 1 / ior;
  return Array.from({ length: 96 }, (_, i) => {
    const t = i / 96;
    const y = surfaceHeight(t);
    const next = surfaceHeight(Math.min(1, t + .0001));
    const slope = (next - y) / .0001;
    const mag = Math.hypot(slope, 1);
    const nx = -slope / mag, ny = -1 / mag;
    const factor = Math.sqrt(Math.max(0, 1 - eta * eta * (1 - ny * ny)));
    const rx = -(eta * ny + factor) * nx;
    const ry = eta - (eta * ny + factor) * ny;
    return Math.abs(ry) < .0001 ? 0 : rx * ((y * bezel + thickness) / ry);
  });
}

function generateMaps(width: number, height: number, angleStep: number): Maps | null {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  const key = w + ":" + h + ":" + angleStep;
  const cached = mapCache.get(key);
  if (cached) return cached;
  const r = Math.min(w, h) / 2;
  const bezel = Math.max(1, Math.min(5, r - 1));
  const profile = refractiveProfile(4, bezel, 1.42);
  const maximum = Math.max(1, ...profile.map(Math.abs));
  const lightAngle = .8 + angleStep * (Math.PI / 24);
  const lightX = Math.cos(lightAngle), lightY = Math.sin(lightAngle);
  const displacementCanvas = document.createElement("canvas");
  const specularCanvas = document.createElement("canvas");
  displacementCanvas.width = specularCanvas.width = w;
  displacementCanvas.height = specularCanvas.height = h;
  const dispCtx = displacementCanvas.getContext("2d");
  const specCtx = specularCanvas.getContext("2d");
  if (!dispCtx || !specCtx) return null;
  const disp = dispCtx.createImageData(w, h);
  const spec = specCtx.createImageData(w, h);
  const dd = disp.data, sd = spec.data;
  // Neutral 128/128 is zero displacement, including the flat interior.
  for (let k = 0; k < dd.length; k += 4) {
    dd[k] = 128; dd[k + 1] = 128; dd[k + 3] = 255;
  }
  const straightW = w - 2 * r;
  const straightH = h - 2 * r;
  for (let y = 0; y < h; y++) {
    const py = y < r ? y - r : y >= h - r ? y - r - straightH : 0;
    for (let x = 0; x < w; x++) {
      const px = x < r ? x - r : x >= w - r ? x - r - straightW : 0;
      const length = Math.hypot(px, py);
      const inset = r - length;
      if (inset < -1 || inset > bezel || length < .00001) continue;
      const coverage = Math.max(0, Math.min(1, inset + 1));
      const nx = px / length, ny = py / length;
      const index = Math.max(0, Math.min(profile.length - 1, Math.floor(Math.max(0, inset) / bezel * profile.length)));
      const distance = profile[index] / maximum;
      const pos = (y * w + x) * 4;
      dd[pos] = Math.round(128 - nx * distance * 127 * coverage);
      dd[pos + 1] = Math.round(128 - ny * distance * 127 * coverage);
      // Normal-facing highlight, shaped by the capsule's real perimeter.
      // Soft and asymmetric, and its direction follows pointer movement.
      const normalDot = Math.max(0, nx * lightX - ny * lightY);
      const edge = Math.exp(-Math.pow((inset - 1) / 1.35, 2));
      const gleam = Math.pow(normalDot, 2.2) * edge * coverage;
      const col = Math.round(255 * gleam);
      sd[pos] = sd[pos + 1] = sd[pos + 2] = 255;
      sd[pos + 3] = Math.round(col * .53);
    }
  }
  dispCtx.putImageData(disp, 0, 0);
  specCtx.putImageData(spec, 0, 0);
  const result: Maps = {
    displacement: displacementCanvas.toDataURL("image/png"),
    specular: specularCanvas.toDataURL("image/png"),
    scale: Math.min(4.5, maximum * .72)
  };
  if (mapCache.size >= CACHE_LIMIT) mapCache.clear();
  mapCache.set(key, result);
  return result;
}

/** Single lens, including the specular reflection; no overlay circles. */
export default function ShapeGlassSurface() {
  const id = "bg-glass-shape-" + useId().replace(/:/g, "");
  const surface = useRef<HTMLSpanElement>(null);
  const displacementImage = useRef<SVGFEImageElement>(null);
  const specularImage = useRef<SVGFEImageElement>(null);
  const displacementFilter = useRef<SVGFEDisplacementMapElement>(null);
  useEffect(() => {
    const lens = surface.current;
    const host = lens?.parentElement;
    if (!lens || !host || typeof ResizeObserver === "undefined") return;
    let animation = 0, angle = 0, previous = "";
    const supportsFilter = CSS.supports("-webkit-backdrop-filter", "url(#x)") ||
      CSS.supports("backdrop-filter", "url(#x)");
    if (!supportsFilter) return; // The CSS frosted fallback remains visible.
    lens.style.setProperty("-webkit-backdrop-filter", `url(#${id}) blur(3px) saturate(1.12)`);
    lens.style.backdropFilter = `url(#${id}) blur(3px) saturate(1.12)`;
    const update = () => {
      animation = 0;
      const bounds = host.getBoundingClientRect();
      const w = Math.round(bounds.width), h = Math.round(bounds.height);
      const key = w + ":" + h + ":" + angle;
      if (key === previous || w < 3 || h < 3) return;
      const maps = generateMaps(w, h, angle);
      if (!maps) return;
      previous = key;
      displacementImage.current?.setAttribute("href", maps.displacement);
      specularImage.current?.setAttribute("href", maps.specular);
      lens.style.setProperty("--shape-glare", `url("${maps.specular}")`);
      displacementFilter.current?.setAttribute("scale", String(maps.scale));
    };
    const schedule = () => { if (!animation) animation = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    const onPointerMove = (event: PointerEvent) => {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const rect = host.getBoundingClientRect();
      const next = Math.round(Math.atan2(event.clientY - (rect.top + rect.height / 2),
        event.clientX - (rect.left + rect.width / 2)) / (Math.PI / 24));
      if (angle !== next) { angle = next; schedule(); }
    };
    const onPointerLeave = () => { if (angle !== 0) { angle = 0; schedule(); } };
    host.addEventListener("pointermove", onPointerMove, { passive: true });
    host.addEventListener("pointerleave", onPointerLeave);
    schedule();
    return () => {
      observer.disconnect();
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerLeave);
      cancelAnimationFrame(animation);
    };
  }, [id]);

  return <>
    <svg className="shape-glass-defs" width="0" height="0" aria-hidden="true" focusable="false"
      colorInterpolationFilters="sRGB">
      <defs>
        <filter id={id} x="0%" y="0%" width="100%" height="100%">
          <feGaussianBlur in="SourceGraphic" stdDeviation=".55" result="source"/>
          <feImage ref={displacementImage} x="0" y="0" result="map" />
          <feDisplacementMap ref={displacementFilter} in="source" in2="map"
            scale="3" xChannelSelector="R" yChannelSelector="G" result="refracted" />
          <feImage ref={specularImage} x="0" y="0" result="glare" />
          <feBlend in="glare" in2="refracted" mode="screen" />
        </filter>
      </defs>
    </svg>
    <span ref={surface} className="shape-glass-surface" aria-hidden="true"/>
  </>;
}
