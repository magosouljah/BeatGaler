# Componentes de BeatGaler — estado real

- **[EXISTENTE]** `src/components/Player.tsx` es la Playbar del producto publicado `release/0.9.0-beta.2`.
- **[LAB]** `DESIGN/MASTER/Player.tsx` conserva su JSX, controles, estilos y la barra de volumen vertical; sus 14 iconos PNG son copias byte por byte de los assets de producción.
- **[LAB]** `DESIGN/MASTER/bridge.tsx` sustituye únicamente la dependencia del artwork y las dos etiquetas por versiones locales equivalentes; el componente no ejecuta servicios de producción.
- **[LAB]** `DESIGN/MASTER/MasterPage.tsx` ofrece fixtures, estado de play/seek, volumen, shuffle, repeat y cola; **no reproduce audio**.
- **[LAB]** `DESIGN/LANDING/` y `DESIGN/GALLERY/` contienen las demos anteriores. Su comportamiento y diseño se preservaron al mover los archivos; no son autoridad sobre MASTER.
- **[PENDIENTE]** Revisión visual del propietario, accesibilidad y pruebas manuales. Cualquier otro componente aún **no forma parte de MASTER**.

[LAB] MASTER tiene menú lateral estrecho, redimensionable y ocultable; vista de márgenes del laboratorio (margen horizontal aprobado de 32 px, no regla universal aprobada) y área de muestras sin texto. Ver [MASTER.md](MASTER.md). No existen inspector, editor global de tokens, catálogo de 58 fichas ni laboratorio de física en esta versión. El objetivo es trabajar la Playbar antes de añadir otra pieza.

**Límite:** MASTER de este documento = página de diseño. No confundir con el MASTER técnico, INDEX y Telegram.

- **[LAB] Decisión actual:** 32 px horizontales constantes en el canvas de MASTER (`--lab-space-8`). Playbar de 68 px de alto, caja estable de 48 px para la portada; al comprimirse la imagen mide 36 px y se eleva 4 px con un único `transform` de 180 ms. El bloque de texto acompaña la reducción con `translateX(-6px)` sincronizado, manteniendo **12 px de distancia visible entre portada y texto durante todos los fotogramas** (también al expandirse). Los metadatos suben 4 px para separar la lectura del seek. El scrubber mantiene una línea inferior común, empieza bajo el borde visible de la portada en compacto y responde inmediatamente al ancho mientras se arrastra el sidebar. Solo el cruce del breakpoint utiliza FLIP de 180 ms (`transform`); reducido a cambio inmediato con `prefers-reduced-motion`.

**Ubicación actual:** implementación y recursos en `DESIGN/MASTER`, `DESIGN/LANDING`, `DESIGN/GALLERY` y `DESIGN/shared`. Documentos y decisiones en `BLUEPRINT/DESIGN-SYSTEM`. No queda un segundo laboratorio en `design-lab/`.

- **[LAB — Toolbar en revisión]** `DESIGN/shared/Toolbar.tsx` reutilizada por `DESIGN/GALLERY/` y `DESIGN/MASTER/`: búsqueda que se expande hacia la izquierda, sort (Manual/Name/BPM/Stars/Date), Select→X y perfil (Demo User, Settings, Log out). Ambos menús comparten exactamente el mismo anclaje superior derecho, incluyen cierre por Escape/clic exterior, navegación de teclado y movimiento reducido. Stars y Date son datos ficticios; Settings/Log out solo muestran avisos en DESIGN. **Los iconos son SVG web provisionales referenciados por nombres de SF Symbols, no exports auténticos de Apple**, pendientes de sustituir tras verificar condiciones de uso. No se ha tocado producción.

- **[LAB — V2 candidata]** `DESIGN/shared/GlassButton.tsx` conserva el material `camera` original para CameraGlass y ofrece `liquid` para V2. `ShapeGlassSurface.tsx` adapta la refracción geométrica y reflejos del código MIT de Archis Vaze; recalcula contornos al animar ancho y respuesta al puntero. La V2 ya no utiliza los arcos circulares de la extracción original.
- **[LAB — comparación]** `DESIGN/shared/ToolbarV2.tsx` implementa Search, Sorting, Select y Profile con GlassButton, mientras `Toolbar.tsx` V1 permanece intacto. MASTER muestra V1 y V2 sobre los cinco fondos visuales de `REFERENCES/TOOLBAR-GLASS/`.
- **[VERIFICACIÓN AUTOMATIZADA]** `DESIGN/toolbar-v2-browser-check.mjs` prueba Chrome real, cuatro controles, menús, inversión de transformaciones, escritorio/móvil y preferencias de movimiento; publica capturas mediante el workflow Design Lab standalone. La aprobación visual de la nueva V2 sigue pendiente de la decisión del propietario.
