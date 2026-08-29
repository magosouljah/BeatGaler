import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";
import { getWebClientId } from "../../platform/webClientId";

export interface WebLibraryBootstrapResult {
  status: "created" | "existing";
  messageId: number;
  manifest: unknown;
}

export function isMissingWebLibraryIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /library index (?:is still synchronizing|is not available)/i.test(message);
}

export async function ensureWebLibraryIndex(): Promise<WebLibraryBootstrapResult> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const response = await fetch(`${getResolvedCloudApiBase()}/transport/index/ensure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ beatgalerUserId: getWebClientId() }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `Galer Cloud HTTP ${response.status}`);
  const messageId = Number(payload?.message_id || 0);
  const status = payload?.status === "created" ? "created" : payload?.status === "existing" ? "existing" : null;
  if (!status || !Number.isInteger(messageId) || messageId <= 0 || !payload?.manifest) {
    throw new Error("Galer Cloud returned incomplete atomic library bootstrap information.");
  }
  return { status, messageId, manifest: payload.manifest };
}
