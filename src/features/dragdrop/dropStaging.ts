import type { Beat } from "../../types";
import { isTauriAvailable } from "../../lib/tauri";

export type HtmlDroppedRoot = { path: string; kind: "file" | "directory" };

type HtmlStagedFile = { file: File; relativePath: string };
type CapturedHtmlDropItem = {
  file: File | null;
  entry: any | null;
  handlePromise: Promise<any> | null;
};
export type CapturedHtmlDrop = {
  files: File[];
  items: CapturedHtmlDropItem[];
};

export async function cleanupStagedDropPaths(paths: string[]): Promise<void> {
  if (!isTauriAvailable || paths.length === 0) return;
  const { remove } = await import("@tauri-apps/plugin-fs");
  const sessions = new Set<string>();
  for (const raw of paths) {
    const normalized = raw.replace(/\\/g, "/");
    const marker = "/drop-staging/";
    const index = normalized.toLowerCase().indexOf(marker);
    if (index < 0) continue;
    const after = normalized.slice(index + marker.length);
    const sessionId = after.split("/")[0];
    if (!sessionId) continue;
    sessions.add(normalized.slice(0, index + marker.length) + sessionId);
  }
  for (const session of sessions) {
    try { await remove(session, { recursive: true }); }
    catch (error) { console.warn("Could not clean drop staging session:", session, error); }
  }
}

export function dropStagingSessionId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, "/");
  const marker = "/drop-staging/";
  const index = normalized.toLowerCase().indexOf(marker);
  if (index < 0) return null;
  const after = normalized.slice(index + marker.length);
  return after.split("/")[0] || null;
}

export async function cleanupOrphanedDropStaging(beats: Beat[]): Promise<void> {
  if (!isTauriAvailable) return;
  try {
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const { readDir, remove } = await import("@tauri-apps/plugin-fs");
    const root = await join(await appDataDir(), "drop-staging");

    const protectedSessions = new Set<string>();
    const protectPath = (path: string | null | undefined) => {
      const sessionId = dropStagingSessionId(path);
      if (sessionId) protectedSessions.add(sessionId.toLowerCase());
    };

    for (const beat of beats) {
      protectPath(beat.mp3_path);
      protectPath(beat.wav_path);
      protectPath(beat.playback_path);
      protectPath(beat.folder_path);
      protectPath(beat.samples_path);
      protectPath(beat.stems_path);
      protectPath(beat.flp_path);
      protectPath(beat.als_path);
      protectPath(beat.loop_path);
      for (const path of beat.other_files ?? []) protectPath(path);
    }

    const entries = await readDir(root);
    for (const entry of entries) {
      if (!entry.isDirectory || protectedSessions.has(entry.name.toLowerCase())) continue;
      try {
        await remove(await join(root, entry.name), { recursive: true });
      } catch (error) {
        console.warn("Could not clean orphaned drop staging session:", entry.name, error);
      }
    }
  } catch {
    // Missing directory is the normal case on a clean install.
  }
}

function safeDropRelativePath(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .split("/")
    .filter(part => part && part !== "." && part !== "..")
    .join("/");
}

// Chromium/WebView2 only guarantees access to DataTransfer's file store while
// the synchronous drop event is running. Capture every durable reference now.
export function captureHtmlDrop(dataTransfer: DataTransfer): CapturedHtmlDrop {
  const files = Array.from(dataTransfer.files || []);
  const items: CapturedHtmlDropItem[] = [];

  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== "file") continue;

    let file: File | null = null;
    let entry: any | null = null;
    let handlePromise: Promise<any> | null = null;

    try { file = item.getAsFile(); } catch {}
    try { entry = (item as any).webkitGetAsEntry?.() ?? null; } catch {}
    try {
      const getHandle = (item as any).getAsFileSystemHandle;
      if (typeof getHandle === "function") {
        handlePromise = Promise.resolve(getHandle.call(item));
      }
    } catch {}

    items.push({ file, entry, handlePromise });
  }

  return { files, items };
}

