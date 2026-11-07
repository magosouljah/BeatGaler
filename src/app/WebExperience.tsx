import { lazy, Suspense, useEffect, useState } from "react";
const LandingPage = lazy(() => import("../features/design/LANDING/LandingPage"));
const AuthenticatedPage = lazy(() => import("./WebGalleryEntry"));

export function galleryLocation() {
  const url = new URL(window.location.href);
  url.pathname = "/gallery";
  return url.pathname + url.search + url.hash;
}

export default function WebExperience() {
  const [path, setPath] = useState(() => window.location.pathname.replace(/\/$/, "") || "/");
  useEffect(() => {
    const update = () => setPath(window.location.pathname.replace(/\/$/, "") || "/");
    window.addEventListener("popstate", update);
    // Preserve bookmarks created by the previous root-based library pagination.
    if (path === "/" && new URLSearchParams(window.location.search).has("bgPage")) {
      window.history.replaceState(null, "", galleryLocation()); update();
    }
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => { document.title = path === "/" ? "BeatGaler — Your beats, organized" : "BeatGaler — Gallery"; }, [path]);
  return <Suspense fallback={<main aria-busy="true" aria-label="Loading BeatGaler" />}>
    {path === "/" ? <LandingPage /> : ["/gallery", "/login", "/signup"].includes(path)
      ? <AuthenticatedPage initialPhase={path === "/signup" ? "register" : "login"} />
      : <main data-public-page-ready="true" style={{ padding:40 }}><h1>Page not found</h1><a href="/">Back to BeatGaler</a></main>}
  </Suspense>;
}
