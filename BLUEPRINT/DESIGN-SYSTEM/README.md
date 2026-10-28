# BeatGaler — Design System vivo (Design Lab)

**Documento rector único del trabajo de diseño.** Esta página define dónde mirar y cómo trabajar; **no define por adelantado la apariencia que aún no hemos construido**.

## Fuente de verdad, sin competición entre documentos

1. **Decisiones del propietario y prototipo ejecutable:** para el sistema experimental, lo que existe hoy es la interfaz interactiva de [`design-lab/`](../../design-lab/README.md): MASTER, Landing y Gallery. Sus componentes, estilos, tokens, estados, físicas y comportamientos reales son la fuente verificable. Una propuesta en Markdown no modifica esa realidad.
2. **Producto publicado / rama `main`:** `src/` y los demás servicios son la fuente de verdad de la aplicación real; Design Lab no es producción ni demuestra que el diseño se migró.
3. **Este README:** manda sobre el **proceso de diseño y la interpretación del resto de la carpeta**, pero nunca sobre lo que el código efectivamente hace.
4. **Skills:** la **referencia prioritaria de criterio y estilo** para proponer cambios es [`.agents/skills/`](../../.agents/skills/README.md) (Emil Kowalski). Ayudan a decidir y revisar; no sustituyen decisiones del propietario ni convierten automáticamente su estética en componentes implementados.
5. **Método para construir el sistema:** la [transcripción íntegra de UI Collective](UI-COLLECTIVE-TRANSCRIPT-ORIGINAL.txt) es **referencia metodológica de base**: variables, escalas, componentes, variantes, composición, estados, responsive y mantenimiento. La estudiaremos y adoptaremos lo útil, **sin obligación de replicar Figma ni sus tres capas de tokens**.
6. **Documentos auxiliares:** [`DESIGN.md`](DESIGN.md) es el inventario de lo implementado; [`ARCHITECTURE.md`](ARCHITECTURE.md) describe la arquitectura vigente y opciones; [`REFERENCES.md`](REFERENCES.md) documenta fuentes; [`UI-COLLECTIVE-TRANSCRIPT-NOTES.md`](UI-COLLECTIVE-TRANSCRIPT-NOTES.md) es un resumen. **No compiten con el código ejecutable ni imponen nuevas decisiones.**

Si hay contradicción: **se inspecciona el código y se consulta la decisión del propietario; no se escoge arbitrariamente un documento**. Lo no construido se marca **[PENDIENTE]**. No presentar una sugerencia como [LAB] ya implementado.

## El Design System que estamos construyendo

- **MASTER:** espacio de Foundations (colores, tipografía, espaciado, etc.) y componentes interactivos con variantes y parámetros. **MASTER fue rediseñado** como workbench premium con 58 fichas, búsqueda, inspector y demos interactivas. Es una propuesta experimental implementada, **pendiente de validación estética y pruebas reales con el propietario**.
- **Landing:** demostración artística de cómo se ven y se mueven los componentes; personalidad más atrevida.
- **Gallery:** demostración de la aplicación sobria y precisa, con los mismos fundamentos compartidos.
- **Físicas y movimiento:** forman parte de componentes/programas **ejecutables**, no únicamente de variables de fuerza, gravedad, repulsión o timing. Documentar parámetros *y* comportamiento observable (puntero, touch, interacción, retorno, interrupción, reduced motion, rendimiento). La órbita extraída vive en `design-lab/motion/Orbit.tsx`; las funciones genéricas de física están en `design-lab/motion/physics.ts` y se prueban en `MotionPlayground.tsx`. No son una librería de gestos productiva.

**MASTER presenta cuatro áreas de navegación (Foundations, Components, Motion & Physics y Patterns), que no son niveles de tokens.** Landing y Gallery son superficies de prueba, no capas adicionales del sistema. La propuesta de tres capas Brand → Alias → Mapped del tutorial queda como referencia opcional; introducirla solo si aparece una necesidad real de escalabilidad.

## Flujo OBLIGATORIO para agentes y para cualquier cambio de diseño

1. **Leer este README** y examinar los archivos relevantes de `design-lab/` y el componente que realmente existe. Para crear o ampliar el sistema de diseño, leer también la [transcripción original completa](UI-COLLECTIVE-TRANSCRIPT-ORIGINAL.txt) como base metodológica, distinguiendo las propuestas del tutorial de nuestras decisiones.
2. **Leer las skills pertinentes antes de diseñar o escribir código.** Elegir por tarea:
   - Interfaz y calidad de aplicación: `apple-design`, `emil-design-eng`, `mobile-native`, `break-ui`.
   - Movimiento, resortes, repulsión y rendimiento: `animate`, `animation-performance`, `review-animations`, `improve-animations`.
   - Comparación de propuestas: `prototype`; selección de piezas: `pick-ui-library`.
   Las rutas están en `../../.agents/skills/<nombre>/SKILL.md`. Usar los archivos de apoyo de una skill cuando existan.
3. **Aplicar cambios al laboratorio interactivo**, no solo a documentos. Buscar que las reglas se compartan entre MASTER, Landing y Gallery cuando corresponda.
4. **Validar** desktop/móvil, estados, teclado, touch, reduced motion y fluidez; ejecutar las pruebas focalizadas del laboratorio. Si una física o propiedad solo existe en Landing, no declararla componente compartido.
5. **Documentar después** el resultado real, las decisiones aprobadas y lo pendiente; evitar tablas futuras que compitan con el CSS y los componentes actuales.

## Archivos de implementación

- `design-lab/index.html` + `main.tsx`: entrada del HTML de prueba (Vite/React, no un único HTML estático).
- `App.tsx`: navegación de tres vistas y estado de Foundations, portadas y player; Landing utiliza la órbita extraída.
- `system/MasterPage.tsx` + `system/catalog.ts` + `system/studio.css`: workbench MASTER y 58 fichas con inspector, responsive y muestras.
- `system/primitives.tsx` + `system/foundations.ts`: componentes de UI adicionales y variables CSS editables.
- `motion/physics.ts` + `motion/MotionPlayground.tsx` + `motion/Orbit.tsx`: motor físico puro, demo interactiva y órbita compartida.
- `GalleryPage.tsx`: galería y sus interacciones ficticias.
- `components.tsx`: primitives `LabButton`, `LabField`, `LabTag`, `LabBeatTile`, `LabPlayer`, etc.
- `tokens.css`, `lab.css`, `gallery.css`: valores y estilos utilizados hoy.
- `coverSources.ts`, `data.ts`: muestras Generated/Real y datos ficticios.
- `lab-contract.test.mjs`: algunas verificaciones del laboratorio.

**Límite de seguridad:** solo UI aislada, sin login, Cloud, API, almacenamiento real, MASTER técnico, INDEX ni audio verdadero. No modificar `src/`, `main` o producción ni publicar las carátulas de terceros sin autorización y derechos verificados.

**Estado:** sistema en construcción; MASTER ya fue reconstruido y supera la prueba automatizada aislada de contratos, TypeScript y build. **No está visualmente aprobado**, no está migrado a producción y necesita pruebas móviles/teclado/lectores de pantalla en hardware real. Los 58 registros del catálogo no implican 58 componentes de producción.
