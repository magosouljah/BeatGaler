# Arquitectura del Design Lab — mínima e incremental

## Qué corre

- `design-lab/App.tsx`: tres vistas de laboratorio; Landing conserva su órbita original y Gallery sus componentes de muestra.
- `design-lab/playbar/MasterPage.tsx`: documento visual simple, sin inspector ni paneles.
- `design-lab/playbar/Player.tsx`: adaptación casi literal del componente real de producción `src/components/Player.tsx`, sin conexiones de backend.
- `design-lab/playbar/assets/`: catorce PNG originales del reproductor.
- `design-lab/playbar/fixtures.ts`: conversión de seis beats ficticios a props del reproductor.
- `design-lab/playbar/bridge.tsx`: Artwork local y dos helpers de etiquetas.
- `design-lab/playbar/master.css`: tipografía y espaciado discretos de la página Markdown-like.
- `design-lab/GalleryPage.tsx`, `components.tsx`, `tokens.css`, `gallery.css`, `lab.css`: demos previas, sin afectar a producción.

No hay catálogo de componentes adelantado, editor global, inspector ni motor de físicas genérico.

## Método para crecer

La transcripción de UI Collective explica tokens **brand → alias → mapped**, colecciones, componentes, variantes y estado. Es una **referencia**, no tres niveles obligatorios ni especificaciones de UI aprobadas. Solo abstraer tokens y estados cuando un componente real lo justifique. Cada incorporación se somete a revisión del propietario.

**Aislamiento:** no importar código de `src/` ni servicios a MASTER. Copiar el mínimo código/arte real necesario en `design-lab/` y validar contra la fuente publicada. Sin audio, endpoints o operaciones de usuarios.
