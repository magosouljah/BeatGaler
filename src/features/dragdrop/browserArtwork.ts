const IMAGE_URL_EXTENSION = /\.(png|jpe?g|webp|bmp|gif|avif)(?:[?#].*)?$/i;
export const PINTEREST_CLOSEUP_IMAGE_TYPE = "application/x-pinterest-closeup-image";
const TEXT_ARTWORK_TYPES = new Set([
  "text/html",
  "text/uri-list",
  "text/plain",
  "downloadurl",
  PINTEREST_CLOSEUP_IMAGE_TYPE,
]);

function normalizeArtworkUrl(raw: string | null | undefined): string | null {
  let value = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!value) return null;
  if (/^data:image\//i.test(value)) return value;
  if (value.startsWith("//")) value = `https:${value}`;
  if (!/^https?:\/\//i.test(value)) return null;

  try {
    const parsed = new URL(value);
    for (const key of ["imgurl", "mediaurl", "image_url", "imageurl", "url"]) {
      const nested = parsed.searchParams.get(key);
      if (nested && /^https?:\/\//i.test(nested)) return nested;
    }
  } catch {
    // If URL parsing fails but it still looks like HTTP(S), keep the raw value.
  }
  return value;
}

export function isDirectInternetArtworkUrl(raw: string | null | undefined): boolean {
  const url = normalizeArtworkUrl(raw);
  if (!url) return false;
  if (/^data:image\//i.test(url)) return true;
  if (IMAGE_URL_EXTENSION.test(url)) return true;

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "i.pinimg.com" || host.endsWith(".pinimg.com")) return true;
  } catch {}
  return false;
}

function stringsFromArbitraryPayload(raw: string): string[] {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed && !values.includes(trimmed)) values.push(trimmed);
  };

  add(raw);

  // Pinterest has used a custom DataTransfer MIME for close-up images. Treat
  // its payload as opaque: it may be a bare URL today, JSON tomorrow, or HTML.
  // Recursively collect strings instead of depending on one undocumented shape.
  try {
    const parsed = JSON.parse(raw);
    const visit = (value: unknown, depth = 0) => {
      if (depth > 8 || value == null) return;
      if (typeof value === "string") {
        add(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (typeof value === "object") {
        for (const item of Object.values(value as Record<string, unknown>)) visit(item, depth + 1);
      }
    };
    visit(parsed);
  } catch {}

  // Also recover URLs embedded inside CSS/HTML/JSON-ish text without assuming
  // the surrounding payload format. JSON escapes are normalized first.
  const normalized = raw.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");
  for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>\\)\]}]+/gi)) add(match[0]);
  for (const match of normalized.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1]);

  return values;
}

function collectArtworkUrlCandidates(raw: string, type: string, direct: string[], fallback: string[]) {
  const addCandidate = (candidateRaw: string | null | undefined) => {
    const candidate = normalizeArtworkUrl(candidateRaw);
    if (!candidate) return;
    const bucket = isDirectInternetArtworkUrl(candidate) ? direct : fallback;
    if (!bucket.includes(candidate)) bucket.push(candidate);
  };

  const normalizedType = type.toLowerCase();

  if (normalizedType === PINTEREST_CLOSEUP_IMAGE_TYPE) {
    for (const candidate of stringsFromArbitraryPayload(raw)) {
      // If the custom payload contains HTML, reuse the normal HTML parser too.
      if (/<(?:img|a)\b/i.test(candidate)) {
        collectArtworkUrlCandidates(candidate, "text/html", direct, fallback);
      }
      addCandidate(candidate);
    }
    return;
  }

  if (normalizedType === "text/html") {
    try {
      const doc = new DOMParser().parseFromString(raw, "text/html");
      for (const img of Array.from(doc.querySelectorAll("img"))) {
        addCandidate(img.getAttribute("src"));
        addCandidate(img.getAttribute("data-src"));
        addCandidate(img.getAttribute("data-original"));
        addCandidate(img.getAttribute("data-lazy-src"));
        const srcset = img.getAttribute("srcset");
        if (srcset) {
          for (const entry of srcset.split(",")) addCandidate(entry.trim().split(/\s+/)[0] || null);
        }
      }
      for (const anchor of Array.from(doc.querySelectorAll("a[href]"))) {
        addCandidate(anchor.getAttribute("href"));
      }
    } catch {}
    return;
  }

  if (normalizedType === "downloadurl") {
    const first = raw.indexOf(":");
    const second = first >= 0 ? raw.indexOf(":", first + 1) : -1;
    addCandidate(second >= 0 ? raw.slice(second + 1) : raw);
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    addCandidate(line);
  }
}

export function internetImageUrlFromRawEntries(entries: Iterable<[string, string]>): string | null {
  const direct: string[] = [];
  const fallback: string[] = [];
  for (const [type, raw] of entries) {
    if (!raw) continue;
    collectArtworkUrlCandidates(raw, type, direct, fallback);
  }
  return direct[0] ?? fallback[0] ?? null;
}

export function internetImageUrlFromDataTransfer(dataTransfer: DataTransfer): string | null {
  const entries: Array<[string, string]> = [];
  for (const type of [PINTEREST_CLOSEUP_IMAGE_TYPE, "text/html", "DownloadURL", "text/uri-list", "text/plain"]) {
    try {
      const raw = dataTransfer.getData(type);
      if (raw) entries.push([type, raw]);
    } catch {}
  }
  return internetImageUrlFromRawEntries(entries);
}

