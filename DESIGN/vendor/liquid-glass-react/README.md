# Liquid Glass React — copia de código aislada

Fuente original: https://github.com/rdev/liquid-glass-react, commit `ac48eab18d1f7f444ae30002d240cae29c863a21`.
Licencia MIT: consulta `LICENSE` (copyright 2025 Max Rovensky).

Esta copia se usa **solo** para probar Toolbar V2 en `DESIGN/MASTER`. Se incluyen el motor óptico original, sus mapas de desplazamiento y las utilidades del modo shader. El único parche de integración al motor es un `ResizeObserver` para actualizar el tamaño al transformar la búsqueda; la V2 usa `mode="standard"`, sin shader (menos estable). No afecta a la aplicación web real ni modifica `package.json` / `package-lock.json`.

El código original usa clases de Tailwind; `DESIGN/shared/toolbar-v2.css` aporta las reglas necesarias, encapsuladas en la demo. V1 es el fallback visual y no se modifica. Safari/Firefox tienen refracción parcial; no adoptar en producción sin comprobar contraste, FPS, CPU/GPU y entrada de teclado.
