import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";

export async function fetchInternetArtworkDataUrl(url: string): Promise<string> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("BeatGaler account session is missing.");

  const response = await fetch(`${getResolvedCloudApiBase()}/image/fetch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ url }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload?.data_url !== "string") {
    throw new Error(payload?.error || `Image fetch failed (${response.status}).`);
  }
  return payload.data_url;
}
