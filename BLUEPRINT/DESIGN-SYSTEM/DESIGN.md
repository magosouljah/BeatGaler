---
name: BeatGaler Design Lab — inventario actual
status: descriptivo; no normativo
source: design-lab/
---

# DESIGN.md — Lo que existe, no lo que deberíamos tener

**Este documento NO es jefe del diseño.** La autoridad del flujo y las precedencias está en [README.md](README.md); la realidad experimental está en el código de `design-lab/`. No aplicar automáticamente reglas visuales, números ni componentes que aparecían en versiones anteriores de este archivo. Los borradores anteriores permanecen recuperables por el historial de Git.

## Estado actual (verificar siempre con código)

| Área | [LAB] Implementación observable | Código |
| --- | --- | --- |
| MASTER | Edición local de varios colores, reset de tokens, selector `Generated / Real covers`, muestras de botones, input, chips, artwork, card y player. **Diseño visual pendiente de aprobación.** | `App.tsx`, `components.tsx`, `lab.css`, `tokens.css` |
| Landing | Órbita de portadas, movimiento propio, repulsión al puntero, botón `Create ur Galer` y navegación ficticia. Movimiento reducido contemplado en la implementación. | `App.tsx`, `lab.css` |
| Gallery | Búsqueda, ordenación, filtros de tags, selección, beat tiles y reproductor en estado de demostración. | `GalleryPage.tsx`, `components.tsx`, `gallery.css` |
| Componentes compartidos | `LabButton`, `LabField`, `LabTag`, `LabBeatTile`, `LabArtwork`, `LabPanel`, `LabPlayer`. Las variantes reales son las que admite el código, no una tabla de aspiraciones. | `components.tsx` |
| Tokens | Valores que actualmente declara `tokens.css`, con algunas variables de color ajustables en MASTER mediante estado local. No todos los tokens tienen editor. | `tokens.css`, `App.tsx` |
| Covers | Modo Generated/Real compartido en las tres vistas; muestras locales. | `coverSources.ts`, `App.tsx` |

**Ejemplos verificables [LAB]:** `--lab-canvas: #0c0c0c`; `--lab-surface: #101010`; botones con tamaños `sm/md/lg/hero` y variantes `primary/secondary/ghost/danger`. Obtener **todas** las cifras y estados restantes del CSS y TSX, no de este resumen.

**[EXISTENTE]** La aplicación de producción en `main` sigue su propio `src/styles/design-foundations.css` y código de `src/`; nada aquí supone una migración.

**[PENDIENTE]** Rediseñar la presentación de MASTER; formalizar una biblioteca de componentes más completa; decidir y extraer contratos reutilizables para físicas; completar pruebas y aprobación visual de estados/responsive. No afirmar que estos elementos ya existan.

## Cómo actualizar el inventario

Después de cada cambio comprobado del Design Lab, actualizar solo las filas afectadas. Para decidir estilo y comportamiento consultar primero las [skills](../../.agents/skills/README.md) relevantes y [README.md](README.md). Las referencias externas y la transcripción **no** dictan el resultado visual de BeatGaler.

**Límites:** el mock no usa login, API, Cloud, ni el MASTER técnico, INDEX, Telegram o servicios reales. Seguir aislado de producción.
