# Arquitectura — laboratorio DESIGN

## Aplicación experimental

La única entrada es `DESIGN/index.html` → `DESIGN/main.tsx` → `DESIGN/App.tsx`. Vite se configura con `DESIGN/vite.config.ts` y nunca utiliza `src/main.tsx`. El comando es:

```powershell
npx --no-install vite --config DESIGN/vite.config.ts --port 4174
```

## Carpetas

- `DESIGN/MASTER/`: `MasterPage.tsx` (navegación, estado local, reglas y vista de Playbar), `Player.tsx` (copia adaptada de `src/components/Player.tsx`), `bridge.tsx` (Artwork local y etiquetas), `fixtures.ts` (beats ficticios), `master.css` (márgenes y layout) y `assets/` (14 PNG originales del reproductor).
- `DESIGN/LANDING/`: `LandingPage.tsx` mantiene la órbita original, CTA y movimiento contrario al puntero. `landing.css` recoge el CSS del laboratorio anterior, incluidos estilos globales del prototipo.
- `DESIGN/GALLERY/`: `GalleryPage.tsx` y `gallery.css` son el prototipo anterior de galería, con el `LabPlayer` ficticio.
- `DESIGN/shared/`: `components.tsx`, `data.ts`, `coverSources.ts`, `proceduralBeatBackground.ts` y `tokens.css`. `assets/real-covers/` contiene las 24 portadas locales.
- `DESIGN/import-real-covers.ps1`: importación local opcional de portadas desde ZIP. `DESIGN/lab-contract.test.mjs`: contratos del laboratorio. `DESIGN/tsconfig.json` y `DESIGN/.gitignore`: configuración aislada.

Las 24 portadas y 14 iconos se trasladaron manteniendo **los mismos blobs Git**, no se regeneraron ni comprimieron. El Lab no importa ni ejecuta código de `src/`, ni usa cuentas, Cloud, API o audio real.

## Cómo se amplía

La transcripción UI Collective explica tokens brand → alias → mapped, colecciones, componentes, variantes y estado. Es una referencia, no una estructura obligatoria prematura. `MASTER.md` define el comportamiento del taller y `DESIGN.md` registra solo las piezas existentes. Primero perfeccionar la Playbar; añadir otros componentes únicamente con autorización del propietario.

El directorio anterior `design-lab/` se eliminó para evitar dos fuentes de verdad. No modificar `src/`, `main` ni producción.
