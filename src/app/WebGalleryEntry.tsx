import { lazy, Suspense } from "react";
import AuthExperienceGate from "../features/auth/AuthExperienceGate";
import { galleryLocation } from "./WebExperience";
const Workspace = lazy(() => import("./WebGalleryWorkspace"));
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
