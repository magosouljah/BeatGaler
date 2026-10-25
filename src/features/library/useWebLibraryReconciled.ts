import { useEffect, useRef } from "react";
import type { Beat } from "../../types";
import { getActiveWebAccountId } from "../auth/activeWebAccount";

export const WEB_LIBRARY_RECONCILED_EVENT = "beatgaler:web-library-reconciled";

export interface WebLibraryReconciledDetail {
  beats: Beat[];
  accountId: string;
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
      const detail = (event as CustomEvent<WebLibraryReconciledDetail>).detail;
      if (!detail?.accountId || detail.accountId !== getActiveWebAccountId()) return;
      const beats = detail.beats;
      if (!Array.isArray(beats)) return;
      callbackRef.current(beats);
    };
    window.addEventListener(WEB_LIBRARY_RECONCILED_EVENT, listener);
    return () => window.removeEventListener(WEB_LIBRARY_RECONCILED_EVENT, listener);
  }, [enabled]);
}
