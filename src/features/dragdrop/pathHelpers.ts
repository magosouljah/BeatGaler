export function fileNameFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export function extensionFromPath(path: string): string {
  const name = fileNameFromPath(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isBackupFolderPath(path: string): boolean {
  const name = fileNameFromPath(path).trim().toLowerCase();
  return name === "backup" || name === "backups";
}
