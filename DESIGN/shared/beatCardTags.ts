/**
 * BeatCard tag packing is shared by GALLERY and MASTER.
 * One cached canvas/font metric table, no ResizeObserver, no per-card DOM reads.
 * All widths correspond to the 160px / 10px font / 3px gap visual contract.
 */
const widthCache = new Map<string, number>();
let measureContext: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string): number {
  const cached = widthCache.get(text);
  if (cached !== undefined) return cached;
  if (measureContext === undefined) {
    measureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    if (measureContext) measureContext.font = "10px 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', system-ui, sans-serif";
  }
  const width = Math.ceil(measureContext ? measureContext.measureText(text).width : [...text].length * 5.2);
  if (widthCache.size >= 512) widthCache.clear();
  widthCache.set(text, width);
  return width;
}
export type CompactTileTags = {
  visible: string[];
  hidden: string[];
  dots: string[];
  unrepresented: number;
};
export function compactTileTags(tags: readonly string[], colors: Readonly<Record<string,string>>, width = 160): CompactTileTags {
  const ordered = [...tags].sort((a, b) => a.localeCompare(b));
  for (let named = ordered.length; named >= 0; named--) {
    const visible = ordered.slice(0, named);
    const hidden = ordered.slice(named);
    const dots: string[] = [];
    let unrepresented = 0;
    for (const tag of hidden) {
      const color = (colors[tag] || "").trim().toLowerCase();
      if (!color || dots.includes(color)) unrepresented++;
      else dots.push(color);
    }
    // The CSS uses 3px horizontal padding, 1px borders, 6px dots and 3px gap.
    const itemWidths = [
      ...visible.map(tag => textWidth(tag) + 8),
      ...dots.map(() => 6),
      ...(unrepresented ? [textWidth("+" + unrepresented)] : []),
    ];
    const used = itemWidths.reduce((sum, item) => sum + item, 0) + Math.max(0, itemWidths.length - 1) * 3;
    if (used <= width) return { visible, hidden, dots, unrepresented };
  }
  return { visible: [], hidden: ordered, dots: [], unrepresented: ordered.length };
}
