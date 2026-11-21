// Piloto F1 — núcleo HTTP privado de los clientes /catalog/v1 del navegador (catalogApi, catalogCommandsApi, catalogMediaClient,
// catalogTransfer). Una sola definición de lo que antes se copiaba en cada uno: credenciales y base por defecto, timeout enlazado
// al AbortSignal del llamador (y su limpieza), error de red tipado y traducción de errores HTTP a CatalogApiError.
// La POLÍTICA sigue en cada cliente y a la vista: qué cabeceras de escritura envía (CSRF, era/época, idempotencia, If-Match),
// cuándo declara Content-Type, cómo lee la respuesta y qué devuelve. El CSRF del `fetch` global (webCsrfFetchCoordinator) se suma
// a esto en producción porque el fetch por defecto es el global.
import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../../components/AccountGate";
import { WEB_CSRF_SESSION_KEY } from "../../auth/webSessionBootstrap";

export class CatalogApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "CatalogApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface CatalogHttpOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: () => string;
  token?: () => string | null;
  csrf?: () => string | null;
  timeoutMs?: number;
}

export interface CatalogHttp {
  /** Token CSRF de la sesión Web (o el inyectado). Cada cliente decide en qué métodos lo envía. */
  readonly csrf: () => string | null;
  /** Envía la petición con Accept/bearer/cookies; `headers` son los de la política del cliente. No interpreta la respuesta. */
  send(method: string, path: string, init?: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<Response>;
}

const readSessionCsrf = () => { try { return sessionStorage.getItem(WEB_CSRF_SESSION_KEY); } catch { return null; } };

export function createCatalogHttp(options: CatalogHttpOptions, defaultTimeoutMs: number): CatalogHttp {
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const baseUrl = options.baseUrl ?? (() => getResolvedCloudApiBase());
  const token = options.token ?? (() => getBeatGalerAuthToken());
  const csrf = options.csrf ?? readSessionCsrf;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  async function send(method: string, path: string, { headers = {}, body, signal }: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
    const all: Record<string, string> = { Accept: "application/json", ...headers };
    const bearer = token();
    if (bearer) all.Authorization = `Bearer ${bearer}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(`${baseUrl()}${path}`, { method, headers: all, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    } catch (error) {
      if (signal?.aborted) throw error; // abort del llamador: se propaga tal cual
      throw Object.assign(new Error("Could not reach BeatGaler Cloud."), { name: "CatalogNetworkError", cause: error }); // red o timeout
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return Object.freeze({ csrf, send });
}

/** Cuerpo JSON tolerante: un cuerpo vacío o no JSON se lee como `{}`. */
export async function readCatalogJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** Error estable a partir de una respuesta no-ok: el código del servidor gana; 401 sin código → UNAUTHENTICATED. */
export function catalogHttpError(response: Response, payload: Record<string, unknown>, detail: Record<string, unknown> = (payload.detail as Record<string, unknown>) ?? {}): CatalogApiError {
  const code = typeof payload.code === "string" ? payload.code : response.status === 401 ? "UNAUTHENTICATED" : `HTTP_${response.status}`;
  return new CatalogApiError(response.status, code, typeof payload.error === "string" ? payload.error : `Galer Cloud HTTP ${response.status}`, detail);
}
