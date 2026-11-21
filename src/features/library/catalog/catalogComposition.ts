// T08 — Frontera de composición por autoridad (plan B §3, NATIVO r2.1 §2). Con el flag apagado no se hace ninguna petición
// de catálogo y se devuelve `mode: legacy`; desde T25 la Web muestra el aviso de catálogo obligatorio.
// Con el flag encendido: resolver /context antes de elegir adaptador; POSTGRES nunca construye WebGalerCloudTransport para
// metadata ni cae a LEGACY ante error (fail-closed: estado visible).
import type { CatalogApi, CatalogContextResolution } from "./catalogApi";

export const CATALOG_CLIENT_FLAG = "VITE_CATALOG_API_ENABLED";

export type LibraryComposition =
  | { mode: "legacy"; reason: "flag-off" }
  | { mode: "catalog"; resolution: Extract<CatalogContextResolution, { status: "ready" }> }
  | { mode: "blocked"; resolution: Exclude<CatalogContextResolution, { status: "ready" }> };

export function isCatalogClientEnabled(env: Record<string, string | boolean | undefined> = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {}): boolean {
  // T25: activo por defecto (INDEX retirado); solo un "false" explícito lo apaga, y entonces la Web muestra un estado fail-closed.
  return String(env[CATALOG_CLIENT_FLAG] ?? "true").toLowerCase() !== "false";
}

export async function chooseLibraryComposition(input: { enabled: boolean; api: CatalogApi; signal?: AbortSignal }): Promise<LibraryComposition> {
  if (!input.enabled) return { mode: "legacy", reason: "flag-off" };
  const resolution = await input.api.resolveContext(input.signal);
  if (resolution.status === "ready") return { mode: "catalog", resolution };
  return { mode: "blocked", resolution };
}

// Copys de estado para la Gallery (plan B §7 y C12-r4 §2), sin pager ni fallback.
export function compositionMessage(c: LibraryComposition): string | null {
  if (c.mode !== "blocked") return null;
  switch (c.resolution.status) {
    case "reset_required": return "Esta biblioteca requiere un reinicio nativo antes de usarse.";
    case "quarantined": return "Esta biblioteca está en cuarentena temporal. Inténtalo más tarde.";
    case "unauthenticated": return "Session expired. Sign in again.";
    case "offline": return "Reconnect to verify your Galer Cloud library.";
    default: return "El catálogo no está disponible en este momento.";
  }
}
