# DESIGN — BeatGaler

**Esta carpeta contiene y ejecuta el laboratorio experimental**, anteriormente en `design-lab/`. Solo hay una aplicación y un servidor; no se mantiene una segunda copia del laboratorio.

## Carpetas

- **`MASTER/`** — Design System incremental: navegación izquierda, reglas, Playbar tomada de la producción y sus 14 iconos originales. Márgenes horizontales aprobados de 32 px; Playbar de 68 px de alto, con transición al reducirse.
- **`LANDING/`** — landing experimental y su órbita circular de portadas.
- **`GALLERY/`** — galería ficticia, filtros y reproductor de muestra anterior.
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
