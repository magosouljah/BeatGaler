# Componentes de BeatGaler — estado real

- **[EXISTENTE]** `src/components/Player.tsx` es la Playbar del producto publicado `release/0.9.0-beta.2`.
- **[LAB]** `DESIGN/MASTER/Player.tsx` conserva su JSX, controles, estilos y la barra de volumen vertical; sus 14 iconos PNG son copias byte por byte de los assets de producción.
- **[LAB]** `DESIGN/MASTER/bridge.tsx` sustituye únicamente la dependencia del artwork y las dos etiquetas por versiones locales equivalentes; el componente no ejecuta servicios de producción.
- **[LAB]** `DESIGN/MASTER/MasterPage.tsx` ofrece fixtures, estado de play/seek, volumen, shuffle, repeat y cola; **no reproduce audio**.
- **[LAB]** `DESIGN/LANDING/` y `DESIGN/GALLERY/` contienen las demos anteriores. Su comportamiento y diseño se preservaron al mover los archivos; no son autoridad sobre MASTER.
- **[PENDIENTE]** Revisión visual del propietario, accesibilidad y pruebas manuales. Cualquier otro componente aún **no forma parte de MASTER**.

[LAB] MASTER tiene menú lateral estrecho, redimensionable y ocultable; vista de márgenes del laboratorio (margen horizontal aprobado de 32 px, no regla universal aprobada) y área de muestras sin texto. Ver [MASTER.md](MASTER.md). No existen inspector, editor global de tokens, catálogo de 58 fichas ni laboratorio de física en esta versión. El objetivo es trabajar la Playbar antes de añadir otra pieza.

**Límite:** MASTER de este documento = página de diseño. No confundir con el MASTER técnico, INDEX y Telegram.

- **[LAB] Decisión actual:** 32 px horizontales constantes en el canvas de MASTER (`--lab-space-8`). La Playbar siempre mide 68 px de alto, usa portada de 36 px y scrubber ancho completo bajo la portada cuando se comprime; transición 210 ms, reducida a cero para `prefers-reduced-motion`.

**Ubicación actual:** implementación y recursos en `DESIGN/MASTER`, `DESIGN/LANDING`, `DESIGN/GALLERY` y `DESIGN/shared`. Documentos y decisiones en `BLUEPRINT/DESIGN-SYSTEM`. No queda un segundo laboratorio en `design-lab/`.
