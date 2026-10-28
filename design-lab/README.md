# BeatGaler Design Lab (solo datos ficticios)

Laboratorio **independiente** de Web/Cloud: no importa `src/`, no hay login, API, audio, archivos de usuario ni servicios externos. Nada aquí altera la app productiva.

## Abrirlo (PowerShell, en `E:\777\app\BeatGaler`)

```powershell
git fetch origin
git switch design/beatgaler-design-system-lab-v1
npm ci
npx --no-install vite --config design-lab/vite.config.ts
```

Abrir **http://127.0.0.1:4173/**. `npm ci` solo es necesario si faltan dependencias; no se añadieron paquetes. Para salir `Ctrl+C`.

## Qué contiene

- **Components:** vitrina de primitivas, botones, inputs, estados, tarjetas y reproductor falso.
- **Landing:** wireframe visual artístico, composición estática de carátulas inventadas.
- **Gallery:** wireframe de biblioteca, búsqueda y filtros sobre un arreglo local; play/pause solo cambia estado.
- **Panel de tokens:** edita colores CSS en memoria, con **Restablecer** para volver a la paleta inicial. No guarda nada.

Fuentes de verdad: [DESIGN.md](../BLUEPRINT/DESIGN-SYSTEM/DESIGN.md) describe valores y estado de aprobación; [tokens.css](tokens.css) es la fuente de valores **ejecutables del laboratorio**. Al cambiar tokens propuestos, actualizar ambos o documentar la desviación.

## Verificación local

```powershell
node --test design-lab/lab-contract.test.mjs
npx --no-install vite build --config design-lab/vite.config.ts
```

El build genera **solo** `design-lab/dist/` (ignorado por Git), nunca el build del producto. Revisar en móvil/desktop, foco de teclado y reduced motion. El laboratorio **no** es una pantalla terminada ni su apariencia está aprobada.
