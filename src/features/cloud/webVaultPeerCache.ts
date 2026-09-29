export interface WebVaultPeerRef {
  channelId: number;
  accessHash: { low: number; high: number };
}

function cacheKey(botId: string, chatId: string): string {
  return `beatgaler:web-vault-peer:v1:${botId}:${chatId}`;
}

export function readWebVaultPeer(botId: string, chatId: string): WebVaultPeerRef | null {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey(botId, chatId)) || "null");
    if (!value || !Number.isSafeInteger(value.channelId) || value.channelId <= 0 ||
        !Number.isInteger(value.accessHash?.low) || !Number.isInteger(value.accessHash?.high)) return null;
    return value as WebVaultPeerRef;
  } catch {
    return null;
  }
}

export function writeWebVaultPeer(botId: string, chatId: string, peer: WebVaultPeerRef): void {
  try {
    localStorage.setItem(cacheKey(botId, chatId), JSON.stringify(peer));
  } catch {
    // A private browsing quota failure must not break the live MTProto session.
  }
}

export function clearWebVaultPeer(botId: string, chatId: string): void {
  try { localStorage.removeItem(cacheKey(botId, chatId)); } catch { /* Storage may be unavailable. */ }
}
