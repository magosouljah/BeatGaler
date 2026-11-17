// Arrastrar y soltar archivos del sistema sobre la Gallery POSTGRES. Solo reacciona a arrastres de archivos (no a reordenar tarjetas ni texto).
import { useEffect, useRef, useState } from "react";

const isAudioFile = (f: File) => /\.(mp3|wav)$/i.test(f.name) || f.type === "audio/mpeg" || f.type === "audio/wav" || f.type === "audio/x-wav";

export function pickDroppedAudio(files: File[]): { kind: "ok"; file: File } | { kind: "none" } | { kind: "many" } {
  const supported = files.filter(isAudioFile);
  if (supported.length === 0) return { kind: "none" };
  if (supported.length > 1 || files.length > 1) return { kind: "many" };
  return { kind: "ok", file: supported[0] };
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

export function useCatalogFileDrop({ enabled, onFiles }: { enabled: boolean; onFiles: (files: File[]) => void }): boolean {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const cb = useRef(onFiles); cb.current = onFiles;
  const on = useRef(enabled); on.current = enabled;
  useEffect(() => { if (!enabled) { depth.current = 0; setActive(false); } }, [enabled]);
  // Los listeners viven siempre: un archivo soltado con un modal abierto NO debe hacer que el navegador navegue al archivo (se ignora).
  useEffect(() => {
    const enter = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (!on.current) return; depth.current += 1; setActive(true); };
    const over = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; };
    const leave = (e: DragEvent) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setActive(false); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth.current = 0; setActive(false);
      if (!on.current) return;
      cb.current(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); };
  }, []);
  return active;
}
