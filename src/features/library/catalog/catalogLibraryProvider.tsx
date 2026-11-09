// T16 / V08-A — Resolución de la composición por autoridad y servicios del provider POSTGRES (plan B §3; NATIVO r2.1 §2/§3.3).
// Con el flag apagado (por defecto) no se hace ninguna petición y la composición es LEGACY. Con el flag encendido se resuelve
// GET /context ANTES de elegir adaptador: `ready` → POSTGRES (store acotado V04, InteractionStore V07-A, sesión musical V06, medios T14,
// mutaciones T13, transferencias T12); cualquier otro estado → bloqueado (fail-closed, sin fallback a INDEX). El cambio de cuenta
// invalida y remonta: todos los servicios tienen teardown por cuenta.
import { useEffect, useMemo, useRef, useState } from "react";
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../../components/AccountGate";
import { createCatalogApi, type CatalogApi } from "./catalogApi";
import { chooseLibraryComposition, isCatalogClientEnabled, type LibraryComposition } from "./catalogComposition";
import { createCatalogCommandsApi } from "./catalogCommandsApi";
import { createCatalogInteractionStore, type CatalogInteractionStore } from "./catalogInteractionStore";
import { createCatalogMediaClient, type CatalogMediaClient } from "./catalogMediaClient";
import { createCatalogMutations, type CatalogMutations } from "./catalogMutations";
import { createCatalogPlaybackSession, type CatalogPlaybackSession, type PlaybackApi } from "./catalogPlaybackSession";
import { createCatalogQueryStore, type CatalogQueryStore } from "./catalogQueryStore";
import { createCatalogTransfer } from "./catalogTransfer";
import type { LibraryCompositionState } from "./LibraryCompositionGate";

export interface CatalogServices {
  api: CatalogApi;
  store: CatalogQueryStore;
  interaction: CatalogInteractionStore;
  playback: CatalogPlaybackSession;
  media: CatalogMediaClient;
  mutations: CatalogMutations;
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
}

/** Servicios POSTGRES para una cuenta: creados una vez por (cuenta, época) y liberados juntos. */
export function createCatalogServices({ api, accountId, context, fetchImpl, baseUrl, token, csrf }: { api: CatalogApi; accountId: string; context: { authority_era: string; authority_epoch: string }; fetchImpl?: typeof fetch; baseUrl?: () => string; token?: () => string | null; csrf?: () => string | null }): CatalogServices {
  const common = { fetchImpl, baseUrl, token, csrf, headers: () => ({ era: context.authority_era, epoch: context.authority_epoch }) };
  const commands = createCatalogCommandsApi(common);
  const transfer = createCatalogTransfer(common);
  const store = createCatalogQueryStore({ api, accountId });
  const interaction = createCatalogInteractionStore({ commands, api, accountId: () => accountId });
  const media = createCatalogMediaClient({ ...common, accountId: () => accountId });
  const mutations = createCatalogMutations({ commands, transfer, accountId: () => accountId });
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
    resolveSet: (q) => { const k = JSON.stringify([q.filters, q.sort, q.revision]); if (!sets.has(k)) sets.set(k, commands.createQuerySet({ ...q.filters, includeTags: [...q.filters.includeTags], excludeTags: [...q.filters.excludeTags], sort: q.sort }, { id: `player-${accountId}`, kind: "SHUFFLE" }).then((s) => ({ setId: s.setId, memberCount: s.memberCount }))); return sets.get(k)!; },
    resolveFile: async (beatId) => { const d = await commands.getBeat(beatId); return d.playback ? { fileId: d.playback.fileId, version: d.version } : null; },
    acquireSource: (fileId) => media.acquire(fileId, "player"),
    accountId: () => accountId,
  });
  return Object.freeze({
    api, store, interaction, playback, media, mutations,
    async teardown() { await playback.teardown(); await interaction.teardown(); media.teardown(); store.teardown?.(); sets.clear(); },
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
      let composition: LibraryComposition;
      try { composition = await chooseLibraryComposition({ enabled: true, api, signal: controller.signal }); } catch (error) {
        composition = { mode: "blocked", resolution: { status: "offline", error: error instanceof Error ? error : new Error(String(error)) } };
      }
      if (cancelled) return;
      // servicios anteriores (otra cuenta/época) se liberan ANTES de montar los nuevos
      const prev = servicesRef.current; servicesRef.current = null; if (prev) void prev.teardown();
      if (composition.mode === "catalog" && options.accountId) {
        const ctx = composition.resolution.context;
        const next = createCatalogServices({ api, accountId: options.accountId, context: ctx, fetchImpl: options.fetchImpl, baseUrl: options.baseUrl, token: options.token, csrf: options.csrf });
        servicesRef.current = next; setServices(next);
        setState({ status: "resolved", composition, key: `catalog:${options.accountId}:${ctx.authority_era}:${ctx.authority_epoch}` });
      } else { setServices(null); setState({ status: "resolved", composition, key: composition.mode === "legacy" ? "legacy" : `blocked:${options.accountId ?? "anon"}` }); }
    })();
    return () => { cancelled = true; controller.abort(); const prev = servicesRef.current; servicesRef.current = null; if (prev) void prev.teardown(); setServices(null); };
  }, [enabled, api, options.accountId]);
  return { state, services };
}
