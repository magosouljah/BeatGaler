import {
  artworkSourceFromDataTransfer,
  artworkSourcesFromDataTransfer,
  captureArtworkSourcesFromDataTransfer,
  chooseArtworkSource,
  chooseArtworkSources,
  internetImageUrlFromRawEntries,
  isDirectInternetArtworkUrl,
  PINTEREST_CLOSEUP_IMAGE_TYPE,
} from "../src/features/dragdrop/browserArtwork.js";
import { preferredExternalDropEffect } from "../src/features/dragdrop/externalDropEffect.js";
import {
  NATIVE_EXTERNAL_IMAGE_PENDING,
  NATIVE_EXTERNAL_IMAGE_PREFIX,
  nativeExternalImageSignalFromPaths,
} from "../src/features/dragdrop/nativeExternalImage.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const virtualPinterestFile = { name: "pinterest-virtual.jpg", type: "image/jpeg", size: 1234 } as File;
const pinterestDataTransfer = {
  files: [virtualPinterestFile],
  items: [],
  types: ["Files", "text/plain"],
  getData(type: string) {
    if (type === "text/plain") return "https://i.pinimg.com/736x/aa/bb/cc/example.jpg";
    return "";
  },
} as unknown as DataTransfer;

const pinterestSources = artworkSourcesFromDataTransfer(pinterestDataTransfer);
assert(pinterestSources.length === 2, "Pinterest regression: keep BOTH pinimg URL and Chromium virtual File as fallbacks.");
assert(pinterestSources[0]?.kind === "file", "Pinterest regression: Chromium image File should be attempted first (known-working path).");
assert(pinterestSources[1]?.kind === "remote", "Pinterest regression: direct pinimg URL must remain as fallback.");
const pinterest = artworkSourceFromDataTransfer(pinterestDataTransfer);
assert(pinterest?.kind === "file", "Compatibility regression: the primary Pinterest source uses the known-working Chromium File path.");

const explicitFallbacks = chooseArtworkSources("https://i.pinimg.com/736x/a/b/c.jpg", virtualPinterestFile);
assert(explicitFallbacks.length === 2, "Browser artwork regression: selecting a preferred source must never discard the alternate representation.");

// Exact WebView2 regression we just observed: FileList/getData are empty even
// though DataTransfer.items still advertises a browser image + text URL.
const itemOnlyPinterestDataTransfer = {
  files: [],
  types: ["Files", "text/plain", "chromium/x-drag-id"],
  items: [
    {
      kind: "file",
      type: "image/jpeg",
      getAsFile() { return virtualPinterestFile; },
      getAsString() {},
    },
    {
      kind: "string",
      type: "text/plain",
      getAsFile() { return null; },
      getAsString(callback: (value: string) => void) {
        queueMicrotask(() => callback("https://i.pinimg.com/originals/11/22/33/from-item.jpg"));
      },
    },
  ],
  getData() { return ""; },
} as unknown as DataTransfer;

const itemOnlySources = await captureArtworkSourcesFromDataTransfer(itemOnlyPinterestDataTransfer);
assert(itemOnlySources.length === 2, "WebView2 regression: DataTransfer.items must recover BOTH image File and pinimg URL when FileList/getData are empty.");
assert(itemOnlySources[0]?.kind === "file", "WebView2 regression: getAsFile() image must be usable when dataTransfer.files is empty.");
assert(itemOnlySources[1]?.kind === "remote" && itemOnlySources[1].url.includes("i.pinimg.com"), "WebView2 regression: getAsString() must recover Pinterest URL when getData() is empty.");

const stringOnlyPinterestDataTransfer = {
  files: [],
  types: ["text/uri-list"],
  items: [{
    kind: "string",
    type: "text/uri-list",
    getAsFile() { return null; },
    getAsString(callback: (value: string) => void) {
      callback("https://i.pinimg.com/736x/44/55/66/string-only.webp");
    },
  }],
  getData() { return ""; },
} as unknown as DataTransfer;
const stringOnlySources = await captureArtworkSourcesFromDataTransfer(stringOnlyPinterestDataTransfer);
assert(stringOnlySources[0]?.kind === "remote", "WebView2 regression: string DataTransferItem alone must be enough to recover internet artwork.");


// Exact Pinterest/WebView2 payload observed on Windows: no Files/text/plain at
// all, only Pinterest's custom close-up MIME plus Chromium's private drag id.
const pinterestCustomMimeUrl = {
  files: [],
  items: [],
  types: [PINTEREST_CLOSEUP_IMAGE_TYPE, "chromium/x-drag-id"],
  getData(type: string) {
    if (type === PINTEREST_CLOSEUP_IMAGE_TYPE) {
      return "https://i.pinimg.com/736x/de/ad/be/custom-closeup.jpg";
    }
    return "";
  },
} as unknown as DataTransfer;
const pinterestCustomMimeUrlSources = await captureArtworkSourcesFromDataTransfer(pinterestCustomMimeUrl);
assert(
  pinterestCustomMimeUrlSources[0]?.kind === "remote" && pinterestCustomMimeUrlSources[0].url.includes("i.pinimg.com"),
  "Pinterest custom-MIME regression: application/x-pinterest-closeup-image must be treated as artwork and recover a bare pinimg URL.",
);

