# Toolbar · Studio 44 — candidato

**MASTER → Toolbar · Studio 44.** Aislado de Toolbar V1/V2, Gallery, `src/`, `main` y producción.

- El preset óptico en `studio-toolbar-44.json` utiliza los valores nuevos de **2026-11-02 23:23:31** (glareRange 32.2, glareHardness 14.74, glareFactor 33.82, glareConvergence 48.76). No se reescribe con valores de animación. La iluminación de pulsación se aplica después del shader y es 0 al descansar.
- Motor WebGL2 original de `iyinchao/liquid-glass-studio` y cuatro pases GLSL; adaptación local de SDF para las 4 superficies independientes. El fondo pertenece al escenario (oscuro/claro), no a las lentes. Como el JSON no incluye su imagen `bgType 11`, el aspecto siempre depende del fondo real.
- **Press físico:** resorte críticamente amortiguado durante el crecimiento (`PRESS_GROW` período .34s), mantiene su tamaño durante cualquier hold; al soltar cambia de objetivo a 0 con su velocidad conservada, y rebota suavemente (`PRESS_RELEASE` período .39s, razón de amortiguamiento .47). El tamaño del botón crece uniformemente: no hay shear lateral ni jelly cuando se pulsa.
- **Morph:** un resorte independiente (`MORPH_SPRING` período .205s, damping .79), con deformación SDF **solo** durante las transiciones de Search y Select, interrumpible y reversible.
- La elección se inspira en **Apple WWDC23, Animate with springs**: https://developer.apple.com/videos/play/wwdc2023/10158/ . Son parámetros físicos propios de la demo, **no** una reproducción exacta de los coeficientes privados de SwiftUI.
- Accesibilidad: pointer capture, cancelación, foco y `prefers-reduced-motion`. WebGL2 degrada a controles accesibles si no está disponible.
- No captura DOM arbitrario debajo de la lente; esta limitación se debe resolver antes de integrar en Gallery.

## Prueba local (PowerShell)

```powershell
git fetch origin "+refs/heads/design/beatgaler-design-system-lab-v1:refs/remotes/origin/design/beatgaler-design-system-lab-v1"
git switch --detach origin/design/beatgaler-design-system-lab-v1
git rev-parse --short HEAD
npx --no-install vite --config DESIGN/vite.config.ts --port 4175 --force
```

Abre http://127.0.0.1:4175/ → MASTER → **Toolbar · Studio 44**. Si Vite sigue abierto, detener primero con Ctrl+C.

Para comprobar resorts y estados (Chrome): `node DESIGN/studio-toolbar-browser-check.mjs`.
