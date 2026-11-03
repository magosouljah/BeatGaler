# Toolbar · Studio 44 — cuatro lentes, material original

MASTER → **Toolbar · Studio 44** (candidato independiente).

- Se conserva sin cambios el preset `studio-toolbar-44.json` enviado 2026-11-02 23:59:40: propiedades ópticas, 44px, `glare`, `Fresnel`, tinte y blur.
- Un solo canvas WebGL2 y los cuatro pases de `iyinchao/liquid-glass-studio` originales (shaders de background, blur, main y renderizador). La composición de cuatro lentes reemplaza solamente `mainSDF`, **reutilizando literalmente** `roundedRectSDF` y `superellipseCornerSDF` del archivo de geometría original. Cada lente tiene dimensiones propias y la unión toma la mínima distancia; **no se fusionan con smin**.
- Mismo lienzo **600×600px y DPR=1** que la referencia estática previamente aceptada. Se usa fondo plano oscuro #26262b o claro #e7e7e9, mediante la textura de fondo (no dentro de los botones). Un fondo distinto puede cambiar los reflejos.
- **Sin jelly**: eliminado u_waves/sinusoidal/shear. Search/Select realizan cambios del **ancho del rounded rectangle** mediante resortes; reflejos se recalculan físicamente sobre la nueva forma, sin deformarla.
- **Pulsación**: crecimiento uniforme del contorno (11.5% al mantener presionado) y recuperación con bounce físico. Funciona tras pulsaciones cortas y largas. No se modifica la luz del vidrio, tampoco al presionar; el cambio óptico es únicamente la consecuencia natural de cambiar su geometría. El icono sigue suavemente ese tamaño.
- **Search**: círculo→pill que crece hacia la izquierda conservando el extremo derecho; input dentro. **Sort** y **Profile**: círculos constantes con feedback de presión. **Select**: pill→círculo con X, reversible.
- Motor original Studio, pero multi-lente es una adaptación necesaria: no se afirma que sus reflejos sean pixel-perfect en todos los fondos. La prueba de referencia estática `Glass · Studio Original 44` sigue disponible.
- Accesibilidad, keyboard, prefers-reduced-motion y fallback de WebGL2 conservados.

Para ver: `git fetch origin "+refs/heads/design/beatgaler-design-system-lab-v1:refs/remotes/origin/design/beatgaler-design-system-lab-v1"` y `git switch --detach origin/design/beatgaler-design-system-lab-v1`. Vite: `npx --no-install vite --config DESIGN/vite.config.ts --port 4175 --force`. Abre MASTER → Toolbar · Studio 44.

No se ha tocado Toolbar V1/V2, Gallery, `src/`, `main` ni producción.
