export const PROJECT_DAW_EXTENSIONS = ["flp", "als", "logicx", "rpp", "ptx", "ptf"] as const;

export type ProjectDawExtension = typeof PROJECT_DAW_EXTENSIONS[number];

export function isProjectDawExtension(value: string): value is ProjectDawExtension {
  const normalized = value.trim().replace(/^\./, "").toLowerCase();
  return (PROJECT_DAW_EXTENSIONS as readonly string[]).includes(normalized);
}

export function projectExtensionFromName(name: string): string {
  const clean = name.trim().toLowerCase();
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1) : "";
}

export function isProjectDawFileName(name: string): boolean {
  return isProjectDawExtension(projectExtensionFromName(name));
}

export const PROJECT_DAW_ACCEPT = PROJECT_DAW_EXTENSIONS.map(extension => `.${extension}`).join(",");
