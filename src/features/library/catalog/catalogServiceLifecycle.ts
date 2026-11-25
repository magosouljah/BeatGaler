import type { CatalogContext } from "./catalogApi";
import type { CatalogCommandsApi } from "./catalogCommandsApi";
import type { DirectPort } from "./catalogDirectTypes";
import { MAIN_PACK_DEFAULTS, createMainPackCoordinator } from "./catalogMainPack";
import type { CatalogMediaClient } from "./catalogMediaClient";
import { playbackSetKey, resolveReadyQuerySet, type PlaybackSetQuery } from "./catalogPlaybackSets";
import type { PrefixCache } from "./catalogPrefixCache";

// E73: difiere la apertura compartida de Direct B hasta el primer pintado y espera si la pestaña está oculta.
export function startDirectPreconnect(directPort: DirectPort | null, delay: number | null) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onVisibility: (() => void) | null = null;

  if (directPort && delay !== null) {
    const fire = () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      void directPort.ready().catch(() => {});
    };
    const arm = () => { timer = setTimeout(fire, Math.max(0, delay)); };
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      onVisibility = () => {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", onVisibility!);
        onVisibility = null;
        arm();
      };
      document.addEventListener("visibilitychange", onVisibility);
    } else arm();
  }

  return () => {
    if (timer) clearTimeout(timer);
    if (onVisibility && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  };
}

export function createMainPackService({ accountId, context, media, prefixCache, directPort }: {
  accountId: string;
  context: Pick<CatalogContext, "capabilities">;
  media: Pick<CatalogMediaClient, "mainPack">;
  prefixCache: PrefixCache | null;
  directPort: DirectPort | null;
}) {
  const mainKey = `beatgaler:catalog-main:v1:${accountId}`;
  const service = prefixCache && directPort && context.capabilities?.prefixPacks === true
    ? createMainPackCoordinator({
        account: accountId, api: media.mainPack, cache: prefixCache, direct: directPort,
        knownVersion: () => { try { return localStorage.getItem(mainKey); } catch { return null; } },
        rememberVersion: (version) => {
          try {
            if (version) localStorage.setItem(mainKey, version);
            else localStorage.removeItem(mainKey);
          } catch { /* sin almacenamiento: se vuelve a comprobar */ }
        },
      })
    : null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    service,
    // El ensamblado arma el temporizador una vez construidas las mutaciones.
    scheduleOpen(delay: number | null | undefined) {
      const syncDelay = delay === undefined ? MAIN_PACK_DEFAULTS.openDelayMs : delay;
      syncTimer = service && syncDelay !== null ? setTimeout(() => { void service.open(); }, syncDelay) : null;
    },
    dispose() {
      service?.teardown();
      if (syncTimer) clearTimeout(syncTimer);
    },
  };
}

export function createPlaybackSetCache(commands: Pick<CatalogCommandsApi, "createQuerySet" | "getQuerySet">, accountId: string) {
  const sets = new Map<string, ReturnType<typeof resolveReadyQuerySet>>();
  return {
    service: {
      resolveSet(query: PlaybackSetQuery) {
        const key = playbackSetKey(query);
        if (!sets.has(key)) {
          sets.set(key, resolveReadyQuerySet({ commands, accountId, query }).catch((error) => {
            sets.delete(key);
            throw error;
          }));
        }
        return sets.get(key)!;
      },
      invalidateSet(query: PlaybackSetQuery) {
        sets.delete(playbackSetKey(query));
      },
    },
    dispose() {
      sets.clear();
    },
  };
}
