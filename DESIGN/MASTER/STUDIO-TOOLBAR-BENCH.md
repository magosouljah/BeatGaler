# Liquid Glass Studio — laboratorio de comparación (solo DESIGN)

**Estado:** experimento, no una Toolbar V2 aprobada. El material se basa en el JSON exacto exportado por el propietario el 2026-11-02, almacenado en `studio-preset-2026-11-02.json`. No modificarlo para ajustar las pruebas.

## Abrir

En PowerShell (raíz del repositorio):

```powershell
git fetch origin
git switch design/beatgaler-design-system-lab-v1
git pull --ff-only origin design/beatgaler-design-system-lab-v1
npx --no-install vite --config DESIGN/vite.config.ts --port 4174
```

Visita http://127.0.0.1:4174/ → MASTER → **Glass · Studio Bench**.

## Qué comparar

- **A — Original:** shaders y preset originales, sin respuesta óptica a la presión.
- **B — Geometría:** SDF se comprime un 2.5% al pulsar; los uniformes ópticos no cambian.
- **C — Distancia:** geometría + `u_refDistance` hasta −25% y `u_shadowFactor` hasta −40% durante la presión.
- **D — Curvatura:** geometría + `u_refThickness` hasta −18%, `u_refDistance` −12% y sombra −25% durante la presión.

Las amplitudes son hipótesis experimentales y vuelven al valor original al soltar. El spring de presión usa amortiguamiento crítico y deriva su escala temporal del token `--lab-normal` (180ms). `showShape1` del JSON vale `true` (círculo adicional de radio 100) pero empieza **explícitamente desactivado** para controles compactos de 44px; el checkbox permite ver su efecto sin reescribir el preset. La geometría pasa de 250px de la demo a la de cada botón. Search crece hacia la izquierda, Select pasa de pill a círculo; ambos se pueden invertir.

Las cuatro superficies usan las utilidades WebGL2 y los shaders GLSL originales ya copiados a `DESIGN/MASTER/engines/studio/`, sin cambios. Cada botón tiene su propio renderer de cuatro pases y textura; son pruebas de fidelidad, **no** una implementación de recursos GPU compartidos. El fondo visible y la textura refractada se generan desde el mismo Canvas2D sincronizado; **no** existe captura live del DOM de Gallery. Con arrastre/rueda puedes observar el fondo deformado.

## Limitaciones a validar

- Rendimiento de cuatro contextos WebGL2 independientes, especialmente el blur de radio 32 en móvil.
- Diferencias de Chrome, Safari, DPR y disponibilidad de `EXT_color_buffer_float`.
- Bordes de sombra recortados por el contenedor redondeado; la comparativa no es todavía una Toolbar de producción.
- Cambio de fuentes/background, comprobación visual de morphs y enfoque de teclado.
- Aprobación visual final del material a 44px y elección entre A–D.

**No** se ha alterado `Toolbar.tsx`, `ToolbarV2.tsx`, `DESIGN/GALLERY`, `src/`, `main` ni producción. Se preserva la licencia MIT de Charles Yin junto a los shaders originales.

## Capturas y comprobación automatizada

Desde la raíz, una vez instaladas las dependencias:

```powershell
node DESIGN/studio-toolbar-browser-check.mjs
```

Inicia un servidor Vite temporal para la prueba (puerto 4186), abre Chromium/Chrome, recorre las cuatro opciones y guarda capturas PNG en `DESIGN/studio-toolbar-screenshots/`. Requiere Chrome/Chromium. Usa también pruebas manuales para juzgar brillo, compresión, respuesta táctil y calidad visual; el test no decide la mejor variante.

Las capturas también se publican en GitHub Actions → **Design Lab standalone** → artefacto `studio-toolbar-4-variants-chrome` (archivos `original-*`, `geometry-*`, `depth-*`, `curvature-*`, además de pruebas de búsqueda y selección).
