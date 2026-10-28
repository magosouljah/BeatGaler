# BeatGaler Design Lab — taller de componentes

Este laboratorio está aislado de la aplicación real. **MASTER es un taller minimalista:** navegación izquierda (reglas/componentes) redimensionable y ocultable, y vista derecha con el componente centrado, sin dashboard, inspector, catálogo inventado ni vistas Fluid/Tablet/Phone. Reglas completas en `BLUEPRINT/DESIGN-SYSTEM/MASTER.md`.

## Dirección decidida

Añadimos **un componente real de BeatGaler cada vez** y lo perfeccionamos antes de avanzar. El primer componente es la **Playbar**. Landing y Gallery se conservan como demos separadas; no son la autoridad sobre el diseño de MASTER.

## Playbar: procedencia y límites

- Fuente de la UI: `src/components/Player.tsx` en la versión publicada `release/0.9.0-beta.2` (mismo código que `main` al copiarlo).
- Copia adaptada a `design-lab/playbar/Player.tsx`. Conserva la geometría, estilos en línea, iconos PNG originales, controles de shuffle/anterior/play/siguiente/repeat, scrubber, cola, menú y **slider de volumen vertical original**.
- Los 14 PNG originales de `src/assets/player-icons/` se copiaron íntegros a `design-lab/playbar/assets/`.
- Solo se reemplazaron imports de servicios, artwork y el acceso al sistema de archivos. El adaptador de portada usa datos e imágenes locales; la lógica de playback usa un estado ficticio. **No hay audio ni Cloud ni usuarios reales**. Los cambios aquí no modifican producción.
- `design-lab/playbar/MasterPage.tsx` muestra la única pieza de trabajo y la regla visual de Márgenes. La navegación lateral se arrastra para cambiar tamaño; debajo del mínimo se oculta y se restaura con el botón superior izquierdo. En móvil funciona como panel superpuesto. `master.css` usa `--lab-space-8` (32 px) como margen horizontal fijo del canvas de MASTER. La Playbar de MASTER mantiene 68 px de alto y al estrecharse reduce la portada y coloca el scrubber debajo de ella con una transición breve, sin modificar producción.

## Ejecutar (PowerShell)

```powershell
cd E:\777\app\BeatGaler
git fetch origin refs/heads/design/beatgaler-design-system-lab-v1:refs/remotes/origin/design/beatgaler-design-system-lab-v1
git merge --ff-only origin/design/beatgaler-design-system-lab-v1
npx --no-install vite --config design-lab/vite.config.ts --port 4174
```

Abre http://127.0.0.1:4174/ → **MASTER**.

## Verificar

```powershell
node --test design-lab/lab-contract.test.mjs
npx --no-install tsc --project design-lab/tsconfig.json --noEmit
npx --no-install vite build --config design-lab/vite.config.ts
```

`BLUEPRINT/DESIGN-SYSTEM/README.md` define el flujo de trabajo. No se toca `src/`, `main` ni producción.
