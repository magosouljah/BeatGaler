const WEB_CLIENT_ID_KEY = "beatgaler:web-client-id:v1";

function createClientId(): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `beatgaler-web-${suffix}`;
}

let fallbackClientId: string | null = null;

/** Stable browser installation identity without requiring the full Web adapter. */
export function getWebClientId(): string {
  if (typeof window === "undefined") {
    fallbackClientId ||= createClientId();
    return fallbackClientId;
  }

  try {
    const existing = window.localStorage.getItem(WEB_CLIENT_ID_KEY);
    if (existing) return existing;
    const created = createClientId();
    window.localStorage.setItem(WEB_CLIENT_ID_KEY, created);
    return created;
  } catch {
    fallbackClientId ||= createClientId();
    return fallbackClientId;
  }
}
