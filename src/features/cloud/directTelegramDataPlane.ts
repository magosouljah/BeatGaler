import { getBeatGalerAuthToken, getResolvedCloudApiBase } from "../../components/AccountGate";
import { platform } from "../../platform";

export type DirectTelegramStatus = {
  ok: boolean;
  linked: boolean;
  telegram_user_id: string | null;
  telegram_username: string | null;
  transport: "mtproto-user-session";
  control_plane: "beatgaler-backend";
};

export type DirectTelegramLease = {
  ok: boolean;
  lease_id: string;
  expires_at: number;
  telegram_user_id: string;
  storage_chat_id: string;
  message_thread_id: number | null;
  invite_link: string;
  beat_id: string;
  beat_name: string;
  file_type: string;
};

export type DirectTelegramCommit = {
  ok: boolean;
  telegram_file_id: string;
  telegram_message_id: number;
  filename: string | null;
  size: number | null;
  direct_data_plane: true;
};

async function directRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getBeatGalerAuthToken();
  if (!token) throw new Error("Session expired. Sign in again.");
  const base = getResolvedCloudApiBase();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(body?.error || `BeatGaler Cloud HTTP ${response.status}`);
  return body as T;
}

export async function beginDirectTelegramIdentityLink(): Promise<void> {
  const result = await directRequest<{ ok: true; telegram_url: string; expires_at: number }>(
    "/data-plane/telegram/link/start",
    { method: "POST", body: "{}" },
  );
  await platform.external.openUrl(result.telegram_url);
}

export async function getDirectTelegramStatus(): Promise<DirectTelegramStatus> {
  return directRequest<DirectTelegramStatus>("/data-plane/telegram/status", { method: "GET" });
}

export async function createDirectTelegramLease(input: {
  beatId: string;
  beatName: string;
  fileType: "MASTER" | "WAV" | "LOOP" | "PROJECT" | "STEMS" | "OTHER" | "DOWNLOAD";
  mode: "upload" | "download";
}): Promise<DirectTelegramLease> {
  return directRequest<DirectTelegramLease>("/data-plane/telegram/lease", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function commitDirectTelegramUpload(leaseId: string, messageId: number): Promise<DirectTelegramCommit> {
  return directRequest<DirectTelegramCommit>("/data-plane/telegram/commit-upload", {
    method: "POST",
    body: JSON.stringify({ leaseId, messageId }),
  });
}

export async function revokeDirectTelegramLease(leaseId: string): Promise<void> {
  await directRequest<{ ok: true }>("/data-plane/telegram/revoke", {
    method: "POST",
    body: JSON.stringify({ leaseId }),
  });
}
