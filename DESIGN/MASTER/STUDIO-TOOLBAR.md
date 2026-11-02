# Toolbar · Studio 44 — candidate

**MASTER → Toolbar · Studio 44.** Candidato aislado para revisión visual. Sin cambios en Toolbar V1, Toolbar V2, Gallery, src, main o producción.

- Se usan todos los **valores** del JSON entregado el 2026-11-02 a las 22:07:48, incluidos 44×44, blur 4, Fresnel range 0, showShape1 false, parámetros originales de brillo y sombra.
- Motor original WebGL2 de `iyinchao/liquid-glass-studio`, cuatro pases GLSL. Adaptación local de SDF en `studio-toolbar-shape.glsl` para cuatro botones **independientes** en un solo lienzo WebGL.
- Todos los botones reaccionan a mantener pulsado: crecen dentro de la máscara refractiva, se aclaran temporalmente y recuperan su tamaño con resorte amortiguado y sobrepaso.
- Search: círculo 44px → pill hacia la izquierda, conservando el borde derecho. Select: pill 78×44px → círculo con X. El morphing usa otro resorte, de menor rebote, y ambos son reversibles a mitad de recorrido. Velocidades del resorte alimentan la deformación de la superficie.
- Los parámetros ópticos del preset no cambian. La luminosidad al presionar es **temporal**, no una nueva configuración del material.
- El escenario ofrece un fondo **normal** oscuro o claro que pertenece a la escena, no un fondo fijado a cada botón. El renderizador no captura DOM arbitrario detrás del vidrio: esto debe resolverse antes de integrar con contenido real de Gallery.
- Si falla WebGL2, los controles siguen siendo accesibles en modo de respaldo.
- Respeta `prefers-reduced-motion`, teclado, foco y pulsaciones canceladas.

## Probar

```powershell
git fetch origin
git switch design/beatgaler-design-system-lab-v1
git pull --ff-only origin design/beatgaler-design-system-lab-v1
npx --no-install vite --config DESIGN/vite.config.ts --port 4174
```

Abre http://127.0.0.1:4174/ → MASTER → **Toolbar · Studio 44**.

Para Chrome headless y capturas:

```powershell
node DESIGN/studio-toolbar-browser-check.mjs
```

Capturas: `DESIGN/studio-toolbar-visual-check/`, además del artefacto `studio-toolbar-44-chrome` en GitHub Actions.

Esta versión es una **simulación de interacción con contornos SDF y resortes físicos**, no una simulación volumétrica de fluidos Navier–Stokes. No se afirma fidelidad óptica plena sobre DOM real.
