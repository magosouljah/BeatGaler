# BeatGaler Design Lab — Design System vivo, aislado

**Esta interfaz interactiva es la referencia visual y funcional actual del Design System experimental.** MASTER, Landing y Gallery muestran lo que realmente existe hoy, no un plan ideal. Las reglas de trabajo están en [BLUEPRINT/DESIGN-SYSTEM/README.md](../BLUEPRINT/DESIGN-SYSTEM/README.md). Antes de modificar la UI, los agentes deben leer las skills adecuadas de [`.agents/skills/`](../.agents/skills/README.md).

**MASTER se reconstruyó como biblioteca interactiva (propuesta visual todavía pendiente de aprobación)**. La órbita de Landing ahora es un componente compartido con MASTER y las matemáticas de física viven en módulos aislados de `motion/`. Documentar solo las capacidades que existen en el código.

**No es producción.** No utiliza cuentas, datos de usuarios, Telegram, Cloud API, audio, servicios externos ni carga archivos. Solo hay fixtures y estado local del navegador.

## Ejecutar en Windows (PowerShell)

```powershell
cd E:\\777\\app\\BeatGaler
git fetch origin
git switch design/beatgaler-design-system-lab-v1
git pull --ff-only origin design/beatgaler-design-system-lab-v1
npm ci
npx --no-install vite --config design-lab/vite.config.ts
```

Abrir **http://127.0.0.1:4173/**. Para detener, `Ctrl+C`.

## MASTER — Design System Workbench [LAB]

MASTER ofrece **58 fichas** distribuidas entre **Foundations**, **Components**, **Motion & Physics** y **Patterns**. Cada ficha incluye descripción, anatomía, propiedades, estados y archivo fuente. La navegación tiene búsqueda por componente/grupo, inspector de propiedades a la derecha, preview redimensionable (Fluid / Tablet / Phone) y un control para someter muestras a texto largo. Es una biblioteca de prototipos con estado local; **58 fichas no significan 58 componentes de producción acabados**.

Los controles implementados cubren botones y estados, icon buttons, input y textarea, select, combobox, radio, checkbox, switch, slider, chips/tags, badges, avatares, artwork, beat cards, player, cards, lista, tabla, tabs, breadcrumbs, paginación, toolbar, menú, popover, tooltip, diálogo, alertas, toast, progreso, skeleton y empty state.

El editor de Foundations modifica en tiempo real colores de superficie/texto/acento, espaciamiento base, radios, tamaño de control, tipografía de muestras, sombras y duración normal. Los elementos que usan esos tokens reaccionan a los cambios. El canvas de artwork sigue bloqueado a `#0c0c0c`, y **algunas decisiones de Landing y Gallery aún usan CSS local**. El modo de portadas se comparte entre las tres vistas y se recuerda en la sesión.

La sección Motion & Physics permite probar cinco comportamientos (spring, atracción, repulsión, inercia y gravedad) con drag, puntero, teclado, parámetros editables, pausa, reset y reduced motion. Sus cálculos están en `motion/physics.ts` y son reutilizables por otros componentes. La órbita original está en `motion/Orbit.tsx` y se monta tanto en Landing como en la ficha de MASTER.

