// Hoja compartida: la URL canónica de la Gallery. Vive aparte para que WebExperience y WebGalleryEntry (cargado con lazy) no se importen entre sí.
export function galleryLocation() {
  const url = new URL(window.location.href);
  url.pathname = "/gallery";
  return url.pathname + url.search + url.hash;
}
