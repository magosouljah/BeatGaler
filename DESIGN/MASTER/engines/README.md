# Three original Liquid Glass engines — isolated comparison

This test lives at **MASTER → Glass · 3 Engines** and does not change Gallery,
Toolbar V1, Toolbar V2, CameraGlass, `src/` or production.

The three engines are **not aesthetic reimplementations**:

1. NaughtyDuk: vendored original `liquidGL.js` v3.0.0,
   MIT. The original `liquidGL({target,snapshot,...})` API is used in
   `NaughtyOriginalButton.tsx` with WebGL2, no extra interaction code.
2. Archis Vaze: original source `ArchisOriginalEngine.ts` and original glass
   material CSS in `archis-original.css`. Source functions unaltered.
3. Charles Yin / iyinchao: original `GLUtils.ts` and original vertex, background,
   blur and main GLSL shaders under `engines/studio/`. The integration wrapper
   replaces only Vite's shader `#include` resolution and supplies canvas,
   texture, layout and original control uniforms. The optical GLSL is unmodified.

The stage background is newly drawn for the demonstration. Dragging the
background or scrolling over each specimen changes its offset. The lens
stays stationary. For NaughtyDuk and Archis the background is DOM/CSS; for
Studio it is uploaded to its original GPU background texture.

All three repositories declare MIT for the source code. No NaughtyDuk
`assets/` directory or third-party photo content is copied.

**This is an evaluation lab, NOT approval to integrate any engine in Toolbar.**
Browser verification and a real device review are required before approval.
