import { getProceduralBeatBackgroundDataUrl } from "./proceduralBeatBackground";
export type CoverMode = "generated" | "real";
// Vite resolves these URLs to local build assets only; missing files fallback to bg-v1.
const imported = import.meta.glob("./assets/real-covers/*.{jpg,jpeg,png,webp,avif}", { eager:true, query:"?url", import:"default" }) as Record<string,string>;
const covers = Object.entries(imported).sort(([a],[b]) => a.localeCompare(b,"en",{numeric:true})).map(([,url])=>url);
export const REAL_COVER_COUNT = covers.length;
export function getCoverSrc(id: string, mode: CoverMode, index: number): string | null {
 if(mode === "real" && covers.length) {
   const slot = Number.isFinite(index) ? Math.trunc(index) : 0;
   return covers[((slot % covers.length) + covers.length) % covers.length];
 }
 return getProceduralBeatBackgroundDataUrl(id);
}
