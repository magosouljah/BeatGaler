// T08 / V05 + C12-B02 — Navegación URL: parser bgPage conservado, parámetros nuevos, historial acotado con debounce.
import { describe, expect, it, vi } from "vitest";
import { buildGalleryUrl, createHistoryWriter, parseLegacyBgPage, readNavigationState, HISTORY_LIMIT } from "../../src/features/library/catalog/catalogNavigation";

describe("catalogNavigation", () => {
  it("B02: parser legacy bgPage = Number del primer parámetro; inválido/negativo/fracción → 0; no seguro → LEGACY_OFFSET_INVALID; cursor/filtros + bgPage → INPUT_INVALID", () => {
    expect(parseLegacyBgPage("")).toEqual({ kind: "none" });
    expect(parseLegacyBgPage("?bgPage=240")).toEqual({ kind: "offset", offset: 240, canonical: "240" });
    expect(parseLegacyBgPage("?bgPage=0xF0")).toEqual({ kind: "offset", offset: 240, canonical: "240" });
    expect(parseLegacyBgPage("?bgPage=1e9")).toEqual({ kind: "offset", offset: 1_000_000_000, canonical: "1000000000" });
    expect(parseLegacyBgPage("?bgPage=5&bgPage=9")).toEqual({ kind: "offset", offset: 5, canonical: "5" });
    for (const v of ["-1", "1.5", "nope", "", "Infinity", "NaN"]) expect(parseLegacyBgPage(`?bgPage=${v}`)).toEqual({ kind: "offset", offset: 0, canonical: "0" });
    expect(parseLegacyBgPage("?bgPage=9007199254740993")).toEqual({ kind: "invalid", reason: "LEGACY_OFFSET_INVALID", action: "first-page" });
    expect(parseLegacyBgPage("?bgPage=1e300")).toEqual({ kind: "invalid", reason: "LEGACY_OFFSET_INVALID", action: "first-page" });
    expect(parseLegacyBgPage("?bgPage=240&bgAnchor=abc")).toEqual({ kind: "invalid", reason: "INPUT_INVALID", action: "first-page" });
    expect(parseLegacyBgPage("?bgPage=240&bgQ=trap")).toEqual({ kind: "invalid", reason: "INPUT_INVALID", action: "first-page" });
  });

  it("estado de navegación: defaults, enums validados y conjuntos repetibles; la URL construida es estable y sin bgPage", () => {
    const s = readNavigationState("?bgSort=name&bgQ=tr%20ap&bgInclude=Trap&bgInclude=Dark&bgExclude=demo&bgMode=all&bgState=TRASH&bgAnchor=tok.sig&bgPage=3&utm=x");
    expect(s).toEqual({ filters: { state: "TRASH", q: "tr ap", includeTags: ["Trap", "Dark"], excludeTags: ["demo"], includeMode: "all" }, sort: "name", anchor: "tok.sig" });
    expect(readNavigationState("?bgSort=zzz&bgMode=weird&bgState=PURGED")).toEqual({ filters: { state: "ACTIVE", q: "", includeTags: [], excludeTags: [], includeMode: "any" }, sort: "rating", anchor: null });
    const url = new URL(buildGalleryUrl("https://beatgaler.invalid/?bgPage=3&utm=x", s));
    expect(url.pathname).toBe("/gallery");
    expect(url.searchParams.has("bgPage")).toBe(false);
    expect(url.searchParams.get("utm")).toBe("x");
    expect(url.searchParams.getAll("bgInclude")).toEqual(["Trap", "Dark"]);
    expect(readNavigationState(url.search)).toEqual(s);
    // defaults no se escriben
    const plain = new URL(buildGalleryUrl("https://beatgaler.invalid/gallery", { filters: { state: "ACTIVE", q: "", includeTags: [], excludeTags: [], includeMode: "any" }, sort: "rating", anchor: null }));
    expect(plain.search).toBe("");
  });

  it("historial: replaceState con debounce 300 ms (una escritura por ráfaga), pushState para cambios deliberados, historial acotado a 16", () => {
    vi.useFakeTimers();
    const calls: Array<[string, string]> = [];
    let href = "https://beatgaler.invalid/gallery";
    const history = { replaceState: (_d: unknown, _u: string, url?: string | null) => { calls.push(["replace", String(url)]); href = String(url); }, pushState: (_d: unknown, _u: string, url?: string | null) => { calls.push(["push", String(url)]); href = String(url); } };
    const w = createHistoryWriter({ history, currentHref: () => href, setTimeoutImpl: (fn, ms) => setTimeout(fn, ms) as unknown as number, clearTimeoutImpl: (id) => clearTimeout(id) });
    const base = { filters: { state: "ACTIVE" as const, q: "", includeTags: [], excludeTags: [], includeMode: "any" as const }, sort: "rating" as const };
    for (let i = 0; i < 10; i++) w.replaceAnchor({ ...base, anchor: `a${i}` });
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(299); expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([["replace", "https://beatgaler.invalid/gallery?bgAnchor=a9"]]);
    for (let i = 0; i < 20; i++) w.pushQuery({ ...base, filters: { ...base.filters, q: `q${i}` }, anchor: "ignored" });
    expect(calls.filter((c) => c[0] === "push").length).toBe(20);
    expect(w.entries().length).toBe(HISTORY_LIMIT);
    expect(calls[calls.length - 1][1]).not.toContain("bgAnchor");
    w.replaceAnchor({ ...base, anchor: "late" }); w.cancelPending(); vi.advanceTimersByTime(400);
    expect(w.counters()).toEqual({ replaceCount: 1, pushCount: 20, pendingReplace: false });
    vi.useRealTimers();
  });
});
