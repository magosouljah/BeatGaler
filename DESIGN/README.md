# DESIGN — BeatGaler

**Esta carpeta contiene y ejecuta el laboratorio experimental**, anteriormente en `design-lab/`. Solo hay una aplicación y un servidor; no se mantiene una segunda copia del laboratorio.

## Carpetas

- **`MASTER/`** — Design System incremental: Playbar y Toolbar, navegación izquierda, reglas, Playbar tomada de la producción y sus 14 iconos originales. Márgenes horizontales aprobados de 32 px; Playbar de 68 px de alto, portada que se transforma una sola vez al comprimirse y seek reactivo sin latencia durante resize.
- **`LANDING/`** — landing experimental y su órbita circular de portadas.
- **`GALLERY/`** — galería ficticia de 24 beats (3–6 tags por beat, 35 tags distintos) con Toolbar Studio 44 WebGL flotante y barra superior minimalista en una sola línea. La franja negra ocupa todo el ancho, se revela al acercarse al borde superior sin reservar hueco mientras está oculta y **empuja la Toolbar** mediante un grid animado; se oculta a los 900 ms y permanece visible en táctil. Seleccionados se agrupan tras All con FLIP + resorte interrumpible. Mantiene filtros, colores, sorting, búsqueda, selección y reproducción simulada.
- **`REFERENCES/TOOLBAR-GLASS/`** — cinco referencias visuales del botón Liquid Glass sobre fondos diferentes, para la futura Toolbar V2.
- **`shared/`** — componentes, tokens, datos de 24 beats ficticios, generador original `bg-v1` y 24 carátulas locales (una portada por beat, sin repeticiones en modo Real). El selector **MASTER → PORTADAS**, situado encima de REGLAS, cambia entre Generadas y Reales para LANDING y GALLERY.
- **`App.tsx`, `main.tsx`, `index.html`, `vite.config.ts`** — la única app y servidor aislados.

## Abrir desde la raíz del repositorio (PowerShell)

```powershell
git fetch origin refs/heads/design/beatgaler-design-system-lab-v1:refs/remotes/origin/design/beatgaler-design-system-lab-v1
git merge --ff-only origin/design/beatgaler-design-system-lab-v1
npx --no-install vite --config DESIGN/vite.config.ts --port 4174
```

Abrir **http://127.0.0.1:4174/** y entrar a MASTER. Detener Vite con `Ctrl+C`. **Ya no existe** el comando antiguo con `design-lab/vite.config.ts`.

## Comprobaciones

La verificación visual automatizada corre en Chrome real y captura vistas wide/compact de MASTER como artefactos del workflow GitHub Actions:

```powershell
node DESIGN/playbar-browser-check.mjs
```


```powershell
node --test DESIGN/lab-contract.test.mjs
npx --no-install tsc --project DESIGN/tsconfig.json --noEmit
npx --no-install vite build --config DESIGN/vite.config.ts
```

El build se escribe en `DESIGN/dist/` (ignorado por Git). Los 24 covers y los 14 iconos se movieron sin alterar sus bytes. El laboratorio no accede a usuarios, producción, API, Cloud ni audio. Los archivos de `src/` son la referencia de los componentes reales, pero **no se importan directamente** al bundle.

## Cómo trabajar

- `BLUEPRINT/DESIGN-SYSTEM/MASTER.md` establece cómo funciona MASTER y cómo se agregan componentes.
- `BLUEPRINT/DESIGN-SYSTEM/DESIGN.md` enumera lo implementado; `ARCHITECTURE.md` explica su código. `REFERENCES.md` y el transcript son fuentes metodológicas.
- Antes de cada incorporación, consultar las skills relevantes de `.agents/skills/`. Añadir **solo componentes aprobados, uno a la vez**.

## Prueba separada — motor original archisvaze/liquid-glass