const pinterestCustomMimeJson = {
  files: [],
  items: [],
  types: [PINTEREST_CLOSEUP_IMAGE_TYPE, "chromium/x-drag-id"],
  getData(type: string) {
    if (type === PINTEREST_CLOSEUP_IMAGE_TYPE) {
      return JSON.stringify({ pin: { images: { originals: { url: "https://i.pinimg.com/originals/ca/fe/00/custom-json.webp" } } } });
    }
    return "";
  },
} as unknown as DataTransfer;
const pinterestCustomMimeJsonSources = await captureArtworkSourcesFromDataTransfer(pinterestCustomMimeJson);
assert(
  pinterestCustomMimeJsonSources[0]?.kind === "remote" && pinterestCustomMimeJsonSources[0].url.includes("custom-json.webp"),
  "Pinterest custom-MIME regression: nested JSON payloads must recover the image URL without depending on Pinterest's object shape.",
);

const fromRaw = internetImageUrlFromRawEntries([
  ["text/plain", "https://www.pinterest.com/pin/123"],
  ["text/uri-list", "https://i.pinimg.com/originals/aa/bb/cc/image.webp"],
]);
assert(fromRaw?.includes("i.pinimg.com"), "Artwork parser must prefer a direct image URL over a Pinterest page URL.");

const noMimeLocalImage = { name: "cover.webp", type: "", size: 100 } as File;
const noMimeDataTransfer = {
  files: [noMimeLocalImage],
  items: [],
  types: ["Files"],
  getData() { return ""; },
} as unknown as DataTransfer;
const noMime = artworkSourceFromDataTransfer(noMimeDataTransfer);
assert(noMime?.kind === "file", "Local artwork regression: image extension must work even when WebView2 omits MIME type.");

const localFile = { name: "cover.png", type: "image/png", size: 100 } as File;
const localOnly = chooseArtworkSource(null, localFile);
assert(localOnly?.kind === "file", "Local artwork regression: a real local image must still be accepted.");

const pageUrlWithFile = chooseArtworkSource("https://www.pinterest.com/pin/123456/", localFile);
assert(pageUrlWithFile?.kind === "file", "Safety regression: a normal webpage URL must not replace a valid local image File.");

const pageUrlOnly = chooseArtworkSource("https://www.pinterest.com/pin/123456/", null);
assert(pageUrlOnly?.kind === "remote", "Browser artwork regression: a page URL should remain usable when no File is available.");

assert(isDirectInternetArtworkUrl("https://i.pinimg.com/originals/aa/bb/cc/image.webp"), "pinimg CDN URLs must be recognized as direct artwork.");
assert(isDirectInternetArtworkUrl("https://example.com/cover.jpg?size=large"), "Direct image URLs with query strings must be recognized.");
assert(!isDirectInternetArtworkUrl("https://www.pinterest.com/pin/123456/"), "Pinterest page URLs must not be treated as image bytes.");


const nativePending = nativeExternalImageSignalFromPaths([NATIVE_EXTERNAL_IMAGE_PENDING]);
assert(nativePending?.kind === "pending", "Native Option-2 regression: external browser Enter sentinel must stay separate from filesystem paths.");

const nativePinterestUrl = "https://i.pinimg.com/736x/ab/cd/ef/native-option-2.webp";
const nativePinterestMarker = `${NATIVE_EXTERNAL_IMAGE_PREFIX}${encodeURIComponent(nativePinterestUrl)}`;
const nativePinterest = nativeExternalImageSignalFromPaths([nativePinterestMarker]);
assert(
  nativePinterest?.kind === "drop" && nativePinterest.url === nativePinterestUrl && nativePinterest.source === "pinterest",
  "Native Option-2 regression: WRY browser-image marker must decode into a Pinterest artwork event.",
);

assert(
  nativeExternalImageSignalFromPaths([String.raw`E:\\Beats\\native-local\\beat.mp3`]) === null,
  "Native Option-2 regression: a real Windows path must never be classified as browser artwork.",
);
assert(
  nativeExternalImageSignalFromPaths([String.raw`E:\\Beats\\cover.webp`]) === null,
  "Native Option-2 regression: local artwork must remain on CF_HDROP/path routing.",
);

console.log("PASS native Option-2 bridge regressions: pending/url sentinels are isolated from real Windows paths");

console.log("PASS drag/drop regressions: Pinterest FileList + DataTransferItem + custom-MIME fallbacks");

assert(preferredExternalDropEffect("link") === "link", "Browser drag regression: link-only sources must not be forced to copy.");
assert(preferredExternalDropEffect("linkMove") === "link", "Browser drag regression: linkMove must choose an allowed effect.");
assert(preferredExternalDropEffect("copyLink") === "copy", "Browser drag regression: copyLink should prefer copy.");
assert(preferredExternalDropEffect("all") === "copy", "Browser drag regression: unrestricted sources should use copy.");

console.log("PASS external drag cursor regressions: accepted effect matches source");