**Pruebas automatizadas:** `lab-contract.test.mjs`, `system-contract.test.mjs`, TypeScript estricto de `design-lab/tsconfig.json` y build Vite independiente. GitHub Actions: [Design Lab Workbench](https://github.com/magosouljah/BeatGaler/actions/workflows/design-lab-workbench.yml). La primera ejecución validada pasó el 28-10-2026; todavía falta inspección visual/manual real a 320px, zoom 200%, screen readers y teléfono físico.

## Navegación

- **Landing primero:** título BeatGaler, descripción de almacenamiento ilimitado y organización por tags, metadata y cover art; CTA `Create ur Galer`. Se basa en el HTML de referencia de la landing circular.
- **Create ur Galer:** entra a la galería ficticia. `Log in` también navega a la demo, sin autenticar.
- **Landing / MASTER:** interruptores de desarrollo de texto plano abajo a la derecha (no forman parte del producto). En Gallery y MASTER no aparece el enlace de Landing arriba.

## Selector de fuentes de portadas

En **MASTER → Design foundations → Artwork mode** elegir `Generated` o `Real covers`. Cambia simultáneamente Landing, Gallery, player y muestras de MASTER. El modo predeterminado es `Generated`; `sessionStorage` recuerda el selector al navegar o recargar durante la misma pestaña.

Hay **24 imágenes reales distintas** dentro de `design-lab/assets/real-covers/`: las primeras 20 JPG optimizadas a 384×384 y otras cuatro AVIF optimizadas a 320×320. Todas se incluyen en el build de Vite; no se repiten posiciones en la órbita de 24. Si se quiere sustituirlas localmente por los originales del ZIP, guardar `Downloads.zip` en la carpeta Downloads de Windows y ejecutar:

```powershell
powershell -ExecutionPolicy Bypass -File .\design-lab\import-real-covers.ps1 -ZipPath "$HOME\Downloads\Downloads.zip"
```

El comando opcional sustituye solo los JPG 01–20 por originales del primer ZIP; no toca las AVIF 21–24. No es necesario para probar el selector. Vite empaqueta las 24 portadas sin enlaces externos ni producción. Sin ningún JPG, Real covers usaría `bg-v1` como fallback. Revisar derechos de uso antes de publicar imágenes de terceros fuera del laboratorio.

## Galería experimental (inspirada en la app real)
La barra superior contiene búsqueda, ordenamiento (Manual/Name/BPM) y selección. Los filtros de tags tienen tres estados: clic para incluir, segundo para excluir, tercero para limpiar; botón de puntos o clic derecho para modificar su color con la paleta de BeatGaler. Los colores se comparten durante la sesión entre los componentes ficticios.
Los cards muestran portada, título, tag y key/BPM; se eliminaron el heading redundante y los artistas inventados visibles. El reproductor es una **copia visual aislada** de la playbar real: cápsula flotante, controles shuffle/anterior/play/siguiente/repeat, artwork y scrubber, cola/volumen y más. Todos los controles alteran **solo estado ficticio**; no reproducen audio, no suben ni borran beats, y no leen datos reales. La dirección estética del header es una adaptación dark/translucent de las referencias adjuntas, sin usar assets ni código de Coinbase.

## Arte original, sin imágenes de muestra aleatorias

En modo **Generated**, las portadas se generan completamente en el navegador con `design-lab/proceduralBeatBackground.ts`, **copia exacta e independiente** de `src/lib/proceduralBeatBackground.ts`. Usa la misma versión `bg-v1`, idéntico algoritmo determinista y fondo **`#0c0c0c`**.

La portada y el canvas de la landing comparten ese negro exacto. Se limitó el cambio de escala de las portadas posteriores de la órbita para que no parezcan diminutas.

La copia del generador se verifica contra el archivo fuente con `lab-contract.test.mjs`; si el generador real cambia, hay que sincronizar ambos conscientemente. No se importa código de `src/` al bundle de laboratorio.

## Comprobaciones seguras y focalizadas

```powershell
node --test design-lab/lab-contract.test.mjs design-lab/system-contract.test.mjs
npx --no-install tsc --project design-lab/tsconfig.json --noEmit
npx --no-install vite build --config design-lab/vite.config.ts
```

El build solo genera `design-lab/dist/` (ignorado por Git). No correr suites globales ni desplegar la app. Comprobar manualmente escritorio, móvil, contraste, foco de teclado y reducción de movimiento.

MASTER utiliza ahora `system/MasterPage.tsx` y `system/studio.css`, no la antigua cuadrícula de muestras. El color `--lab-canvas` está fijado a `#0c0c0c` para coincidir con el generador; no significa que se haya cambiado el `#090909` del diseño actual de la aplicación real. Los demás tokens siguen experimentales. La guía del Design System experimental y su regla de autoridad están en `BLUEPRINT/DESIGN-SYSTEM/README.md`. `DESIGN.md` es solo un inventario del estado implementado.
