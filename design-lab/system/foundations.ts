import type { CSSProperties } from "react";
export const ARTWORK_BLACK = "#0c0c0c";
export const DEFAULT_COLORS = {
  canvas: ARTWORK_BLACK, surface: "#101010", raised: "#151515",
  ink: "#f2f2f2", secondary: "#b0b0b0", accent: "#c8b7ff",
};
export type ColorKey = keyof typeof DEFAULT_COLORS;
export type Colors = Record<ColorKey,string>;
export type FoundationSettings = { spacing: number; radius: number; control: number; type: number; shadow: number; motion: number };
export const DEFAULT_FOUNDATIONS: FoundationSettings = { spacing: 16, radius: 12, control: 44, type: 14, shadow: 55, motion: 180 };
export const FOUNDATION_LIMITS: Record<keyof FoundationSettings,[number,number,number]> = {
 spacing:[8,28,2],radius:[4,24,2],control:[36,60,2],type:[12,18,1],shadow:[0,90,5],motion:[0,400,20]
};
export const FOUNDATION_DESCRIPTIONS: Record<keyof FoundationSettings,string> = {
 spacing:"4px-based spacing system, with an editable core interval",
 radius:"Shared corner rounding for surfaces and inputs",
 control:"Minimum height of primary interactive elements",
 type:"Base size for the experimental specimen text",
 shadow:"Depth of layered cards and dialog surfaces",
 motion:"Standard interaction transition in milliseconds"
};
export function toLabVariables(colors: Colors, settings: FoundationSettings): CSSProperties {
  return {
    "--lab-canvas": ARTWORK_BLACK,
    "--lab-surface": colors.surface,
    "--lab-raised": colors.raised,
    "--lab-ink": colors.ink,
    "--lab-secondary": colors.secondary,
    "--lab-accent": colors.accent,
    "--lab-radius-sm": Math.max(4,settings.radius-4)+"px",
    "--lab-radius-md": settings.radius+"px",
    "--lab-radius-lg": (settings.radius+4)+"px",
    "--lab-space-2": (settings.spacing/2)+"px",
    "--lab-space-4": settings.spacing+"px",
    "--lab-control": settings.control+"px",
    "--lab-button-sm-height": settings.control+"px",
    "--lab-normal": settings.motion+"ms",
    "--ds-font-size": settings.type+"px",
    "--lab-shadow-card": `0 24px 80px rgba(0,0,0,${settings.shadow/100})`
  } as CSSProperties;
}
