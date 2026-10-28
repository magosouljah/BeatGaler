# REFERENCES.md — Fuentes de estudio, nunca autoridad de estilos

La **fuente de verdad** del Design System experimental es [Design Lab](../../design-lab/README.md). El procedimiento y la prioridad se definen solo en [README.md](README.md). Este archivo es únicamente un índice de procedencia: **no prescribe colores, tamaños, botones o animaciones**.

## Guía principal para diseñar: skills de Emil Kowalski

Repositorio de origen: https://github.com/emilkowalski/skills

Skills instaladas localmente y versionadas en [`.agents/skills/`](../../.agents/skills/README.md), con licencia MIT y revisión fijada a un commit upstream. **Antes de diseñar, consultar las apropiadas a la tarea**:

| Necesidad | Skills relevantes |
| --- | --- |
| Criterios de UI de aplicación, jerarquía, tacto | `apple-design`, `emil-design-eng`, `mobile-native` |
| Animación, springs, repulsión, fluidez | `animate`, `animation-performance`, `review-animations`, `improve-animations`, `animation-vocabulary` |
| Propuestas comparables y robustez | `prototype`, `break-ui`, `find-animation-opportunities`, `pick-ui-library` |

Son **instrucciones y conocimientos de diseño**; no dependencias de ejecución ni un paquete global instalado en ChatGPT. Interpretarlas con el contexto de BeatGaler y las decisiones del propietario. Consultar la documentación oficial cuando se requiera verificar accesibilidad o compatibilidad.

## Ejemplos aportados: formato, no identidad

- `DESIGN-coinbase.md` (archivo aportado el 28-10-2026): referencia preferida para el **formato detallado** de sistemas documentados (tokens, estructura, variantes, anatomía, tablas y ejemplos). No tomar su paleta ni tipografías.
- `DESIGN-apple.md` (archivo aportado el 28-10-2026): referencia de presentación web, **menos apropiada para Gallery** que las skills de ingeniería de aplicaciones. No copiar la estética de su web.
- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/): complemento oficial sobre interfaces, distinto de un análisis de su página web.
- [VoltAgent / awesome-design-md](https://github.com/VoltAgent/awesome-design-md) (MIT): colección de análisis no oficiales de diseños de marcas. También contiene ejemplos de Linear, Spotify, Runway, Figma y Framer; son inspiración opcional, no una lista de requisitos.
- [Transcripción íntegra de UI Collective](UI-COLLECTIVE-TRANSCRIPT-ORIGINAL.txt): **base metodológica** de cómo construir y mantener el Design System (valores, roles, variantes, responsive, componentes y pruebas). Está guardada literalmente, sin modificaciones. [Notas de lectura](UI-COLLECTIVE-TRANSCRIPT-NOTES.md). Su modelo de tres niveles es una opción, no arquitectura obligatoria.

**Licencias:** no redistribuir fuentes, fotografías, portadas, logos o marcas de terceros sin autorización. Las skills de Emil conservan su licencia MIT en `.agents/skills/`.

## Fuentes técnicas reales

- Prototipo actual: `design-lab/` (MASTER, Landing, Gallery).
- App publicada y desarrollo real: `src/styles/design-foundations.css`, `src/components/`, `src/app/` en `main`.
- Protección de producción: no llevar cambios del laboratorio a `src/` ni desplegar sin aprobación.
