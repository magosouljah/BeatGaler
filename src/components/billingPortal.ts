import { getBeatGalerAuthToken, resolveBeatGalerCloudApi } from "./AccountGate";
import { syncWebCsrfSessionFromCookie } from "../features/auth/webCsrfFetchCoordinator";

async function portalRequest(path: string, method: "GET" | "POST"): Promise<any> {
  if (!getBeatGalerAuthToken()) throw new Error("Session expired. Sign in again.");
  const base = await resolveBeatGalerCloudApi();
  const headers: Record<string, string> = { "X-BeatGaler-Client": "web" };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    // Match AccountGate's credentialed fetch boundary. A restored session may
    // have a newer token in storage than the value exposed by document.cookie.
    const csrf = sessionStorage.getItem("beatgaler:web-csrf:v1") || syncWebCsrfSessionFromCookie();
    if (csrf) headers["X-BeatGaler-CSRF"] = csrf;
  }
  const response = await fetch(`${base}${path}`, {
    method, headers, credentials: "include", body: method === "POST" ? "{}" : undefined,
  });
  if (!response.ok) throw new Error("Subscriber management is unavailable. Please try again later.");
  return response.json();
}

export async function beatGalerPortalAvailable(): Promise<boolean> {
  return (await portalRequest("/billing/portal/availability", "GET"))?.available === true;
}

export async function openBeatGalerPortal(): Promise<string> {
  const result = await portalRequest("/billing/portal", "POST");
  const value = result?.portal?.url;
  if (typeof value !== "string") throw new Error("Subscriber management is unavailable. Please try again later.");
  const url = new URL(value);
  if (url.protocol !== "https:" || !["sandbox.polar.sh", "polar.sh"].includes(url.hostname) ||
      url.username || url.password || url.port || url.hash) {
    throw new Error("Subscriber management could not be opened securely.");
  }
  return url.toString();
}
