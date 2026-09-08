export function decodeArtworkDataUrl(src: string): Promise<boolean> {
  return new Promise(resolve => {
    const image = new Image();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    image.onload = () => done(true);
    image.onerror = () => done(false);
    image.src = src;
    if (typeof image.decode === "function") {
      void image.decode().then(() => done(true)).catch(() => {});
    }
    window.setTimeout(() => done(false), 2500);
  });
}
