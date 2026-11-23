import { useCallback, useEffect } from "react";
import { useAudio } from "../../../hooks/useAudio";
import type { CatalogPlaybackSession } from "./catalogPlaybackSession";

const PLAYBACK_UNAVAILABLE_NOTICE = "No se pudo reproducir este beat.";

/** Motor de audio de la Gallery + puente con la sesión de reproducción (pausa durante la espera, aviso de medio no disponible, liberación tras borrar). */
export function useGalleryAudio(session: CatalogPlaybackSession, setNotice: (value: string | null) => void) {
  const engine = useAudio(() => setNotice(PLAYBACK_UNAVAILABLE_NOTICE));
  const { togglePause: toggleEnginePause, isAudioPaused, releaseFile } = engine;
  const togglePause = useCallback(() => {
    session.cancelPendingPlay(!isAudioPaused());
    toggleEnginePause();
  }, [session, isAudioPaused, toggleEnginePause]);
  useEffect(() => session.onEvent(({ kind }) => {
    if (kind === "release") releaseFile();
    if (kind === "unavailable") setNotice(PLAYBACK_UNAVAILABLE_NOTICE);
  }), [session, releaseFile, setNotice]);
  return { ...engine, togglePause, toggleEnginePause };
}
