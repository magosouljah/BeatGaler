# Real covers — local-only Design Lab assets

24 locally bundled images supplied for the mock are **already committed to this design branch**, named `cover-01.jpg` through `cover-20.jpg` plus `cover-21.avif` through `cover-24.avif`. JPGs are 384 × 384 progressive images; the four extra AVIFs are 320 × 320 squares. No images are loaded from remote URLs and no media is copied into `src/`.

The orbit has 24 positions and uses 24 unique covers in Real covers mode. The original `bg-v1` procedural generator remains the default and fallback.

Optional: run `DESIGN/import-real-covers.ps1 -ZipPath <your ZIP>` to replace the optimized files locally with the original full-resolution JPGs. That script extracts only JPEG files and ignores audio, MIDI and HTML. If you do this, the files on your PC will differ from GitHub until explicitly committed.

**Copyright/rights:** these are user-supplied visual references for a private design experiment, not artwork cleared for a public marketing site. Verify permissions before production.
