import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Beat } from "../../src/types";
import {
  cloudBeatFingerprint,
  drawerMetadataCommitFingerprint,
  libraryViewFingerprint,
} from "../../src/features/library/libraryFingerprints";
import {
  clearCloudUploadActive,
  markCloudUploadActive,
  readActiveCloudUploads,
} from "../../src/features/cloud/interruptedUploadJournal";
import {
  extensionFromPath,
  fileNameFromPath,
  isBackupFolderPath,
} from "../../src/features/dragdrop/pathHelpers";

const root = process.cwd();
const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
const cache = readFileSync(resolve(root, "src/features/library/libraryPresentationCache.ts"), "utf8");
const fingerprints = readFileSync(resolve(root, "src/features/library/libraryFingerprints.ts"), "utf8");
const journal = readFileSync(resolve(root, "src/features/cloud/interruptedUploadJournal.ts"), "utf8");
const artworkDecode = readFileSync(resolve(root, "src/features/artwork/decodeArtworkDataUrl.ts"), "utf8");
const artworkHydration = readFileSync(resolve(root, "src/features/artwork/useArtworkHydration.ts"), "utf8");

function beat(overrides: Partial<Beat> = {}): Beat {
  return {
    id: "beat-1",
    name: "Beat One",
    bpm: "120",
    key: "Cm",
    tags: ["dark", "trap"],
    rating: 4,
    color: "#111111",
    color2: "#222222",
    mp3_path: "C:\\staging\\beat.mp3",
    wav_path: "C:\\staging\\beat.wav",
    playback_path: "C:\\staging\\play.mp3",
    folder_path: "C:\\staging",
    telegram_file_id: "file-1",
    telegram_message_id: 42,
    image_base64: "data:image/png;base64,AAAA",
    image_preview_base64: null,
    other_files: ["C:\\staging\\notes.txt"],
    ...overrides,
  } as Beat;
}

describe("App 2.3 helper extraction", () => {
  beforeEach(() => localStorage.clear());

  it("moves the requested helper ownership out of App without leaving duplicate implementations", () => {
    for (const importPath of [
      "./features/library/libraryPresentationCache",
      "./features/library/libraryFingerprints",
      "./features/cloud/interruptedUploadJournal",
      "./features/dragdrop/pathHelpers",
    ]) {
      expect(app).toContain(importPath);
    }

    expect(artworkHydration).toContain('from "./decodeArtworkDataUrl"');

    for (const localDefinition of [
      "function fileNameFromPath(",
      "function extensionFromPath(",
      "function isBackupFolderPath(",
      "function readActiveCloudUploads(",
      "function writeActiveCloudUploads(",
      "function markCloudUploadActive(",
      "function clearCloudUploadActive(",
      "function loadCachedBeats(",
      "function saveCachedBeats(",
      "function cloudBeatFingerprint(",
      "function drawerMetadataCommitFingerprint(",
      "function libraryViewFingerprint(",
      "function loadCachedSort(",
      "function saveCachedSort(",
      "function preserveLoadedArtwork(",
      "function clearUploadPreviewCache(",
      "function decodeArtworkDataUrl(",
    ]) {
      expect(app).not.toContain(localDefinition);
    }
  });

  it("preserves every storage key and the artwork decode timeout contract", () => {
    expect(cache).toContain('const LIBRARY_CACHE_KEY = "beatvault:library:v1"');
    expect(cache).toContain('const SORT_CACHE_KEY = "beatvault:sort:v2"');
    expect(cache).toContain('localStorage.removeItem("beatvault:upload-cache:v1")');
    expect(journal).toContain('const INTERRUPTED_UPLOADS_KEY = "beatgaler:active-cloud-uploads:v1"');
    expect(artworkDecode).toContain("window.setTimeout(() => done(false), 2500)");
    expect(artworkDecode).toContain('typeof image.decode === "function"');
  });

  it("preserves the cloud fingerprint fields and keeps presentation artwork out of cloud metadata comparison", () => {
    const original = beat();
    const presentationOnlyChange = beat({
      image_base64: "data:image/png;base64,DIFFERENT",
      image_preview_base64: "data:image/png;base64,PREVIEW",
    });

    expect(cloudBeatFingerprint(presentationOnlyChange)).toBe(cloudBeatFingerprint(original));
    expect(drawerMetadataCommitFingerprint(presentationOnlyChange)).not.toBe(drawerMetadataCommitFingerprint(original));
    expect(fingerprints).toContain('.join("\\u001e")');
    expect(fingerprints).toContain('.join("\\u001d")');
    expect(fingerprints).toContain('.join("\\u001c")');
    expect(libraryViewFingerprint([original])).toContain(original.id);
  });

  it("preserves interrupted-upload journal payloads and staging paths", () => {
    const source = beat({
      samples_path: "C:\\staging\\Samples",
      stems_path: "C:\\staging\\Stems",
      flp_path: "C:\\staging\\Beat.flp",
      als_path: null,
      loop_path: "C:\\staging\\loop.wav",
    });

    markCloudUploadActive(source);
    expect(readActiveCloudUploads()).toEqual([{
      beatId: source.id,
      beatName: source.name,
      stagingPaths: [
        source.mp3_path,
        source.wav_path,
        source.playback_path,
        source.folder_path,
        source.samples_path,
        source.stems_path,
        source.flp_path,
        source.loop_path,
        ...(source.other_files ?? []),
      ],
    }]);

    clearCloudUploadActive(source.id);
    expect(readActiveCloudUploads()).toEqual([]);
    expect(localStorage.getItem("beatgaler:active-cloud-uploads:v1")).toBeNull();
  });

  it("preserves Windows/POSIX path naming, extensions and Backup filtering", () => {
    expect(fileNameFromPath("C:\\Music\\Beat.WAV")).toBe("Beat.WAV");
    expect(fileNameFromPath("/Music/Beat.WAV")).toBe("Beat.WAV");
    expect(extensionFromPath("C:\\Music\\Beat.WAV")).toBe("wav");
    expect(extensionFromPath("README")).toBe("");
    expect(isBackupFolderPath("C:\\Project\\Backup")).toBe(true);
    expect(isBackupFolderPath("/Project/Backups")).toBe(true);
    expect(isBackupFolderPath("/Project/Samples")).toBe(false);
  });
});