async function collectHtmlFileSystemHandle(handle: any, prefix: string, files: HtmlStagedFile[]): Promise<void> {
  const current = safeDropRelativePath(prefix ? `${prefix}/${handle.name}` : handle.name);
  if (!current) return;
  if (handle.kind === "file") {
    const file = await handle.getFile();
    files.push({ file, relativePath: current });
    return;
  }
  if (handle.kind !== "directory") return;
  for await (const child of handle.values()) {
    await collectHtmlFileSystemHandle(child, current, files);
  }
}

async function collectHtmlDropEntry(entry: any, prefix: string, files: HtmlStagedFile[]): Promise<void> {
  const current = safeDropRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
  if (!current) return;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    files.push({ file, relativePath: current });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = entry.createReader();
  while (true) {
    const batch = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await collectHtmlDropEntry(child, current, files);
  }
}

export async function stageCapturedHtmlDrop(captured: CapturedHtmlDrop): Promise<HtmlDroppedRoot[]> {
  if (!isTauriAvailable) return [];
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const { mkdir, writeFile, remove } = await import("@tauri-apps/plugin-fs");
  const sessionId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stageRoot = await join(await appDataDir(), "drop-staging", sessionId);
  await mkdir(stageRoot, { recursive: true });

  const stagedFiles: HtmlStagedFile[] = [];
  const roots: Array<{ name: string; kind: "file" | "directory" }> = [];

  for (const capturedItem of captured.items) {
    let handled = false;

    if (capturedItem.handlePromise) {
      try {
        const handle = await capturedItem.handlePromise;
        if (handle) {
          const rootName = safeDropRelativePath(handle.name);
          if (rootName) roots.push({ name: rootName, kind: handle.kind === "directory" ? "directory" : "file" });
          await collectHtmlFileSystemHandle(handle, "", stagedFiles);
          handled = true;
        }
      } catch (error) {
        console.warn("FileSystemHandle drop fallback:", error);
      }
    }
    if (handled) continue;

    if (capturedItem.entry) {
      try {
        const entry = capturedItem.entry;
        const rootName = safeDropRelativePath(entry.name);
        if (rootName) roots.push({ name: rootName, kind: entry.isDirectory ? "directory" : "file" });
        await collectHtmlDropEntry(entry, "", stagedFiles);
        handled = true;
      } catch (error) {
        console.warn("webkitGetAsEntry drop fallback:", error);
      }
    }
    if (handled) continue;

    if (capturedItem.file) {
      const name = safeDropRelativePath((capturedItem.file as any).webkitRelativePath || capturedItem.file.name);
      if (name) {
        roots.push({ name: name.split("/")[0], kind: "file" });
        stagedFiles.push({ file: capturedItem.file, relativePath: name });
      }
    }
  }

  if (stagedFiles.length === 0) {
    for (const file of captured.files) {
      const relativePath = safeDropRelativePath((file as any).webkitRelativePath || file.name);
      if (!relativePath) continue;
      stagedFiles.push({ file, relativePath });
      roots.push({ name: relativePath.split("/")[0], kind: "file" });
    }
  }

  if (stagedFiles.length === 0) {
    try { await remove(stageRoot, { recursive: true }); } catch {}
    return [];
  }

  for (const staged of stagedFiles) {
    const segments = staged.relativePath.split("/");
    const target = await join(stageRoot, ...segments);
    if (segments.length > 1) {
      const parent = await join(stageRoot, ...segments.slice(0, -1));
      await mkdir(parent, { recursive: true });
    }
    const bytes = new Uint8Array(await staged.file.arrayBuffer());
    await writeFile(target, bytes);
  }

  const unique = new Map<string, HtmlDroppedRoot>();
  for (const root of roots) {
    const path = await join(stageRoot, root.name);
    unique.set(`${root.kind}:${path}`, { path, kind: root.kind });
  }
  return Array.from(unique.values());
}
