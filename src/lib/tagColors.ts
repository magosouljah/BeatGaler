// Colores de tags (paleta estilo Apple), persistidos y compartidos entre
// todos los lugares donde se muestran tags (barra de filtro arriba,
// TagPill en BeatCard/Drawer, etc). Mismo patrón que jobStore.ts: un store
// chico fuera de React para que cualquier componente lea/escriba sin
// prop drilling.
import { useEffect, useState } from "react";

export interface TagColorOption {
  key: string;
  label: string;
  hex: string;
}

export const TAG_COLOR_PALETTE: TagColorOption[] = [
  { key: "red", label: "Rojo", hex: "#FF3B30" },
  { key: "orange", label: "Naranja", hex: "#FF9500" },
  { key: "yellow", label: "Amarillo", hex: "#FFCC00" },
  { key: "green", label: "Verde", hex: "#34C759" },
  { key: "blue", label: "Azul", hex: "#007AFF" },
  { key: "purple", label: "Morado", hex: "#AF52DE" },
  { key: "gray", label: "Gris", hex: "#8E8E93" },
];

type TagColorMap = Record<string, string>; // tag (lowercase) -> hex

const STORAGE_KEY = "beatvault:tag-colors:v1";

function loadColors(): TagColorMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let colors: TagColorMap = loadColors();
type Listener = (colors: TagColorMap) => void;
let listeners: Listener[] = [];

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(colors)); } catch { /* ignore */ }
}
function notify() {
  for (const l of listeners) l(colors);
}
function key(tag: string) { return tag.trim().toLowerCase(); }

export function getTagColor(tag: string): string | null {
  return colors[key(tag)] ?? null;
}

// hex === null limpia el color ("Ninguno")
export function setTagColor(tag: string, hex: string | null) {
  const next = { ...colors };
  if (hex) next[key(tag)] = hex; else delete next[key(tag)];
  colors = next;
  persist();
  notify();
}

export function subscribeTagColors(fn: Listener): () => void {
  listeners = [...listeners, fn];
  fn(colors);
  return () => { listeners = listeners.filter(l => l !== fn); };
}

// Mapa completo — lo usa la barra de filtro para pintar todos los botones.
export function useTagColors(): TagColorMap {
  const [state, setState] = useState<TagColorMap>(colors);
  useEffect(() => subscribeTagColors(setState), []);
  return state;
}

// Un solo tag — lo usa TagPill (BeatCard, Drawer, etc).
export function useTagColor(tag: string): string | null {
  const all = useTagColors();
  return all[key(tag)] ?? null;
}

// Moves a persisted color when a tag is renamed globally.
export function renameTagColor(oldTag: string, newTag: string) {
  const oldKey = key(oldTag);
  const newKey = key(newTag);
  if (!oldKey || !newKey || oldKey === newKey) return;
  const next = { ...colors };
  if (next[oldKey] && !next[newKey]) next[newKey] = next[oldKey];
  delete next[oldKey];
  colors = next;
  persist();
  notify();
}
