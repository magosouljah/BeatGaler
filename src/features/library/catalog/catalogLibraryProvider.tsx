// T16 / V08-A — Resolución de la composición por autoridad y servicios del provider POSTGRES (plan B §3; NATIVO r2.1 §2/§3.3).
// Con el flag apagado (por defecto) no se hace ninguna petición y la composición es LEGACY. Con el flag encendido se resuelve
// GET /context ANTES de elegir adaptador: `ready` → POSTGRES (store acotado V04, InteractionStore V07-A, sesión musical V06, medios T14,
// mutaciones T13, transferencias T12); cualquier otro estado → bloqueado (fail-closed, sin fallback a INDEX). El cambio de cuenta
// invalida y remonta: todos los servicios tienen teardown por cuenta.
import { useEffect, useMemo, useRef, useState } from "react";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../../components/AccountGate";
import { CatalogApiError, createCatalogApi, filtersKey, type CatalogApi, type CatalogContext } from "./catalogApi";
import { browserFirstBlockCache, identityOf, type FirstBlockCache } from "./catalogFirstBlockCache";
import { parseLegacyBgPage, readNavigationState } from "./catalogNavigation";
import { playbackSetKey, resolveReadyQuerySet } from "./catalogPlaybackSets";
import { chooseLibraryComposition, isCatalogClientEnabled, type LibraryComposition } from "./catalogComposition";
import { createCatalogCommandsApi } from "./catalogCommandsApi";
import { createCatalogInteractionStore, type CatalogInteractionStore } from "./catalogInteractionStore";
import { createCatalogMediaClient, type CatalogMediaClient } from "./catalogMediaClient";
import { createCatalogMutations, type CatalogMutations } from "./catalogMutations";
import { prepareCatalogFiles } from "./catalogFilePrep";
import { createCatalogPlaybackSession, type CatalogPlaybackSession, type PlaybackApi } from "./catalogPlaybackSession";
import { createCatalogQueryStore, type CatalogQueryStore } from "./catalogQueryStore";
import { createCatalogTransfer } from "./catalogTransfer";
import { createLazyDirectPort, type DirectPort } from "./catalogDirectTypes";
import { createPrefixCache, type PrefixCache } from "./catalogPrefixCache";
import { createArtworkCache, type ArtworkCache } from "./catalogArtworkCache";
import { createCatalogLocalCaches, type CatalogLocalCaches } from "./catalogLocalCaches";
import { MAIN_PACK_DEFAULTS, createMainPackCoordinator, type MainPackCoordinator } from "./catalogMainPack";
import type { LibraryCompositionState } from "./LibraryCompositionGate";

export interface CatalogServices {
  api: CatalogApi;
  store: CatalogQueryStore;
  interaction: CatalogInteractionStore;
  playback: CatalogPlaybackSession;
  media: CatalogMediaClient;
  mutations: CatalogMutations;
  /** Copia local del primer bloque (E66), si está disponible: para invalidar beats concretos tras mutaciones que cambian lo que se ve. */
  firstBlockCache?: FirstBlockCache | null;
  /** E75: coordinador del MAIN de prefijos (null si el servidor no lo anuncia o no hay plano directo/caché). */
  mainPack?: MainPackCoordinator | null;
  /** E80: uso y limpieza de las copias locales de este dispositivo (Settings). */
  localCaches?: CatalogLocalCaches;
  teardown(): Promise<void>;
}
export interface UseLibraryCompositionOptions {
  accountId: string | null;
  enabled?: boolean;
  api?: CatalogApi;
  fetchImpl?: typeof fetch;
  baseUrl?: () => string;
  token?: () => string | null;
  csrf?: () => string | null;
  /** Copia local del primer bloque (por defecto IndexedDB del navegador). */
  firstBlockCache?: FirstBlockCache;
  /** `location.search` de arranque (pruebas); por defecto window.location.search. */
  initialSearch?: () => string;
}

const STARTUP_CACHE_GRACE_MS = 40;

