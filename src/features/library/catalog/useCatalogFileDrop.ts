// Arrastrar y soltar archivos del sistema (o una imagen de una página) sobre la Gallery POSTGRES. No reacciona a reordenar tarjetas ni a texto.
// Indicadores: se reutilizan los eventos y visuales aprobados del BeatGaler anterior que pinta BeatCard:
//   «beatgaler:artwork-drag»     → anillo verde + «Drop image» sobre la PORTADA (imagen sobre cualquier zona de la tarjeta);
//   «beatgaler:beat-update-drag» → contorno verde de la tarjeta (audio/archivo → reemplazo de audio);
//   sin tarjeta bajo el cursor    → banner global «Suelta aquí para agregar como beat aparte».
// La zona de la tarjeta NO decide la acción: la decide el tipo de archivo (ver catalogDropKinds).
import { useEffect, useRef, useState } from "react";
import { captureArtworkSourcesFromDataTransfer, looksLikeArtworkDrop, type ArtworkDropSource } from "../../dragdrop/browserArtwork";
import { classifyDragPayload, type DragPayloadKind } from "./catalogDropKinds";

export interface CatalogDropEvent {
  files: File[];
  /** Fuentes de imagen capturadas SÍNCRONAMENTE en el drop (el DataTransfer solo es legible durante el evento); null si no parece una imagen. */
  artwork: Promise<ArtworkDropSource[]> | null;
  /** BeatCard bajo el cursor al soltar, o null (espacio vacío → beat nuevo). */
  targetBeatId: string | null;
}

const hasFiles = (e: DragEvent) => { const dt = e.dataTransfer; return Boolean(dt) && (Array.from(dt!.types ?? []).includes("Files") || Array.from(dt!.items ?? []).some((i) => i.kind === "file")); };
const isExternalPayload = (e: DragEvent) => { const dt = e.dataTransfer; return Boolean(dt) && (hasFiles(e) || looksLikeArtworkDrop(dt!)); };

/** Id de la BeatCard bajo el cursor: cualquier punto de la tarjeta cuenta (portada, título, tags, huecos). */
export const cardUnder = (e: Pick<DragEvent, "target">): string | null => {
  const t = e.target;
  const el = t instanceof Element ? t : t instanceof Node ? t.parentElement : null;
  const card = el?.closest("[data-beat-card-id],[data-card]");
  return card?.getAttribute("data-beat-card-id") ?? card?.getAttribute("data-card") ?? null;
};

const dispatchUi = (artworkBeatId: string | null, updateBeatId: string | null) => {
  window.dispatchEvent(new CustomEvent("beatgaler:artwork-drag", { detail: { beatId: artworkBeatId, active: Boolean(artworkBeatId) } }));
  window.dispatchEvent(new CustomEvent("beatgaler:beat-update-drag", { detail: { beatId: updateBeatId, active: Boolean(updateBeatId) } }));
};

export function useCatalogFileDrop({ enabled, onDrop }: { enabled: boolean; onDrop: (event: CatalogDropEvent) => void }): { active: boolean; targetId: string | null; kind: DragPayloadKind } {
  const [state, setState] = useState<{ active: boolean; targetId: string | null; kind: DragPayloadKind }>({ active: false, targetId: null, kind: "none" });
  const depth = useRef(0);
  const cb = useRef(onDrop); cb.current = onDrop;
  const on = useRef(enabled); on.current = enabled;
  const ui = useRef("");
  const setUi = (artworkBeatId: string | null, updateBeatId: string | null) => { const k = `${artworkBeatId}|${updateBeatId}`; if (k === ui.current) return; ui.current = k; dispatchUi(artworkBeatId, updateBeatId); };
  const clear = () => { depth.current = 0; setUi(null, null); setState((s) => (s.active || s.targetId || s.kind !== "none" ? { active: false, targetId: null, kind: "none" } : s)); };
  useEffect(() => { if (!enabled) clear(); }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  // Los listeners viven siempre: un archivo soltado con un modal abierto NO debe hacer que el navegador navegue al archivo (se ignora).
  useEffect(() => {
    const enter = (e: DragEvent) => { if (!isExternalPayload(e)) return; e.preventDefault(); if (!on.current) return; depth.current += 1; };
    const over = (e: DragEvent) => {
      if (!isExternalPayload(e)) return;
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      if (!on.current) return;
      const kind = classifyDragPayload(e.dataTransfer!); const card = cardUnder(e);
      // Imagen sobre CUALQUIER zona de la tarjeta → portada; audio/archivo → reemplazo de audio; sin tarjeta → banner global.
      if (card && kind === "image") setUi(card, null); else if (card && kind !== "none") setUi(null, card); else setUi(null, null);
      setState((s) => (s.active && s.targetId === card && s.kind === kind ? s : { active: true, targetId: card, kind }));
    };
    const leave = (e: DragEvent) => { if (!isExternalPayload(e) && depth.current === 0) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0 || e.relatedTarget == null) clear(); };
    const drop = (e: DragEvent) => {
      if (!isExternalPayload(e)) return;
      e.preventDefault();
      const dt = e.dataTransfer!; const card = cardUnder(e);
      // Las lecturas del DataTransfer deben iniciarse de forma síncrona mientras el drop es dueño del almacén.
      const files = Array.from(dt.files ?? []);
      const artwork = looksLikeArtworkDrop(dt) ? captureArtworkSourcesFromDataTransfer(dt) : null;
      clear();
      if (!on.current) return;
      cb.current({ files, artwork, targetBeatId: card });
    };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); clear(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
