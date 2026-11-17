// Sistema común de avisos flotantes: superpuestos (position: fixed), nunca ocupan espacio en el layout ni mueven márgenes, scroll o posición de la Gallery.
//  - Éxito: desaparece solo (4 s). Información: 6 s. Error: permanece (30 s o hasta cerrarlo). Progreso («Importando…», «Reemplazando…»): permanece hasta que lo reemplaza el resultado.
//  - Aspecto liquid-glass (CSS: desenfoque y saturación del contenido posterior, borde y brillo superior). Accesible: role=status/alert + aria-live.
import { useEffect, useRef, useState } from "react";
import "./floatingNotice.css";

export type NoticeTone = "success" | "error" | "progress" | "info";
export const NOTICE_DURATION_MS: Record<NoticeTone, number | null> = { success: 4000, info: 6000, error: 30000, progress: null };

const ERROR_RE = /no se pudo|no pudo|error|fall[óo]|failed|conflict|cambi[óo] en otro|quedó en estado|denegad|denied|rechaz|tarda demasiado|no está disponible|no se guardó|reconnect|CURSOR_STALE|TRANSFER_UNAVAILABLE|máximo|solo se pueden/i;
const PROGRESS_RE = /…|\.\.\.$|^(importando|reemplazando)\b/i;
const SUCCESS_RE = /importado\.|actualizada\.|reemplazado\.|añadido\.|renombrado|confirmados|^MP3 |^WAV |^Portada /i;

/** Tono del aviso a partir de su texto (los servicios publican cadenas). Error tiene prioridad sobre éxito. */
export function noticeTone(text: string): NoticeTone {
  if (ERROR_RE.test(text)) return "error";
  if (PROGRESS_RE.test(text)) return "progress";
  if (SUCCESS_RE.test(text)) return "success";
  return "info";
}

export function FloatingNotice({ notice, onDismiss, lifted = false }: { notice: string | null; onDismiss: () => void; /** Hay Playbar: el aviso sube para no taparla. */ lifted?: boolean }) {
  const [shown, setShown] = useState<{ text: string; tone: NoticeTone } | null>(null);
  const dismissRef = useRef(onDismiss); dismissRef.current = onDismiss;
  useEffect(() => {
    if (!notice) { setShown(null); return; }
    const tone = noticeTone(notice);
    setShown({ text: notice, tone });
    const ms = NOTICE_DURATION_MS[tone];
    if (ms === null) return;
    const t = window.setTimeout(() => dismissRef.current(), ms);
    return () => window.clearTimeout(t);
  }, [notice]);
  if (!shown) return null;
  return (
    <div className={"bg-floating-notices" + (lifted ? " is-lifted" : "")} data-testid="floating-notices">
      <p className={"bg-catalog-notice bg-floating-notice is-" + shown.tone} role={shown.tone === "error" ? "alert" : "status"} aria-live={shown.tone === "error" ? "assertive" : "polite"} data-notice-tone={shown.tone}>
        <span className="bg-floating-notice-dot" aria-hidden="true" />
        <span className="bg-floating-notice-text">{shown.text}</span>
        <button type="button" className="bg-floating-notice-close" aria-label="Cerrar aviso" onClick={onDismiss}>×</button>
      </p>
    </div>
  );
}
export default FloatingNotice;