// Consulta de arranque cacheable: solo la del primer bloque (sin bgPage legacy ni ancla de reapertura, ni en la URL ni en history.state).
function startupQuery(search: string) {
  if (parseLegacyBgPage(search).kind !== "none") return null;
  const nav = readNavigationState(search, typeof window !== "undefined" ? window.history.state : null);
  return nav.anchor ? null : { filters: nav.filters, sort: nav.sort };
}

/** Servicios POSTGRES para una cuenta: creados una vez por (cuenta, época) y liberados juntos. */
export function createCatalogServices({ api, accountId, context, fetchImpl, baseUrl, token, csrf, firstBlockCache, direct, prefixCache: prefixCacheIn, artworkCache: artworkCacheIn, prefixSyncDelayMs, directPreconnectDelayMs }: { api: CatalogApi; accountId: string; context: { authority_era: string; authority_epoch: string } & Partial<CatalogContext>; fetchImpl?: typeof fetch; baseUrl?: () => string; token?: () => string | null; csrf?: () => string | null; firstBlockCache?: FirstBlockCache; direct?: DirectPort | null; prefixCache?: PrefixCache | null; artworkCache?: ArtworkCache | null; prefixSyncDelayMs?: number | null; /** E73 (D): null lo desactiva; por defecto solo con el puerto real. */ directPreconnectDelayMs?: number | null }): CatalogServices {
  const common = { fetchImpl, baseUrl, token, csrf, headers: () => ({ era: context.authority_era, epoch: context.authority_epoch }) };
  const commands = createCatalogCommandsApi(common);
  // Direct B: el navegador habla con Telegram si el servidor lo anuncia (capabilities.direct). E77: es el único transporte de archivos; sin él no hay
  // subidas ni lecturas (error claro), nunca bytes a través del Cloud.
  const directPort: DirectPort | null = direct !== undefined ? direct : context.capabilities?.direct === true
    ? createLazyDirectPort({ enabled: () => true, load: async () => {
        // Solo desarrollo: el LAB de navegador con Telegram simulado sustituye MTProto por su doble HTTP (catalogLabDirectPort). En producción esta rama no existe.
        const lab = import.meta.env.DEV ? (import.meta.env.VITE_CATALOG_LAB_DIRECT as string | undefined) : undefined;
        return lab ? (await import("./catalogLabDirectPort")).createLabDirectPort(lab) : (await import("./catalogDirectPort")).createWebDirectPort();
      } }) : null;
  const transfer = createCatalogTransfer({ ...common, direct: directPort });
  // E73 (D): preconexión Direct B al entrar a la Gallery con sesión válida (estos servicios solo existen tras /context autenticado). Segundo plano,
  // tras el primer pintado; una única apertura compartida (el puerto coalesce a todos los llamadores); con la pestaña oculta espera a que sea visible
  // para no gastar un login del bot en pestañas restauradas en segundo plano. teardown (logout/cambio de cuenta) la cancela y cierra la sesión.
  let preconnectTimer: ReturnType<typeof setTimeout> | null = null; let preconnectVisibility: (() => void) | null = null;
  const preconnectDelay = directPreconnectDelayMs === undefined ? (direct === undefined ? 250 : null) : directPreconnectDelayMs;
  if (directPort && preconnectDelay !== null) {
    const fire = () => { if (typeof navigator !== "undefined" && navigator.onLine === false) return; void directPort.ready().catch(() => {}); };
    const arm = () => { preconnectTimer = setTimeout(fire, Math.max(0, preconnectDelay)); };
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      preconnectVisibility = () => { if (document.visibilityState !== "visible") return; document.removeEventListener("visibilitychange", preconnectVisibility!); preconnectVisibility = null; arm(); };
      document.addEventListener("visibilitychange", preconnectVisibility);
    } else arm();
  }
  // Cada primer bloque confirmado por PostgreSQL renueva la copia local de arranque de su identidad exacta (cuenta/vault/era/época/generación).
  const identity = firstBlockCache?.available && context.user_id && context.vault_id && context.generation_id ? identityOf(accountId, context as CatalogContext) : null;
  const store = createCatalogQueryStore({ api, accountId, onFirstPage: identity && firstBlockCache ? (page, q) => { if (page.authorityEra === identity.era && page.epoch === identity.epoch && page.generationId === identity.generationId) void firstBlockCache.write(identity, q.queryKey, page); } : undefined });
  const interaction = createCatalogInteractionStore({ commands, api, accountId: () => accountId });
  // E71: caché local de prefijos (IndexedDB; clave = cuenta + SHA-256 del archivo completo). La subida guarda el prefijo de los bytes originales.
  const prefixCache: PrefixCache | null = prefixCacheIn !== undefined ? prefixCacheIn : typeof indexedDB !== "undefined" ? createPrefixCache() : null;
  // E79: caché persistente de portadas originales (IndexedDB; clave = cuenta + época + archivo + revisión). Se abre al pedir la primera portada.
  const artworkCache: ArtworkCache | null = artworkCacheIn !== undefined ? artworkCacheIn : typeof indexedDB !== "undefined" ? createArtworkCache() : null;
  const media = createCatalogMediaClient({ ...common, accountId: () => accountId, direct: directPort, prefixCache, artworkCache });
  const onMasterPrepared = prefixCache ? (file: Blob, spec: { sha256: string | null; mime?: string | null; filename?: string | null }) => {
    if (spec.sha256 && (/^audio\/(mpeg|mp3)$/i.test(spec.mime ?? "") || /\.mp3$/i.test(spec.filename ?? ""))) void prefixCache.putFromBlob({ account: accountId, fileSha256: spec.sha256, blob: file }).catch(() => {});
  } : undefined;
  // E75 — MAIN de prefijos: solo con plano directo, caché local y la capacidad anunciada por el servidor. El coordinador decide (con el recuento
  // de PostgreSQL) cuándo reconstruir: nunca durante un lote de subidas y una sola vez al terminar. La versión de MAIN conocida vive en este navegador.
  const mainKey = `beatgaler:catalog-main:v1:${accountId}`;
  const mainPack: MainPackCoordinator | null = prefixCache && directPort && context.capabilities?.prefixPacks === true
    ? createMainPackCoordinator({ account: accountId, api: media.mainPack, cache: prefixCache, direct: directPort,
        knownVersion: () => { try { return localStorage.getItem(mainKey); } catch { return null; } },
        rememberVersion: (version) => { try { if (version) localStorage.setItem(mainKey, version); else localStorage.removeItem(mainKey); } catch { /* sin almacenamiento: se vuelve a comprobar */ } } })
    : null;
  const mutations = createCatalogMutations({ commands, transfer, accountId: () => accountId, prepareFiles: prepareCatalogFiles, onMasterPrepared,
    onTransferActivity: mainPack ? (e) => { if (e.phase === "start") mainPack.transferStarted(); else mainPack.transferFinished(e.committedMasterMp3); } : undefined });
  // Restauración desde el MAIN en segundo plano, diferida para no competir con el primer bloque ni con la Playbar.
  const syncDelay = prefixSyncDelayMs === undefined ? MAIN_PACK_DEFAULTS.openDelayMs : prefixSyncDelayMs;
  const syncTimer = mainPack && syncDelay !== null ? setTimeout(() => { void mainPack.open(); }, syncDelay) : null;
  // Comandos musicales del servidor (T14) sobre el mismo transporte HTTP que los comandos (sin RNG en cliente).
  // V09 hallazgo: sin `baseUrl` explícito debe resolverse la misma base del Cloud que el resto de clientes (misma origin del proxy web);
  // antes el default "" enviaba rounds/neighbor a la origin de Vite (404) y Next/Shuffle/Prev no avanzaban.
  const base = baseUrl ?? (() => getResolvedCloudApiBase());
  const bearerOf = token ?? (() => getBeatGalerAuthToken());
  const csrfOf = csrf ?? (() => { try { return sessionStorage.getItem("beatgaler:web-csrf:v1"); } catch { return null; } });
  const call = async <T,>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    const bearer = bearerOf(); if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (method === "POST") { headers["Content-Type"] = "application/json"; headers["X-Catalog-Era"] = context.authority_era; headers["X-Catalog-Epoch"] = context.authority_epoch; const c = csrfOf(); if (c) headers["X-BeatGaler-CSRF"] = c; }
    const f = fetchImpl ?? fetch;
    const r = await f(`${base()}${path}`, { method, headers, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) { const { CatalogApiError } = await import("./catalogApi"); throw new CatalogApiError(r.status, typeof payload.code === "string" ? payload.code : `HTTP_${r.status}`, typeof payload.error === "string" ? payload.error : "playback command failed", (payload.detail as Record<string, unknown>) ?? {}); }
    return payload as T;
  };
  const playbackApi: PlaybackApi = {
    startRound: (input) => call("POST", "/catalog/v1/playback/rounds", input),
    nextInRound: (input) => call("POST", `/catalog/v1/playback/rounds/${encodeURIComponent(input.roundId)}/next`, input),
    consumeInRound: (input) => call("POST", `/catalog/v1/playback/rounds/${encodeURIComponent(input.roundId)}/consume`, input),
    releaseRound: (roundId) => call("POST", `/catalog/v1/playback/rounds/${encodeURIComponent(roundId)}/release`, {}),
    neighbor: (input) => { const p = new URLSearchParams({ direction: input.direction, sort: input.sort }); if (input.beatId) p.set("beatId", input.beatId); return call("GET", `/catalog/v1/query-sets/${encodeURIComponent(input.setId)}/neighbor?${p}`); },
  };
  const sets = new Map<string, Promise<{ setId: string; memberCount: number }>>();
  const playback = createCatalogPlaybackSession({
    api: playbackApi,
    // Un conjunto fallido NO se queda en caché (antes un rechazo se reutilizaba para siempre) y el servidor puede invalidarlo (CURSOR_STALE) → `invalidateSet`.
    resolveSet: (q) => { const k = playbackSetKey(q); if (!sets.has(k)) sets.set(k, resolveReadyQuerySet({ commands, accountId, query: q }).catch((e) => { sets.delete(k); throw e; })); return sets.get(k)!; },
    invalidateSet: (q) => { sets.delete(playbackSetKey(q)); },
    resolveFile: async (beatId) => { const d = await commands.getBeat(beatId); return d.playback ? { fileId: d.playback.fileId, version: d.version } : null; },
    // E71: streaming MSE (prefijo local + resto por rangos) cuando el navegador lo admite; si no, descarga completa como antes.
    acquireSource: (fileId) => media.acquireStream(fileId, "player"),
    accountId: () => accountId,
  });
  return Object.freeze({
    api, store, interaction, playback, media, mutations, firstBlockCache: firstBlockCache ?? null, mainPack,
    localCaches: createCatalogLocalCaches({ accountId, firstBlockCache: firstBlockCache ?? null, prefixCache, artworkCache }),
    async teardown() { mainPack?.teardown(); if (syncTimer) clearTimeout(syncTimer); if (preconnectTimer) clearTimeout(preconnectTimer); if (preconnectVisibility && typeof document !== "undefined") document.removeEventListener("visibilitychange", preconnectVisibility); await playback.teardown(); await interaction.teardown(); media.teardown(); store.teardown?.(); sets.clear(); if (directPort) await directPort.close().catch(() => {}); },
  });
}

