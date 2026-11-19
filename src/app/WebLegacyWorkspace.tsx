import { useEffect } from "react";
import App from "../App";
import LibraryUxBridge from "../features/library/LibraryUxBridge";
import WebLibraryPagination from "../features/library/WebLibraryPagination";
import { preconnectRememberedWebDirect } from "../features/playback/webRememberedDirectPreconnect";

// Árbol LEGACY de la Gallery web (pager + App), sin cambios: solo se carga cuando la composición resuelve LEGACY (E80).
export default function WebLegacyWorkspace() {
  useEffect(() => { preconnectRememberedWebDirect(); }, []);
  return <><LibraryUxBridge /><WebLibraryPagination /><App /></>;
}
