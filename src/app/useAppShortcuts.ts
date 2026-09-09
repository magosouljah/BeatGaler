import { useEffect } from "react";
import type { MutableRefObject } from "react";

type AppShortcutsOptions = {
  togglePauseRef: MutableRefObject<() => void>;
  clearSelection: () => void;
  setDrawer: (value: null) => void;
  setShowAdd: (value: boolean) => void;
  setShowSettings: (value: boolean) => void;
  closeQueue: () => void;
  setShowUpload: (value: null) => void;
};

export function useAppShortcuts(options: AppShortcutsOptions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA";
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur();
        window.getSelection()?.removeAllRanges();
        options.clearSelection();
        options.setDrawer(null);
        options.setShowAdd(false);
        options.setShowSettings(false);
        options.closeQueue();
        options.setShowUpload(null);
      }
      if (e.key === " " && !isTyping) {
        e.preventDefault();
        options.togglePauseRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
