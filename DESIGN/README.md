# DESIGN — BeatGaler

**Esta carpeta contiene y ejecuta el laboratorio experimental**, anteriormente en `design-lab/`. Solo hay una aplicación y un servidor; no se mantiene una segunda copia del laboratorio.

## Carpetas

- **`MASTER/`** — Design System incremental: Playbar y Toolbar, navegación izquierda, reglas, Playbar tomada de la producción y sus 14 iconos originales. Márgenes horizontales aprobados de 32 px; Playbar de 68 px de alto, portada que se transforma una sola vez al comprimirse y seek reactivo sin latencia durante resize.
- **`LANDING/`** — landing experimental y su órbita circular de portadas.
- **`GALLERY/`** — galería ficticia, filtros, Toolbar Liquid Glass y reproductor de muestra anterior.
- **`REFERENCES/TOOLBAR-GLASS/`** — cinco referencias visuales del botón Liquid Glass sobre fondos diferentes, para la futura Toolbar V2.
- **`shared/`** — componentes, tokens, datos de beats ficticios, generador original `bg-v1` y 24 carátulas locales.
- **`App.tsx`, `main.tsx`, `index.html`, `vite.config.ts`** — la única app y servidor aislados.

## Abrir desde la raíz del repositorio (PowerShell)

```powershell
git fetch origin refs/heads/design/beatgaler-design-system-lab-v1:refs/remotes/origin/design/beatgaler-design-system-lab-v1
git merge --ff-only origin/design/beatgaler-design-system-lab-v1
npx --no-install vite --config DESIGN/vite.config.ts --port 4174
```

Abrir **http://127.0.0.1:4174/** y entrar a MASTER. Detener Vite con `Ctrl+C`. **Ya no existe** el comando antiguo con `design-lab/vite.config.ts`.

## Comprobaciones

La verificación visual automatizada corre en Chrome real y captura vistas wide/compact de MASTER como artefactos del workflow GitHub Actions:

```powershell
node DESIGN/playbar-browser-check.mjs
```


```powershell
node --test DESIGN/lab-contract.test.mjs
npx --no-install tsc --project DESIGN/tsconfig.json --noEmit
npx --no-install vite build --config DESIGN/vite.config.ts
```

El build se escribe en `DESIGN/dist/` (ignorado por Git). Los 24 covers y los 14 iconos se movieron sin alterar sus bytes. El laboratorio no accede a usuarios, producción, API, Cloud ni audio. Los archivos de `src/` son la referencia de los componentes reales, pero **no se importan directamente** al bundle.

## Cómo trabajar

- `BLUEPRINT/DESIGN-SYSTEM/MASTER.md` establece cómo funciona MASTER y cómo se agregan componentes.
- `BLUEPRINT/DESIGN-SYSTEM/DESIGN.md` enumera lo implementado; `ARCHITECTURE.md` explica su código. `REFERENCES.md` y el transcript son fuentes metodológicas.
- Antes de cada incorporación, consultar las skills relevantes de `.agents/skills/`. Añadir **solo componentes aprobados, uno a la vez**.

## Toolbar V2 — material de cámara aprobado

- `shared/GlassButton.tsx` reutiliza la lente, desplazamiento SVG y dos arcos de luz localizados de `CameraGlass`. El botón de cámara continúa como demo independiente usando el mismo componente; no hay material CSS genérico alternativo.
- `shared/Toolbar.tsx` permanece V1 intacta. `shared/ToolbarV2.tsx` usa GlassButton para Search, Sorting, Select y Profile con sus estados y menús. MASTER muestra ambas versiones y los cinco fondos ópticos.
- Comprobación automatizada de V2 en Chrome real (incluye interacciones, escritorio/móvil, accesibilidad, movimiento reducido y capturas): `node DESIGN/toolbar-v2-browser-check.mjs`. GitHub Actions guarda las capturas junto a las referencias WebP en el artefacto `toolbar-v1-v2-chrome-visual-check`.
- **Estado:** nueva candidata implementada en DESIGN; la aprobación visual final de V2 corresponde al propietario. No se modifica GALLERY, `src/` ni producción.
