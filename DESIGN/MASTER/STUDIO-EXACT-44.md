# Glass · Studio Original 44 — fondo sólido y referencia óptica

MASTER → **Glass · Studio Original 44**

- Un único círculo de **44 × 44 px** sin animaciones, bounce, shear ni luz añadida.
- Archivo `studio-toolbar-44.json`: exportación del 2026-11-02 23:59:40, parámetros ópticos sin alteraciones.
- Shaders originales exactos (`lib/sdf.glsl`, `fragment-main.glsl`, blur y background), con `MultiPassRenderer` original.
- `shapeRadius: 100` es **porcentaje**; Studio convierte al radio geométrico de 22px. `dpr=1`, blur kernel original y Fresnel range 0 sin parche.
- **Corrección:** el canvas original de la prueba era 780×280, mientras `iyinchao/liquid-glass-studio` inicia con `Math.max(Math.min(window.innerWidth,window.innerHeight)-150,600)` en ambos ejes. `getNormal()` del shader divide el gradiente por `u_resolution.y`, por lo que una altura de 280 exageraba los reflejos en comparación con 600.
- La prueba ahora usa un canvas **600×600** en escritorio; se adapta en pantallas pequeñas. El fondo es un **color RGB plano**, modificable con el selector hexadecimal. No exige ni solicita imagen.
- En Studio, `bgType:11` denota fondo personalizado. Aquí ese slot se alimenta con una textura de color uniforme, conservando el shader. El JSON no contiene un valor HEX, así que el color inicial (#26262b) es solo punto de partida y se puede ajustar.
- La validación automatizada confirma que el canvas es 600×600 en el navegador de pruebas.
- Esta prueba no modifica los cuatro botones de Toolbar Studio 44 ni Gallery, `src/`, producción o `main`.

Referencia original: https://github.com/iyinchao/liquid-glass-studio/blob/main/src/App.tsx
