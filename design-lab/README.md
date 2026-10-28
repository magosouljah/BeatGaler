# BeatGaler Design Lab — landing y demo aisladas

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

## Navegación

- **Landing primero:** título BeatGaler, descripción de almacenamiento ilimitado y organización por tags, metadata y cover art; CTA `Create ur Galer`. Se basa en el HTML de referencia de la landing circular.
- **Create ur Galer:** entra a la galería ficticia. `Log in` también navega a la demo, sin autenticar.
- **beat galer / ← Landing:** regresa a la primera pantalla.
- **MASTER:** acceso discreto abajo a la derecha en las pantallas ficticias; abre el catálogo de componentes y tokens editables. Este botón NO formará parte de la landing de producción.

## Selector de fuentes de portadas

En **MASTER → Design foundations → Artwork mode** elegir `Generated` o `Real covers`. Cambia simultáneamente Landing, Gallery, player y muestras de MASTER. El modo predeterminado es `Generated`; `sessionStorage` recuerda el selector al navegar o recargar durante la misma pestaña.

El archivo aportado contiene **20 JPG** (y también audio/MIDI/HTML que no deben importarse). Para cargar esas imágenes locales, guardar `Downloads.zip` en la carpeta Downloads de Windows y ejecutar:

```powershell
powershell -ExecutionPolicy Bypass -File .\design-lab\import-real-covers.ps1 -ZipPath "$HOME\Downloads\Downloads.zip"
```

Se copian solo los 20 JPG a `design-lab/assets/real-covers/`. Vite los empaqueta localmente; ninguna dependencia de enlaces o producción. Como la órbita tiene 24 posiciones, repite cuatro cubiertas. Sin archivos JPG, el modo Real covers utiliza `bg-v1` como fallback. Para compartir imágenes con otro PC, hacer commit de `cover-*.jpg` **solo en la rama de diseño**; el importador no sube material a GitHub. Revisar derechos de uso antes de publicar imágenes de terceros fuera del laboratorio.

## Arte original, sin imágenes de muestra aleatorias

En modo **Generated**, las portadas se generan completamente en el navegador con `design-lab/proceduralBeatBackground.ts`, **copia exacta e independiente** de `src/lib/proceduralBeatBackground.ts`. Usa la misma versión `bg-v1`, idéntico algoritmo determinista y fondo **`#0c0c0c`**.

La portada y el canvas de la landing comparten ese negro exacto. Se limitó el cambio de escala de las portadas posteriores de la órbita para que no parezcan diminutas.

La copia del generador se verifica contra el archivo fuente con `lab-contract.test.mjs`; si el generador real cambia, hay que sincronizar ambos conscientemente. No se importa código de `src/` al bundle de laboratorio.

## Comprobaciones seguras y focalizadas

```powershell
node --test design-lab/lab-contract.test.mjs
npx --no-install vite build --config design-lab/vite.config.ts
```

El build solo genera `design-lab/dist/` (ignorado por Git). No correr suites globales ni desplegar la app. Comprobar manualmente escritorio, móvil, contraste, foco de teclado y reducción de movimiento.

El color `--lab-canvas` está fijado a `#0c0c0c` para coincidir con el generador; no significa que se haya cambiado el `#090909` del diseño actual de la aplicación real. Los demás tokens siguen experimentales. La documentación de producto está en `BLUEPRINT/DESIGN-SYSTEM/DESIGN.md`.
