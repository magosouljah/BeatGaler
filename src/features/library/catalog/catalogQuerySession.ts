import type { CatalogQueryFilters, CatalogSort } from "./catalogApi";
import type { CatalogInteractionStore, InteractionQuery, SelectionStatus } from "./catalogInteractionStore";
import { LEGACY_UNRESOLVABLE_COPY, parseLegacyBgPage, readNavigationState, type createHistoryWriter } from "./catalogNavigation";
import type { CatalogPlaybackSession } from "./catalogPlaybackSession";
import type { CatalogQueryStore, CatalogStoreSnapshot } from "./catalogQueryStore";

export const SEARCH_DEBOUNCE_MS = 250;

interface FilterDraft {
  search: string;
  includedTags: ReadonlySet<string>;
  excludedTags: ReadonlySet<string>;
}

interface QuerySessionPorts {
  store: Pick<CatalogQueryStore, "startedFromSeed" | "revalidate" | "loadFirst" | "loadLegacy" | "loadResume" | "setQuery" | "setSort" | "notifyLibraryChanged"> & {
    getSnapshot: () => Pick<CatalogStoreSnapshot, "filters" | "sort" | "revision">;
  };
  interaction: Pick<CatalogInteractionStore, "onFiltersChanged" | "onSortChanged" | "onRevisionChanged" | "loadFacets" | "invalidateFacets" | "refreshFlags"> & {
    getSnapshot: () => { selection: { status: SelectionStatus } };
  };
  playback: Pick<CatalogPlaybackSession, "setQuery">;
  history: Pick<ReturnType<typeof createHistoryWriter>, "pushQuery" | "replaceAnchor">;
  schedule: (callback: () => void, ms: number) => () => void;
}

export function playbackFiltersKey({ q, includeTags, excludeTags, state }: CatalogQueryFilters): string {
  return `${q}|${includeTags.join(",")}|${excludeTags.join(",")}|${state}`;
}

export function createCatalogQuerySession({ store, interaction, playback, history, schedule }: QuerySessionPorts) {
  function start({ snapshot, readSearch, readHistoryState, setDraft, setNotice }: {
    snapshot: Pick<CatalogStoreSnapshot, "filters" | "sort">;
    readSearch: () => string;
    readHistoryState: () => unknown;
    setDraft: (filters: CatalogQueryFilters) => void;
    setNotice: (notice: string) => void;
  }): void {
    // El bloque sembrado se revalida sin vaciar la Gallery.
    if (store.startedFromSeed()) { void store.revalidate(); return; }
    const search = readSearch();
    const legacy = parseLegacyBgPage(search);
    if (legacy.kind === "offset") { void store.loadLegacy(legacy.offset); return; }
    if (legacy.kind === "invalid") { setNotice(LEGACY_UNRESOLVABLE_COPY); void store.loadFirst(); return; }
    const nav = readNavigationState(search, readHistoryState());
    if (nav.filters.q || nav.filters.includeTags.length || nav.filters.excludeTags.length || nav.sort !== snapshot.sort || nav.filters.state !== snapshot.filters.state) {
      setDraft(nav.filters);
      void store.setQuery(nav.filters, nav.sort);
      return;
    }
    if (nav.anchor) { void store.loadResume(nav.anchor); return; }
    void store.loadFirst();
  }

  function deferFilters({ search, includedTags, excludedTags }: FilterDraft, fallbackRevision: string): () => void {
    const q = search.trim();
    return schedule(() => {
      // El orden puede haber cambiado mientras el filtro estaba pendiente.
      const current = store.getSnapshot();
      const filters: CatalogQueryFilters = { ...current.filters, q, includeTags: [...includedTags].sort(), excludeTags: [...excludedTags].sort() };
      const same = filters.q === current.filters.q && filters.includeTags.join(",") === current.filters.includeTags.join(",") && filters.excludeTags.join(",") === current.filters.excludeTags.join(",");
      if (same) return;
      void interaction.onFiltersChanged({ filters, sort: current.sort, revision: current.revision ?? fallbackRevision });
      void store.setQuery(filters, current.sort);
    }, SEARCH_DEBOUNCE_MS);
  }

  function setSort(sort: CatalogSort): void {
    interaction.onSortChanged(sort);
    void store.setSort(sort);
  }

  function syncPlayback(query: InteractionQuery): void {
    void playback.setQuery(query);
  }

  function syncRevision(revision: CatalogStoreSnapshot["revision"]): void {
    if (revision) interaction.onRevisionChanged(revision);
  }

  function syncQueryHistory(snapshot: CatalogStoreSnapshot, lastKey: string | null): string | null {
    if (snapshot.status === "idle" || snapshot.status === "resolving") return lastKey;
    const key = snapshot.queryKey;
    if (lastKey !== null && lastKey !== key) history.pushQuery({ filters: snapshot.filters, sort: snapshot.sort, anchor: null });
    return key;
  }

  function syncAnchor(snapshot: CatalogStoreSnapshot): void {
    if (!snapshot.resumeCursor || snapshot.status !== "ready" || snapshot.legacy) return;
    // En el primer bloque, una recarga puede usar la copia local (E66).
    history.replaceAnchor({ filters: snapshot.filters, sort: snapshot.sort, anchor: snapshot.firstOrdinal > 0 ? snapshot.resumeCursor : null });
  }

  function loadFacets(snapshot: CatalogStoreSnapshot, receive: (facets: { revision: string; tags: string[]; freq: Map<string, number> }) => void): (() => void) | undefined {
    const { revision, provisional, status } = snapshot;
    if (!revision || provisional || !["ready", "empty", "no-results"].includes(status)) return;
    let cancelled = false;
    void interaction.loadFacets({ scope: "ACTIVE", q: "", revision, limit: 240 }).then((page) => {
      if (cancelled) return;
      receive({ revision, tags: page.items.map((f) => f.label || f.key), freq: new Map(page.items.map((f) => [f.label || f.key, f.count])) });
    }).catch(() => {});
    return () => { cancelled = true; };
  }

  function syncResidentFlags(blocks: CatalogStoreSnapshot["blocks"]): void {
    const { status } = interaction.getSnapshot().selection;
    if (status !== "active" && status !== "conflict") return;
    const ids = blocks.flatMap((block) => block.items.map((item) => item.id));
    void interaction.refreshFlags(ids).catch(() => {});
  }

  function refreshAfterMutation(): void {
    store.notifyLibraryChanged();
    interaction.invalidateFacets();
  }

  async function reloadLibrary(): Promise<void> {
    await store.loadFirst();
    interaction.invalidateFacets();
  }

  return { start, deferFilters, setSort, syncPlayback, syncRevision, syncQueryHistory, syncAnchor, loadFacets, syncResidentFlags, refreshAfterMutation, reloadLibrary };
}
