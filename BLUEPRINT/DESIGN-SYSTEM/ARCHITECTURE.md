# ARCHITECTURE.md — Organización actual, sin arquitecturas obligatorias

**Documento descriptivo; el único procedimiento rector es [README.md](README.md).** Este texto no exige implementar tres capas de tokens, ni crear ficheros de especificación por componente, ni sustituye el laboratorio interactivo.

## Lo que existe [LAB]

```text
design-lab/
  index.html + main.tsx  # entrada del HTML falso, con Vite/React
  App.tsx                # MASTER y Landing; navegación y física orbital
  GalleryPage.tsx        # Gallery
  components.tsx         # componentes reutilizados
  tokens.css             # fundamentos actuales
  lab.css / gallery.css  # estilos existentes
  coverSources.ts        # selector Generated / Real
```

En la experiencia visual proponemos **dos áreas de MASTER**:

- **Foundations:** valores y criterios compartidos (color, espacio, tipo, radios, etc.).
- **Components:** piezas reutilizables, estados, variantes y comportamientos.

**Landing y Gallery** no son una tercera capa de configuración; son pantallas de demostración. La existencia efectiva de un token o componente se comprueba en código, no aquí.

## Físicas: tanto ejecución como parámetros

Una física de repulsión, gravedad, spring, inercia o parallax solo es reutilizable cuando su **implementación real** puede compartirse: respuesta al puntero/touch, integración por frame, interrupciones, límites, estado inicial, retorno, rendimiento, accesibilidad y reduced motion. Una tabla de fuerzas no sustituye eso.

Hoy la órbita de Landing está programada en `App.tsx`; **no** declaramos que exista ya un motor genérico de físicas o un editor de presets completo.

## Ideas no adoptadas [PENDIENTE]

La transcripción de UI Collective enseña `Brand → Alias → Mapped`. Es una **referencia de estudio**, no una decisión obligatoria para BeatGaler. Actualmente no hay evidencia de que una sola marca y un tema oscuro necesiten esa complejidad. Introducir alias, nuevos esquemas o generadores de CSS solo si los exige un problema real y después de probarlo en Design Lab.

Para criterios de implementación, animación y UI, leer las [skills locales](../../.agents/skills/README.md), no asumir que una arquitectura teórica tiene autoridad sobre el código.

**Producción:** el producto real vive en `src/` de `main`; ninguna decisión de este laboratorio puede migrarse automáticamente.
