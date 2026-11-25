// Único reemplazo de `globalThis.fetch` del cliente (M7.7b). Sustituye los dos parches anteriores
// (webSession: frontera con credenciales; webCsrfFetchCoordinator: coordinador CSRF) por uno, con una sola bandera.
// Cadena interna, idéntica a la anterior pero SIN capas de window.fetch apiladas:
//   coordinador CSRF (reintento CSRF_REQUIRED, degradado events/ticket) -> frontera de producción (Web) -> fetch nativo.
// En Desktop (platform.kind !== "web") solo se aplica el coordinador, como antes.
import { platform } from "../../platform";
import { createWebCsrfCoordinatedFetch } from "./webCsrfFetchCoordinator";
import { WEB_CSRF_SESSION_KEY } from "./webSessionBootstrap";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type BoundaryWindow = Window & { __beatgalerWebFetchBoundaryInstalled?: boolean };

// X86 (contrato fijado, no corregido): hay DOS clasificadores a propósito.
//  - isCsrfCoordinatedRequest (webCsrfFetchCoordinator.isBeatGalerWebApiRequest) resuelve URL relativas y también
//    cubre tailnet y http://127.0.0.1: esas peticiones reciben CSRF.
//  - isProductionApiBoundaryRequest solo acepta URL absolutas `<origin>/beatgaler-api[/...]`: solo ellas reciben
//    X-BeatGaler-Client y credentials:"include". Relativas/127.0.0.1/tailnet NO los reciben. No unificar sin decisión.
function isProductionApiBoundaryRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const sameOriginProxy = `${window.location.origin}/beatgaler-api`;
  return url === sameOriginProxy || url.startsWith(`${sameOriginProxy}/`);
}

function currentWebCsrfToken(): string {
  if (typeof sessionStorage === "undefined") return "";
  return sessionStorage.getItem(WEB_CSRF_SESSION_KEY) || "";
}

function createProductionBoundaryFetch(nativeFetch: typeof window.fetch): typeof window.fetch {
  return ((input: RequestInfo | URL, init: RequestInit = {}) => {
    if (!isProductionApiBoundaryRequest(input)) return nativeFetch(input, init);
    const requestInput = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const headers = new Headers(init.headers || requestInput?.headers);
    headers.set("X-BeatGaler-Client", "web");
    const method = String(init.method || requestInput?.method || "GET").toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      const csrf = currentWebCsrfToken();
      if (csrf) headers.set("X-BeatGaler-CSRF", csrf);
    }
    return nativeFetch(input, { ...init, headers, credentials: "include" });
  }) as typeof window.fetch;
}

export function installWebFetchBoundary(): void {
  if (typeof window === "undefined") return;
  const tagged = window as BoundaryWindow;
  if (tagged.__beatgalerWebFetchBoundaryInstalled) return;
  tagged.__beatgalerWebFetchBoundaryInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  const inner = platform.kind === "web" ? createProductionBoundaryFetch(nativeFetch) : nativeFetch;
  window.fetch = createWebCsrfCoordinatedFetch(inner);
}
