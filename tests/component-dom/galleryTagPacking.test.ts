import { describe, expect, it, vi } from "vitest";
import { compactTileTags } from "../../src/features/design/shared/beatCardTags";
describe("approved 160px BeatCard tags", () => {
  it("keeps very long tags reachable through the shared peek instead of overflowing the card", () => {
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null);
    const tags=["An exceptionally long musical description that cannot fit in one card"];
    const packed=compactTileTags(tags,{});
    expect(packed.visible).toEqual([]); expect(packed.hidden).toEqual(tags); expect(packed.unrepresented).toBe(1);
  });
  it("deduplicates color dots and accounts for every hidden tag", () => {
    const tags=Array.from({length:20},(_,i)=>`Musical style number ${i}`);
    const colors=Object.fromEntries(tags.map((tag,i)=>[tag,i%2?"#ff0000":"#00ff00"]));
    const packed=compactTileTags(tags,colors);
    expect(new Set(packed.dots).size).toBe(packed.dots.length);
    expect(packed.visible.length+packed.dots.length+packed.unrepresented).toBe(tags.length);
    expect([...packed.visible,...packed.hidden].sort()).toEqual([...tags].sort());
  });
  it("sorts presentation alphabetically without mutating persisted tags", () => {
    const tags=["Trap","Ambient","Dark"]; const original=[...tags];
    const packed=compactTileTags(tags,{});
    expect([...packed.visible,...packed.hidden]).toEqual(["Ambient","Dark","Trap"]); expect(tags).toEqual(original);
  });
});
