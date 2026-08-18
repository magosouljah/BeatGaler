export interface CachedUpload {
  url: string;
  created_at: number;
}

const KEY = "beatvault:upload-cache:v1";

function loadMap(): Record<string, CachedUpload> {
  try {
	const raw = localStorage.getItem(KEY);
	if (!raw) return {};
	return JSON.parse(raw) as Record<string, CachedUpload>;
  } catch { return {}; }
}

function saveMap(m: Record<string, CachedUpload>) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch {}
}

export function getCachedUpload(hash: string): CachedUpload | null {
  const m = loadMap();
  return m[hash] ?? null;
}

export function setCachedUpload(hash: string, url: string) {
  const m = loadMap();
  m[hash] = { url, created_at: Date.now() };
  saveMap(m);
}

export function clearUploadCache() {
  try { localStorage.removeItem(KEY); } catch {}
}
