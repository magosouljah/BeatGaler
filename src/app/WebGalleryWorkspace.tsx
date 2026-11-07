import { useEffect } from "react";
import App from "../App";
import LibraryUxBridge from "../features/library/LibraryUxBridge";
import WebLibraryPagination from "../features/library/WebLibraryPagination";
import { preconnectRememberedWebDirect } from "../features/playback/webRememberedDirectPreconnect";
export default function WebGalleryWorkspace() {
  useEffect(() => { preconnectRememberedWebDirect(); }, []);
  return <><LibraryUxBridge /><WebLibraryPagination /><App /></>;
}
