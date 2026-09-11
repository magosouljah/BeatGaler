import JSZip from "jszip";
import { readBlobAsArrayBuffer } from "../audio/mp3Metadata";
import { isProjectDawExtension, projectExtensionFromName } from "./projectFileTypes";

export type PreparedBrowserProject = {
  file: File;
  openable: boolean;
  hasFlp: boolean;
  hasAls: boolean;
  hasSamples: boolean;
};

const MAX_PROJECT_ZIP_ENTRIES = 100_000;

function safeArchiveBase(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "").trim() || "Beat";
}

function normalizedParts(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function isBackupEntry(path: string): boolean {
  return normalizedParts(path).some(part => /^(backup|backups)$/i.test(part));
}

function isDawEntry(path: string): boolean {
  return normalizedParts(path).some(part => isProjectDawExtension(projectExtensionFromName(part)));
}

function hasSamplesEntry(path: string): boolean {
  return normalizedParts(path).some(part => /^(sample|samples)$/i.test(part));
}

/** PROJECT ZIP drops stay full replacements. Raw DAW files are the only path that merges into the current PROJECT. */
export async function prepareBrowserProjectArchive(
  beatName: string,
  incoming: File,
  existingProject: File | null,
): Promise<PreparedBrowserProject> {
  const extension = projectExtensionFromName(incoming.name);
  if (extension === "zip") {
    return { file: incoming, openable: false, hasFlp: false, hasAls: false, hasSamples: false };
  }
  if (!isProjectDawExtension(extension)) throw new Error("Choose a supported DAW project file or PROJECT ZIP.");

  const zip = existingProject ? await JSZip.loadAsync(await readBlobAsArrayBuffer(existingProject)) : new JSZip();
  const existingNames = Object.keys(zip.files);
  if (existingNames.length > MAX_PROJECT_ZIP_ENTRIES) throw new Error("The PROJECT ZIP contains too many files.");

  for (const name of existingNames) {
    if (isBackupEntry(name) || isDawEntry(name)) zip.remove(name);
  }
  zip.file(incoming.name, await readBlobAsArrayBuffer(incoming));

  const finalNames = Object.keys(zip.files).filter(name => !zip.files[name]?.dir);
  const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return {
    file: new File([bytes], `${safeArchiveBase(beatName)}.zip`, { type: "application/zip", lastModified: Date.now() }),
    openable: true,
    hasFlp: finalNames.some(name => projectExtensionFromName(name) === "flp"),
    hasAls: finalNames.some(name => projectExtensionFromName(name) === "als"),
    hasSamples: finalNames.some(hasSamplesEntry),
  };
}
