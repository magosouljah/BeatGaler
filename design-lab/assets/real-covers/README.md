# Real covers — local-only Design Lab assets

20 real JPEG images supplied for the mock are **already committed to this design branch**, named `cover-01.jpg` through `cover-20.jpg`. Each is a 384 × 384 square, progressive JPEG optimized for the fake gallery and animated orbit. No images are loaded from remote URLs and no media is copied into `src/`.

The orbit has 24 positions: covers 01–04 are reused once. The original `bg-v1` procedural generator remains the default and fallback.

Optional: run `design-lab/import-real-covers.ps1 -ZipPath <your ZIP>` to replace the optimized files locally with the original full-resolution JPGs. That script extracts only JPEG files and ignores audio, MIDI and HTML. If you do this, the files on your PC will differ from GitHub until explicitly committed.

**Copyright/rights:** these are user-supplied visual references for a private design experiment, not artwork cleared for a public marketing site. Verify permissions before production.
