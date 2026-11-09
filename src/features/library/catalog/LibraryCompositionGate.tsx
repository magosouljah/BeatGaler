// T16 / V08-A — Puerta de composición por autoridad (plan B §3; NATIVO r2.1 §2/§3.3; C12-r4 §2).
// LEGACY conserva su árbol actual intacto (children); POSTGRES monta el workspace del catálogo (Gallery virtualizada, sin pager, sin
// cache global de beats ni reload/reconcile INDEX); un contexto bloqueado o desconocido NUNCA monta el camino LEGACY: muestra el estado
// con el copy de plan B §7 (fail-closed). El cambio de autoridad/cuenta remonta de forma controlada mediante la clave de composición.
import type { ReactNode } from "react";
import { compositionMessage, type LibraryComposition } from "./catalogComposition";

export type LibraryCompositionState = { status: "resolving" } | { status: "resolved"; composition: LibraryComposition; key: string };

export interface LibraryCompositionGateProps {
  state: LibraryCompositionState;
  /** Árbol LEGACY actual (pager + App). Solo se monta con `mode: legacy`. */
  legacy: ReactNode;
  /** Workspace POSTGRES (V05–V07). Solo se monta con `mode: catalog`. */
  catalog: (composition: Extract<LibraryComposition, { mode: "catalog" }>) => ReactNode;
}

export function LibraryCompositionGate({ state, legacy, catalog }: LibraryCompositionGateProps) {
  if (state.status === "resolving") {
    return <main className="bg-product-gallery" data-catalog-mode="resolving" aria-busy="true" aria-label="Verificando la biblioteca" data-library-composition="resolving" />;
  }
  const c = state.composition;
  if (c.mode === "legacy") return <div data-library-composition="legacy" key={state.key}>{legacy}</div>;
  if (c.mode === "catalog") return <div data-library-composition="catalog" data-catalog-epoch={c.resolution.context.authority_epoch} key={state.key}>{catalog(c)}</div>;
  // blocked: unknown/reset/quarantine/unauthenticated/offline → estado visible, ningún fallback a INDEX
  return (
    <main className="bg-product-gallery" data-catalog-mode="postgres" data-library-composition="blocked" data-blocked-status={c.resolution.status} role="status" aria-live="polite">
      <p className="bg-catalog-state">{compositionMessage(c)}</p>
    </main>
  );
}