/** Hook de composición: resuelve la autoridad por cuenta y expone los servicios POSTGRES o el modo LEGACY. */
export function useLibraryComposition(options: UseLibraryCompositionOptions): { state: LibraryCompositionState; services: CatalogServices | null } {
  const enabled = options.enabled ?? isCatalogClientEnabled();
  const api = useMemo(() => options.api ?? createCatalogApi({ fetchImpl: options.fetchImpl, baseUrl: options.baseUrl, token: options.token, csrf: options.csrf }), [options.api, options.fetchImpl, options.baseUrl, options.token, options.csrf]);
  const [state, setState] = useState<LibraryCompositionState>(() => (enabled ? { status: "resolving" } : { status: "resolved", composition: { mode: "legacy", reason: "flag-off" }, key: "legacy" }));
  const servicesRef = useRef<CatalogServices | null>(null);
  const [services, setServices] = useState<CatalogServices | null>(null);
  useEffect(() => {
    let cancelled = false; const controller = new AbortController();
    if (!enabled) { setState({ status: "resolved", composition: { mode: "legacy", reason: "flag-off" }, key: "legacy" }); return () => {}; }
    setState({ status: "resolving" });
    void (async () => {
      const cache = options.firstBlockCache ?? browserFirstBlockCache();
      // Copias locales de esta cuenta leídas en paralelo a /context (no se usan ni muestran hasta que la autoridad responda `ready`).
      const localCandidates = options.accountId && cache.available ? cache.candidates(options.accountId) : null;
      let composition: LibraryComposition;
      try { composition = await chooseLibraryComposition({ enabled: true, api, signal: controller.signal }); } catch (error) {
        composition = { mode: "blocked", resolution: { status: "offline", error: error instanceof Error ? error : new Error(String(error)) } };
      }
      if (cancelled) return;
      // servicios anteriores (otra cuenta/época) se liberan ANTES de montar los nuevos
      const prev = servicesRef.current; servicesRef.current = null; if (prev) void prev.teardown();
      if (composition.mode === "catalog" && options.accountId) {
        const ctx = composition.resolution.context;
        const next = createCatalogServices({ api, accountId: options.accountId, context: ctx, fetchImpl: options.fetchImpl, baseUrl: options.baseUrl, token: options.token, csrf: options.csrf, firstBlockCache: cache });
        // Arranque rápido: SOLO tras /context `ready` y con identidad segura (cuenta confirmada por el Cloud = user_id del contexto). Las
        // copias de otra era/época/generación/vault de esta cuenta se borran; la que coincide se siembra como provisional y se revalida.
        const identity = identityOf(options.accountId, ctx);
        if (!identity) void cache.invalidateAccount(options.accountId);
        else if (cache.available) {
          void cache.invalidateAccount(options.accountId, identity);
          const q = startupQuery(options.initialSearch ? options.initialSearch() : typeof window !== "undefined" ? window.location.search : "");
          // Si la lectura local aún no terminó cuando la autoridad ya respondió (p. ej. primera visita: IndexedDB se está creando), se espera
          // como mucho STARTUP_CACHE_GRACE_MS y se arranca sin copia: la caché nunca puede hacer más lento el arranque normal.
          const entry = q && localCandidates ? await Promise.race([cache.pick(localCandidates, identity, filtersKey(q.filters, q.sort)).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), STARTUP_CACHE_GRACE_MS))]) : null;
          if (cancelled) { void next.teardown(); return; }
          // La revalidación arranca ya (en paralelo al primer render de la copia), no después del montaje.
          if (entry && q && entry.revision && next.store.seedFirst({ filters: q.filters, sort: q.sort, revision: entry.revision, totalMatched: entry.totalMatched, totalLibrary: entry.totalLibrary, page: entry.page })) void next.store.revalidate();
        }
        servicesRef.current = next; setServices(next);
        setState({ status: "resolved", composition, key: `catalog:${options.accountId}:${ctx.authority_era}:${ctx.authority_epoch}` });
      } else {
        // Biblioteca bloqueada por la autoridad (reinicio/cuarentena): ninguna copia local de esa cuenta sigue siendo utilizable.
        if (composition.mode === "blocked" && options.accountId && (composition.resolution.status === "reset_required" || composition.resolution.status === "quarantined")) void cache.invalidateAccount(options.accountId);
        setServices(null); setState({ status: "resolved", composition, key: composition.mode === "legacy" ? "legacy" : `blocked:${options.accountId ?? "anon"}` }); }
    })();
    return () => { cancelled = true; controller.abort(); const prev = servicesRef.current; servicesRef.current = null; if (prev) void prev.teardown(); setServices(null); };
  }, [enabled, api, options.accountId]);
  return { state, services };
}
