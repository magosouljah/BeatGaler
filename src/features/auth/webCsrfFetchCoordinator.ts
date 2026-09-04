import {
  WEB_CSRF_COOKIE_NAME,
  WEB_CSRF_SESSION_KEY,
  readWebCookieValue,
} from "./webSessionBootstrap";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const REMOTE_API_HOST = "desktop-7l93a0j.tailabe8ff.ts.net";

type BeatGalerWindow = Window & {
  __beatgalerCsrfFetchCoordinatorInstalled?: boolean;
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return String(init.method).toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return String(input.method || "GET").toUpperCase();
  return "GET";
}

function parsedRequestUrl(input: RequestInfo | URL): URL | null {
  if (typeof window === "undefined") return null;
  try {
    return new URL(requestUrl(input), window.location.href);
  } catch {
    return null;
  }
}

export function isBeatGalerWebApiRequest(input: RequestInfo | URL): boolean {
  const url = parsedRequestUrl(input);
  if (!url || typeof window === "undefined") return false;
  if (url.origin === window.location.origin && url.pathname.startsWith("/beatgaler-api/")) return true;
  if (url.hostname === REMOTE_API_HOST) return true;
  return url.protocol === "http:" && url.hostname === "127.0.0.1";
}

function isEventTicketRequest(input: RequestInfo | URL): boolean {
  const url = parsedRequestUrl(input);
  return Boolean(url?.pathname.endsWith("/events/ticket"));
}

export function syncWebCsrfSessionFromCookie(): string {
  if (typeof document === "undefined" || typeof window === "undefined") return "";
  let cookieToken = "";
  try {
    cookieToken = readWebCookieValue(document.cookie, WEB_CSRF_COOKIE_NAME);
  } catch {
    return "";
  }
  if (!cookieToken) return "";
  try {
    window.sessionStorage.setItem(WEB_CSRF_SESSION_KEY, cookieToken);
  } catch {}
  return cookieToken;
}

async function responseCode(response: Response): Promise<string> {
  try {
    const payload = await response.clone().json();
    return String(payload?.code || "");
  } catch {
    return "";
  }
}

function requestCanBeReplayed(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (typeof Request !== "undefined" && input instanceof Request) return false;
  const body = init?.body;
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return false;
  return true;
}

function degradedEventTicketResponse(response: Response, code: string): Response {
  const detail = {
    state: "degraded" as const,
    source: "event_ticket" as const,
    status: response.status,
    code: code || `HTTP_${response.status}`,
  };
  console.warn("[event-sync] ticket authorization degraded; transport state unchanged", detail);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("beatgaler:event-sync-status", { detail }));
  }
  return new Response(JSON.stringify({
    ok: false,
    ticket: null,
    event_sync_status: detail.state,
    code: detail.code,
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function createWebCsrfCoordinatedFetch(delegate: typeof window.fetch): typeof window.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = requestMethod(input, init);
    const beatGalerApi = isBeatGalerWebApiRequest(input);
    const unsafe = beatGalerApi && !SAFE_METHODS.has(method);

    if (unsafe) syncWebCsrfSessionFromCookie();

    let response = await delegate(input, init);
    let code = response.status === 403 ? await responseCode(response) : "";

    // CSRF_REQUIRED is rejected by session-security before route execution, so
    // one replay is safe: no application mutation was admitted by the failed
    // request. Re-read the browser cookie first so the retried header and cookie
    // are coherent even when /auth/session rotated CSRF concurrently.
    if (
      unsafe &&
      response.status === 403 &&
      code === "CSRF_REQUIRED" &&
      requestCanBeReplayed(input, init)
    ) {
      syncWebCsrfSessionFromCookie();
      response = await delegate(input, init);
      code = response.status === 403 ? await responseCode(response) : "";
    }

    // Event authorization is a secondary sync channel. An HTTP 403 proves the
    // BeatGaler API was reachable; it must not downgrade transport/playback to
    // "poor". Preserve the failure as explicit event-sync diagnostics while the
    // legacy App listener simply sees "no ticket" and leaves connection state
    // unchanged. Network exceptions and EventSource transport failures still
    // propagate through the existing connectivity path.
    if (
      beatGalerApi &&
      isEventTicketRequest(input) &&
      response.status === 403 &&
      (typeof navigator === "undefined" || navigator.onLine !== false)
    ) {
      return degradedEventTicketResponse(response, code);
    }

    return response;
  }) as typeof window.fetch;
}

export function installWebCsrfFetchCoordinator(): void {
  if (typeof window === "undefined") return;
  const taggedWindow = window as BeatGalerWindow;
  if (taggedWindow.__beatgalerCsrfFetchCoordinatorInstalled) return;
  taggedWindow.__beatgalerCsrfFetchCoordinatorInstalled = true;
  const delegate = window.fetch.bind(window);
  window.fetch = createWebCsrfCoordinatedFetch(delegate);
}
