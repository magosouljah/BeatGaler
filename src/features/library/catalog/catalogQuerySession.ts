import type { CatalogQueryFilters, CatalogSort } from "./catalogApi";
import type { CatalogInteractionStore, InteractionQuery, SelectionStatus } from "./catalogInteractionStore";
import { LEGACY_UNRESOLVABLE_COPY, createHistoryWriter, parseLegacyBgPage, readNavigationState } from "./catalogNavigation";
import { playbackFiltersKey } from "./catalogQueryIdentity";
import type { CatalogPlaybackSession } from "./catalogPlaybackSession";
import type { CatalogQueryStore, CatalogStoreSnapshot } from "./catalogQueryStore";

export const SEARCH_DEBOUNCE_MS = 250;

interface FilterDraft {
  search: string;
  includedTags: ReadonlySet<string>;
  excludedTags: ReadonlySet<string>;
}

interface QueryFacets {
  revision: string;
  tags: string[];
  freq: Map<string, number>;
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

  function loadFacets(snapshot: CatalogStoreSnapshot, receive: (facets: QueryFacets) => void): (() => void) | undefined {
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

interface GalleryQueryView {
  catalog: CatalogStoreSnapshot;
  draft: FilterDraft;
  facets: QueryFacets;
}

export function createGalleryQuerySession(initialFilters: CatalogQueryFilters) {
  const history = createHistoryWriter();
  const listeners = new Set<() => void>();
  let draft = toDraft(initialFilters);
  let facets: QueryFacets = { revision: "", tags: [], freq: new Map() };
  let started = false;
  let lastQueryKey: string | null = null;
  let cancelFilters: (() => void) | undefined;
  let cancelFacets: (() => void) | undefined;
  let previous: {
    catalog: CatalogStoreSnapshot;
    draft: FilterDraft;
    fallbackRevision: string;
    revision: string;
    filtersKey: string;
    residentKey: string;
    query: ReturnType<typeof createCatalogQuerySession>;
  } | null = null;

  function toDraft({ q, includeTags, excludeTags }: CatalogQueryFilters): FilterDraft {
    return { search: q, includedTags: new Set(includeTags), excludedTags: new Set(excludeTags) };
  }

  function emit(): void { for (const listener of listeners) listener(); }

  function updateDraft(next: FilterDraft): void {
    draft = next;
    emit();
  }

  function setSearch(search: string): void {
    if (search !== draft.search) updateDraft({ ...draft, search });
  }

  function handleTagClick(tag: string, event: { altKey?: boolean }): void {
    const target = event?.altKey ? "excludedTags" : "includedTags";
    const opposite = event?.altKey ? "includedTags" : "excludedTags";
    const toggled = new Set(draft[target]);
    if (!toggled.delete(tag)) toggled.add(tag);
    const next = { ...draft, [target]: toggled };
    if (draft[opposite].has(tag)) {
      const remaining = new Set(draft[opposite]);
      remaining.delete(tag);
      next[opposite] = remaining;
    }
    updateDraft(next);
  }

  function clearTagFilters(): void {
    updateDraft({ ...draft, includedTags: new Set(), excludedTags: new Set() });
  }

  function bind({ store, interaction, playback }: Pick<QuerySessionPorts, "interaction" | "playback"> & { store: CatalogQueryStore }) {
    const query = createCatalogQuerySession({
      store, interaction, playback, history,
      schedule(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    });
    let view: GalleryQueryView | undefined;
    function getSnapshot(): GalleryQueryView {
      const catalog = store.getSnapshot();
      if (!view || view.catalog !== catalog || view.draft !== draft || view.facets !== facets) {
        view = { catalog, draft, facets };
      }
      return view;
    }

    function subscribe(listener: () => void): () => void {
      const unsubscribe = store.subscribe(listener);
      listeners.add(listener);
      return () => { unsubscribe(); listeners.delete(listener); };
    }

    // El store puede publicar varias veces antes de que React confirme un render.
    // Las reacciones usan esa vista confirmada y conservan el orden de los efectos originales.
    function commit({ catalog, draft }: GalleryQueryView, publishedQuery: InteractionQuery, fallbackRevision: string, setNotice: (notice: string) => void): void {
      const { revision } = publishedQuery;
      const filtersKey = playbackFiltersKey(catalog.filters);
      const residentKey = `${catalog.firstOrdinal}:${catalog.endOrdinal}:${catalog.queryGeneration}`;
      const before = previous;
      const old = before?.catalog;
      const serviceChanged = before?.query !== query;
      previous = { catalog, draft, fallbackRevision, revision, filtersKey, residentKey, query };

      if (!started) {
        started = true;
        query.start({
          snapshot: catalog,
          readSearch: () => typeof window !== "undefined" ? window.location.search : "",
          readHistoryState: () => typeof window !== "undefined" ? window.history.state : null,
          setDraft: (filters) => updateDraft(toDraft(filters)),
          setNotice,
        });
      }
      if (old?.queryKey !== catalog.queryKey || old.status !== catalog.status) {
        lastQueryKey = query.syncQueryHistory(catalog, lastQueryKey);
      }
      if (old?.resumeCursor !== catalog.resumeCursor || old.status !== catalog.status) query.syncAnchor(catalog);
      if (!before || serviceChanged || before.fallbackRevision !== fallbackRevision ||
          before.draft.search !== draft.search || before.draft.includedTags !== draft.includedTags ||
          before.draft.excludedTags !== draft.excludedTags) {
        cancelFilters?.();
        cancelFilters = query.deferFilters(draft, fallbackRevision);
      }
      if (before?.filtersKey !== filtersKey || old?.sort !== catalog.sort || before.revision !== revision) query.syncPlayback(publishedQuery);
      if (serviceChanged || old?.revision !== catalog.revision) query.syncRevision(catalog.revision);
      if (serviceChanged || old?.revision !== catalog.revision || old.status !== catalog.status || old.provisional !== catalog.provisional) {
        cancelFacets?.();
        cancelFacets = query.loadFacets(catalog, (next) => { facets = next; emit(); });
      }
      if (serviceChanged || before?.residentKey !== residentKey) query.syncResidentFlags(catalog.blocks);
    }

    const { setSort, refreshAfterMutation, reloadLibrary } = query;
    return { subscribe, getSnapshot, commit, setSort, refreshAfterMutation, reloadLibrary };
  }

  function dispose(): void {
    history.cancelPending();
    cancelFilters?.();
    cancelFacets?.();
    previous = null;
  }

  return { bind, dispose, setSearch, handleTagClick, clearTagFilters };
}
