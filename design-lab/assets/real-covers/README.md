# Real covers — isolated Design Lab

This directory is intentionally empty until artwork is imported from the user's ZIP. Run the root-local `design-lab/import-real-covers.ps1` with the ZIP path. Only JPEG files are extracted; audio, MIDI, HTML and other contents are ignored. The importer names them `cover-01.jpg` onward. The Lab bundles them through Vite's local `import.meta.glob`, never through production services or outside URLs.

20 files populate all 24 orbit positions deterministically by repeating the first four. The generated source remains the default and fallback. The images have **not** been cleared for public production usage; evaluate rights before publishing.

For GitHub to serve the same photos on another computer, commit `cover-*.jpg` to the **design branch only**, or re-run this importer on each machine.
