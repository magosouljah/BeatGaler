---
name: BeatGaler Design System — inventario ejecutable
status: descriptivo; no normativo
source: design-lab/
---

# DESIGN.md — Estado implementado en la rama experimental

**El único documento rector del proceso es [README.md](README.md).** Este inventario describe el código de `design-lab/`; no aprueba una identidad visual definitiva y no aplica automáticamente ninguna regla a producción.

## [LAB] MASTER — biblioteca interactiva

MASTER fue reconstruido como una herramienta de trabajo con **58 fichas catalogadas** (véase `design-lab/system/catalog.ts`), navegación lateral con búsqueda por nombre/categoría, inspector contextual, preview de ancho fluido/tablet/teléfono, y modo de etiquetas largas para probar contenido extremo.

Cada ficha declara **anatomía, propiedades, estados y procedencia del código**. Los ejemplos de UI cuentan con estado local, no son solo capturas. Las fichas describen muestras o agrupaciones; el número 58 **no equivale a 58 paquetes productivos ni a una matriz totalmente exhaustiva de variantes y estados**. Para verificar el comportamiento, abrir el ejemplo del laboratorio.

| Área | Componentes y capacidades [LAB] | Implementación |
| --- | --- | --- |
| **Foundations** | Paleta con editor, tipografía de muestra, espaciado, radios, bordes/foco, elevación, tamaños, responsive, iconografía y selector de portadas. | `system/foundations.ts`, `system/MasterPage.tsx`, `tokens.css`, `system/studio.css` |
| **Acciones y formularios** | `LabButton` (primary/secondary/ghost/danger, sm/md/lg/hero, rounded/pill, loading/disabled), icon buttons, links, `LabField`, búsqueda, textarea, select, combobox, checkbox, radio, switch y slider. | `components.tsx`, `system/primitives.tsx`, `system/MasterPage.tsx` |
| **Identidad y medios** | Tags/chips, badges semánticos, avatares con iniciales, iconos SVG, artwork, beat cards y reproductor simulado con seek, volumen, cola, shuffle y repeat. | `components.tsx`, `system/primitives.tsx` |
| **Contenedores y navegación** | Cards, listas, tabla semántica, tabs con flechas, breadcrumbs, paginación y toolbar. | `system/primitives.tsx`, `system/MasterPage.tsx` |
| **Capas y feedback** | Menú de acciones, popover, tooltip, diálogo con Escape y contención de foco, alerta, toast descartable, progreso, spinner, skeleton y estado vacío. | `system/primitives.tsx`, `system/MasterPage.tsx` |
| **Motion & Physics** | `springStep`, `vectorForce` (atracción/repulsión), `inertialProjection`, `integrateGravity`; playground con arrastre, sliders de parámetros, teclado, reset, pausa y `prefers-reduced-motion`. | `motion/physics.ts`, `motion/MotionPlayground.tsx` |
| **Patterns** | Biblioteca filtrada, selección múltiple, formulario de metadata, cola, upload ficticio y recuperación de búsqueda vacía. | `system/MasterPage.tsx`, `GalleryPage.tsx` |
| **Órbita reutilizada** | Componente `Orbit` compartido por MASTER y Landing; 24 portadas, profundidad, suavizado y repulsión al cursor. Respeta reduced motion. | `motion/Orbit.tsx` |

### [LAB] Variables editables compartidas

Se conservó la escala CSS existente en `tokens.css`; `toLabVariables` expone ajustes en tiempo real de `surface`, `raised`, `ink`, `secondary`, `accent`, espaciado base, radios, altura de control, tipografía de la biblioteca, sombra y transición normal. Los componentes que consumen **esas variables** reaccionan inmediatamente.

El canvas `#0c0c0c` permanece bloqueado para coincidir con el generador procedural `bg-v1`. El modo `Generated / Real covers` se comparte entre MASTER, Landing y Gallery; hay 24 portadas locales. Las modificaciones de tokens no se guardan permanentemente; el selector de portada sí se mantiene en `sessionStorage` durante la sesión. Algunos estilos de Landing y Gallery aún usan valores locales literales, por lo que **no todos los cambios de Foundations afectan a todas las superficies**.

### [LAB] Lo que se conserva

- **Landing:** diseño orbital original, CTA `Create ur Galer` y navegación ficticia; física de la órbita extraída sin sustituir su comportamiento principal.
- **Gallery:** búsqueda, orden, tags en tres estados, color de tags, selección, cards y player ficticio; sin llamadas a servicios reales.
- **Seguridad del prototipo:** ningún módulo nuevo importa `src/`, conecta APIs, reproduce audio ni modifica usuarios o archivos reales.

## Validación

El workflow aislado `.github/workflows/design-lab-workbench.yml` ejecuta contratos Node, pruebas matemáticas de físicas, parser TSX, TypeScript estricto del laboratorio y build independiente de Vite. **Ejecución exitosa**: [GitHub Actions #40745774360](https://github.com/magosouljah/BeatGaler/actions/runs/40745774360) sobre el commit `915bf6c` (28-10-2026). Las pruebas automatizadas son principalmente de contrato y lógica; no sustituyen inspección visual y gestual en teléfonos físicos.

## [PENDIENTE] Lo que no se afirma como terminado

- Validar visualmente MASTER a múltiples resoluciones, con zoom, lectores de pantalla, touch real, móviles físicos y contenido extremo; decidir ajustes estéticos con el propietario.
- Mejorar cierre y navegación de menús/combobox, semántica ARIA de casos complejos y matriz de pruebas de estados de cada ficha; introducir pruebas automatizadas de interacción/renderizado.
- Unificar progresivamente estilos específicos de Landing/Gallery que aún no consumen tokens y evaluar si el conjunto necesita más componentes; no crear variantes redundantes por volumen.
- Extender el motor de físicas a patrones adicionales del producto real cuando exista un caso real; medir fluidez en dispositivos de recursos limitados.
- Migración a `src/`: **no realizada ni autorizada**. [EXISTENTE] La aplicación real utiliza sus propias primitivas y `src/styles/design-foundations.css` en `main`.

**Límites de seguridad:** MASTER técnico, INDEX y Telegram no intervienen en este laboratorio. Nada se ha publicado en producción.
