import { describe, expect, it } from "vitest";
import { filtersKey, playbackFiltersIdentity, playbackFiltersKey, playbackSetKey } from "../../src/features/library/catalog/catalogQueryIdentity";
import type { CatalogQueryFilters } from "../../src/features/library/catalog/catalogApi";

const base: CatalogQueryFilters = { state: "ACTIVE", q: "Trap", includeTags: ["b", "a", "b"], excludeTags: ["z"], includeMode: "any" };

describe("identidades de consulta del catálogo", () => {
  it("normalizada: valores literales", () => {
    expect(filtersKey(base, "rating")).toBe('{"state":"ACTIVE","q":"trap","includeMode":"any","include":["a","b"],"exclude":["z"],"sort":"rating"}');
    expect(filtersKey({ ...base, includeMode: "all" }, "name")).toBe('{"state":"ACTIVE","q":"trap","includeMode":"all","include":["a","b"],"exclude":["z"],"sort":"name"}');
  });
  it("conjunto de reproducción: valores literales", () => {
    expect(playbackSetKey({ filters: base, sort: "rating", revision: "r1" })).toBe('[{"state":"ACTIVE","q":"Trap","includeTags":["b","a","b"],"excludeTags":["z"],"includeMode":"any"},"rating","r1"]');
  });
  it("disparador de reproducción: valores literales", () => {
    expect(playbackFiltersKey(base)).toBe("Trap|b,a,b|z|ACTIVE|any");
    expect(playbackFiltersKey({ ...base, includeMode: "all" })).toBe("Trap|b,a,b|z|ACTIVE|all");
  });
  it("comparación de filtros de la sesión: valores literales", () => {
    expect(playbackFiltersIdentity(base)).toBe('{"state":"ACTIVE","q":"Trap","includeTags":["b","a","b"],"excludeTags":["z"],"includeMode":"any"}');
  });
  it("divergencia documentada: Trap vs trap", () => {
    const lower = { ...base, q: "trap", includeTags: ["a", "b"] };
    expect(filtersKey(base, "rating")).toBe(filtersKey(lower, "rating"));
    expect(playbackSetKey({ filters: base, sort: "rating", revision: "r1" })).not.toBe(playbackSetKey({ filters: lower, sort: "rating", revision: "r1" }));
    expect(playbackFiltersKey(base)).not.toBe(playbackFiltersKey(lower));
    expect(playbackFiltersIdentity(base)).not.toBe(playbackFiltersIdentity(lower));
  });
  it("sort solo entra en normalizada y conjunto", () => {
    expect(filtersKey(base, "name")).not.toBe(filtersKey(base, "rating"));
    expect(playbackFiltersKey(base)).toBe("Trap|b,a,b|z|ACTIVE|any");
  });
});
