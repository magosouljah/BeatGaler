import { lazy, Suspense } from "react";
import AuthExperienceGate from "../features/auth/AuthExperienceGate";
import { galleryLocation } from "./galleryLocation";
// E80: el chunk de la Gallery se descarga EN PARALELO a la restauración de la sesión (antes se pedía solo después): es solo código; ningún dato
// ni petición de catálogo sale antes de que el Cloud confirme la cuenta.
const workspaceChunk = import("./WebGalleryWorkspace");
const Workspace = lazy(() => workspaceChunk);
function accountReady() {
  if (window.location.pathname !== "/gallery") {
    window.history.replaceState(null, "", galleryLocation());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}
export default function WebGalleryEntry({initialPhase}: {initialPhase:"login"|"register"}) {
  return <AuthExperienceGate initialPhase={initialPhase} onAuthenticated={accountReady}>
    <Suspense fallback={<main aria-busy="true" aria-label="Loading Gallery" />}><Workspace /></Suspense>
  </AuthExperienceGate>;
}
