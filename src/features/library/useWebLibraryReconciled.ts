import { useEffect, useRef } from "react";
import type { Beat } from "../../types";

export const WEB_LIBRARY_RECONCILED_EVENT = "beatgaler:web-library-reconciled";

export interface WebLibraryReconciledDetail {
  beats: Beat[];
}

export function useWebLibraryReconciled(
  enabled: boolean,
  onReconciled: (beats: Beat[]) => void,
): void {
  const callbackRef = useRef(onReconciled);
  callbackRef.current = onReconciled;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const listener = (event: Event) => {
      const beats = (event as CustomEvent<WebLibraryReconciledDetail>).detail?.beats;
      if (!Array.isArray(beats)) return;
      callbackRef.current(beats);
    };
    window.addEventListener(WEB_LIBRARY_RECONCILED_EVENT, listener);
    return () => window.removeEventListener(WEB_LIBRARY_RECONCILED_EVENT, listener);
  }, [enabled]);
}