- En **MASTER → Glass · Original** hay un único botón de prueba independiente usando el **motor SVG sin cambios** de `archisvaze/liquid-glass` (commit `fbeb99ef5e8dad2cbbc991ffc23e186a28dc01c4`), con su preset original **Button 140×52** y parámetros por defecto. Los cálculos y el filtro de origen se copiaron literalmente a `MASTER/ArchisOriginalEngine.ts`; el CSS óptico original está marcado en `MASTER/archis-original.css`.
- Solo el contenedor React, posición, contenido del botón y selección de cinco fondos son locales. No hay reacciones al puntero ni nuevos efectos. La muestra sirve para **evaluar antes de migrar**: Toolbar V2, CameraGlass, Gallery, `src/` y producción permanecen intactos.
- El algoritmo SVG original funciona plenamente en Chrome/Chromium; en otros motores puede degradarse. Se conserva la atribución MIT.

## Toolbar V2 — material de cámara aprobado

- `shared/GlassButton.tsx` conserva la óptica `camera` original aprobada y ofrece `liquid` para Toolbar V2. `ShapeGlassSurface.tsx` adapta el algoritmo SVG de [Archis Vaze / liquid-glass](https://github.com/archisvaze/liquid-glass) (MIT): genera mapas de refracción y brillo con Canvas para cada círculo/pill, según su ancho actual. Los reflejos siguen al puntero, sin arcos circulares dentro de la pill ni dependencias adicionales.
- `shared/Toolbar.tsx` permanece V1 intacta. `shared/ToolbarV2.tsx` usa GlassButton para Search, Sorting, Select y Profile con sus estados y menús. MASTER muestra ambas versiones y los cinco fondos ópticos.
- Comprobación automatizada de V2 en Chrome real (incluye interacciones, escritorio/móvil, accesibilidad, movimiento reducido y capturas): `node DESIGN/toolbar-v2-browser-check.mjs`. GitHub Actions guarda las capturas junto a las referencias WebP en el artefacto `toolbar-v1-v2-chrome-visual-check`.
- **Estado:** nueva candidata implementada en DESIGN; la aprobación visual final de V2 corresponde al propietario. No se modifica GALLERY, `src/` ni producción.

## Gallery — navegación de tags

Alt+T revela los tags desde teclado; flechas horizontales mueven el foco. En dispositivos táctiles la barra está visible para que se pueda descubrir. Clic alterna incluido ↔ deseleccionado; **Alt+clic** excluye o limpia una exclusión (patrón de facetas de Phraseanet). All limpia filtros. La negrita y el tachado no cambian el ancho del tag: cada botón reserva de antemano el ancho de su glifo más pesado. Hover muestra un resplandor muy sutil del mismo color, incluso sobre tags coloreados o excluidos. La rueda vertical desplaza horizontalmente solo si hay tags fuera de pantalla. Clic derecho, Shift+F10 y pulsación larga abren la paleta, que flota fuera del área con scroll y actualiza también los tags de cada beat. Las animaciones respetan movimiento reducido. Solo DESIGN.

La Toolbar de Gallery reutiliza `MASTER/StudioToolbarCandidate.tsx` en modo `gallery`: **canvas WebGL de 600 px de alto y DPR 1, igual al espécimen aprobado**, con alpha solo fuera de las lentes. Muestrea las portadas locales al desplazarlas bajo el vidrio y refresca las coordenadas mientras aparece/desaparece la barra. El preset activo `studio-toolbar-44.json` reduce sutilmente glareFactor (33.82 → 30.2) y glareOppositeFactor (78.81 → 69), sin tocar los demás parámetros ópticos. El espécimen **Glass · Studio Original 44** de MASTER carga el snapshot inmutable `studio-toolbar-44-original.json` con los valores aprobados. La demo no captura contenido externo al documento.

## Gallery Tag Bar variants and Playbar
MASTER → TAG BAR switches **Full black** / **Playbar material**. This is a shared, session-only DESIGN preference. Gallery's tag bar starts flush at the top with an 8px track gap, while the Studio Toolbar retains its offset below. The static “Tags ↑” hint is covered on reveal. Include/exclude filters pin the strip open; when clear, fine-pointer auto-hide is 900ms; touch and keyboard remain accessible. Custom colors have a short subtle underline, different gray/red/excluded treatments and no white hover.

Gallery now uses the exact `MASTER/Player.tsx` in the responsive fixed dock through `GALLERY/GalleryPlayer.tsx`; no product API/audio calls. The Studio Toolbar samples its existing local canvas to switch icon ink on bright backgrounds without modifying the shader or optical preset.

Verify with `node --test DESIGN/lab-contract.test.mjs`, `node DESIGN/gallery-browser-check.mjs`, the DESIGN-only TypeScript check and Vite build.


## Gallery behavior refinements (November 3, 2026)
Tag Bar and the “Tags ↑” cue remain fixed to the viewport and can be revealed at any scroll depth. Studio Toolbar remains floating; where the bar is still visible, its offset follows the bar with the existing `--lab-space-2` 8px gap. The variant's backdrop material stays rendered behind the height-clipped 0fr→1fr reveal, avoiding a transient wrong finish.

No custom-color underline. “Sin color” deletes the custom assignment and returns to the same neutral idle/included/excluded state as an unassigned tag. Reordering animates selected tags toward All but does not scroll the user's horizontal viewport. Wheel events over the tag strip are consumed even at the beginning/end, with no vertical scroll chaining. Studio uses nine texture samples per control, flipping to slightly heavier dark ink only on predominantly near-white backgrounds (not yellow/orange artwork); glass shaders and presets are unchanged.



## Gallery inset design — final selected variant
The full-width layout experiment was removed. The selected inset bar is viewport-positioned and can be revealed at the top of the screen from any scroll depth. On normal page scrolling it closes unless an active tag filter pins it. Its text is moved upward 6px (from the Paint-adjusted Melodic reference).

The “Tags ↑” hint aligns with the All tag and appears only until the first reveal. Session storage remembers dismissal across Gallery/Master navigation. **The Toolbar is viewport-fixed and independent of visible Gallery beats**, including filters, empty results, vertical scroll and column changes. The inset Tag Bar is flush to the viewport top and 88px tall (96px minus the existing 8px token), with its lettering vertically centered and the existing 44px/40px controls preserved. The Toolbar returns to the former 10px optical position relative to the last *full grid column*, using a CSS-only grid-track formula independent of any filtered beat. Opening it moves the Toolbar to **Tag Bar bottom + 8px**; both use the same 180ms transition to preserve the gap during interruptions. The Studio shader and presets remain unchanged. Diagnosis, technical layout contract and validation strategy: [Gallery layout audit](GALLERY/LAYOUT-AUDIT-2026-11-03.md).

Studio 44 experiment preset: `tint #5e5e5eb0`, `shadowExpand 20`, `shadowFactor 20`. The original diagnostic preset remains unchanged; automated light-background ink detection has been removed in Gallery. The Tag Bar's horizontal scrolling, filters and material comparison remain as before.


## BeatCard — tres maneras de consultar tags (candidatas, no aprobadas)

En `MASTER → BeatCard · 3 ideas` hay tres BeatCards **de 160 × 239 px**, con la misma portada, tags y colores para comparar solo el tratamiento de los tags ocultos:

- **A · Línea discreta:** aparecen los tags faltantes justo bajo la fila, sin cuadro ni cambiar el tamaño de la tarjeta. **Esta es la candidata activa en Gallery.**
- **B · Sobre portada:** los tags faltantes aparecen en una franja de degradado integrada en la parte inferior de la portada.
- **C · Extensión lateral:** prolonga visualmente la línea de tags hacia el lado con espacio disponible, sin abrir una ficha nueva.

Pasa el cursor sobre los tags y déjalo **800 ms** para ver la opción; al salir desaparece. Foco de teclado o toque muestran la vista inmediatamente. La vista usa un **solo temporizador y un solo overlay para todas las tarjetas**, con eventos delegados, sin observadores/timers por BeatCard. En Gallery se corrigió el literal `+$N` a `+N`, se atenuó BPM/Key, la compactación usa medición de texto compartida/caché con ancho exacto y los grupos de color se condensan en un punto por color. El menú de tres puntos no abre la lista de tags. No hay indicador de reproducción debajo de la portada.

Estado: **comparación experimental**. Validar en Chrome con `node DESIGN/gallery-browser-check.mjs` y `node --test DESIGN/lab-contract.test.mjs DESIGN/beatcard-tags.test.mjs`; comprobar manualmente el tamaño fijo y la apariencia de las tres opciones. No afecta `src/`, producción ni `main`.
