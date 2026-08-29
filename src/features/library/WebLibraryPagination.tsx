import React, { useEffect, useState } from "react";
import { platform } from "../../platform";
import {
  WEB_LIBRARY_NAVIGATION_EVENT,
  readWebLibraryNavigationState,
  webLibraryPageUrl,
  type WebLibraryNavigationState,
} from "./webLibraryNavigation";

export default function WebLibraryPagination() {
  const [state, setState] = useState<WebLibraryNavigationState | null>(() => readWebLibraryNavigationState());

  useEffect(() => {
    if (platform.kind !== "web") return;
    const onNavigation = (event: Event) => {
      setState({ ...(event as CustomEvent<WebLibraryNavigationState>).detail });
    };
    window.addEventListener(WEB_LIBRARY_NAVIGATION_EVENT, onNavigation);
    const current = readWebLibraryNavigationState();
    if (current) setState(current);
    return () => window.removeEventListener(WEB_LIBRARY_NAVIGATION_EVENT, onNavigation);
  }, []);

  if (platform.kind !== "web" || !state) return null;
  if (state.previousOffset === null && state.nextOffset === null) return null;

  const first = state.totalVisible === 0 ? 0 : state.offset + 1;
  const last = Math.min(state.totalVisible, state.offset + state.materializedCount);
  const navigate = (offset: number | null) => {
    if (offset === null) return;
    window.location.assign(webLibraryPageUrl(offset));
  };

  return (
    <nav
      aria-label="Library pages"
      data-web-library-pagination="true"
      style={{
        position: "fixed",
        right: 20,
        bottom: 20,
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        borderRadius: 10,
        border: "1px solid #282828",
        background: "rgba(16,16,16,.94)",
        boxShadow: "0 10px 30px rgba(0,0,0,.42)",
        fontSize: 11,
        color: "#8d8d8d",
      }}
    >
      <button
        type="button"
        aria-label="Previous library page"
        disabled={state.previousOffset === null}
        onClick={() => navigate(state.previousOffset)}
        style={{ border: 0, background: "transparent", color: state.previousOffset === null ? "#3d3d3d" : "#bdbdbd", cursor: state.previousOffset === null ? "default" : "pointer", padding: "4px 7px" }}
      >
        ←
      </button>
      <span aria-live="polite">{first}–{last} of {state.totalVisible}</span>
      <button
        type="button"
        aria-label="Next library page"
        disabled={state.nextOffset === null}
        onClick={() => navigate(state.nextOffset)}
        style={{ border: 0, background: "transparent", color: state.nextOffset === null ? "#3d3d3d" : "#bdbdbd", cursor: state.nextOffset === null ? "default" : "pointer", padding: "4px 7px" }}
      >
        →
      </button>
    </nav>
  );
}