export type ArtworkDropSource =
  | { kind: "remote"; url: string }
  | { kind: "file"; file: File };

function imageFileFromDataTransfer(dataTransfer: DataTransfer): File | null {
  // FileList can be unexpectedly empty for a cross-browser virtual file in
  // WebView2. DataTransferItem.getAsFile() is a second standards-based path to
  // the exact same drag-store file and must be called while the drop event is live.
  for (const file of Array.from(dataTransfer.files || [])) {
    if (file.type.startsWith("image/") || IMAGE_URL_EXTENSION.test(file.name)) return file;
  }

  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== "file") continue;
    if (item.type && !item.type.startsWith("image/")) continue;
    try {
      const file = item.getAsFile?.() ?? null;
      if (file && (file.type.startsWith("image/") || IMAGE_URL_EXTENSION.test(file.name) || item.type.startsWith("image/"))) {
        return file;
      }
    } catch {}
  }
  return null;
}

export function chooseArtworkSources(
  remoteUrl: string | null | undefined,
  localImage: File | null | undefined,
): ArtworkDropSource[] {
  const sources: ArtworkDropSource[] = [];
  const directRemote = remoteUrl && isDirectInternetArtworkUrl(remoteUrl);

  // Keep both browser representations. File is first because Chromium can hand
  // us the actual image bytes without a network round-trip. The CDN URL is the
  // fallback when the browser virtual file is empty/unreadable.
  if (localImage) sources.push({ kind: "file", file: localImage });
  if (directRemote && remoteUrl) sources.push({ kind: "remote", url: remoteUrl });
  if (remoteUrl && !directRemote) sources.push({ kind: "remote", url: remoteUrl });

  return sources;
}

export function chooseArtworkSource(
  remoteUrl: string | null | undefined,
  localImage: File | null | undefined,
): ArtworkDropSource | null {
  return chooseArtworkSources(remoteUrl, localImage)[0] ?? null;
}

export function artworkSourcesFromDataTransfer(dataTransfer: DataTransfer): ArtworkDropSource[] {
  return chooseArtworkSources(
    internetImageUrlFromDataTransfer(dataTransfer),
    imageFileFromDataTransfer(dataTransfer),
  );
}

/**
 * Snapshot a browser artwork drop while DataTransfer is still readable.
 *
 * WebView2/Chromium can expose a string drag item in `items` while `getData()`
 * returns an empty string. Calling getAsString() synchronously during `drop`
 * schedules a callback with the payload even after the DOM event itself returns.
 * We therefore start every read before returning from the drop listener.
 */
export function captureArtworkSourcesFromDataTransfer(dataTransfer: DataTransfer): Promise<ArtworkDropSource[]> {
  const localImage = imageFileFromDataTransfer(dataTransfer);
  const immediateRemote = internetImageUrlFromDataTransfer(dataTransfer);
  const stringReads: Array<Promise<[string, string] | null>> = [];

  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== "string") continue;
    const type = String(item.type || "").toLowerCase();
    if (!TEXT_ARTWORK_TYPES.has(type)) continue;

    stringReads.push(new Promise(resolve => {
      let settled = false;
      const done = (value: [string, string] | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        item.getAsString?.((raw: string) => done(raw ? [type, raw] : null));
        // A broken platform implementation must not stall the whole drop forever.
        globalThis.setTimeout(() => done(null), 250);
      } catch {
        done(null);
      }
    }));
  }

  if (stringReads.length === 0) {
    return Promise.resolve(chooseArtworkSources(immediateRemote, localImage));
  }

  return Promise.all(stringReads).then(values => {
    const entries = values.filter((value): value is [string, string] => Boolean(value));
    const itemRemote = internetImageUrlFromRawEntries(entries);
    return chooseArtworkSources(itemRemote ?? immediateRemote, localImage);
  });
}

export function artworkSourceFromDataTransfer(dataTransfer: DataTransfer): ArtworkDropSource | null {
  return artworkSourcesFromDataTransfer(dataTransfer)[0] ?? null;
}

export function artworkFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof file.size === "number" && file.size <= 0) {
      reject(new Error("Dropped browser image File was empty."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read dropped image."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Dropped image did not produce a data URL."));
        return;
      }
      const comma = reader.result.indexOf(",");
      if (!/^data:image\//i.test(reader.result) || comma < 0 || reader.result.slice(comma + 1).length < 8) {
        reject(new Error("Dropped browser image File contained no usable image bytes."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function looksLikeArtworkDrop(dataTransfer: DataTransfer): boolean {
  if (artworkSourcesFromDataTransfer(dataTransfer).length > 0) return true;
  if (Array.from(dataTransfer.items || []).some(
    item => item.kind === "file" && item.type.startsWith("image/"),
  )) return true;

  const types = Array.from(dataTransfer.types || []).map(type => type.toLowerCase());
  return types.includes(PINTEREST_CLOSEUP_IMAGE_TYPE) ||
    types.includes("downloadurl") || types.includes("text/html") ||
    types.includes("text/uri-list") || types.includes("text/plain");
}
