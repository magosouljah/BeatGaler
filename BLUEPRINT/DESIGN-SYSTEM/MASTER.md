# MASTER — contrato de trabajo

## Propósito

MASTER es un **taller funcional** para reunir, evaluar y perfeccionar los componentes **reales** de BeatGaler, de forma incremental. No es una pantalla de producción ni una landing; tampoco debe parecer un dashboard de análisis o mostrar fichas explicativas junto a los componentes. Lo visible es el componente en sí.

## Estructura fija y discreta

- **Navegación izquierda, pequeña:** primero **Reglas**, luego **Componentes** (y grupos cuando existan de verdad). La navegación se puede redimensionar, ocultar desde el encabezado o arrastrándola a un ancho mínimo, y restaurar con el botón que queda en su lugar. En pantallas estrechas pasa a superposición para no reducir el espacio del componente. Guardar preferencia de ancho/visibilidad solo en el navegador.
- **Área derecha:** muestra únicamente la vista seleccionada. **Un componente centrado, a su tamaño real**, sin inspector, títulos largos, especificaciones decorativas ni simuladores Fluid/Tablet/Phone.
- **Varios ejemplos del mismo componente:** orden vertical con separación suficiente para que no se solapen; no crear tarjetas que enmarquen o recorten popovers.
- **No inventar el catálogo:** solo aparecen entradas que están implementadas. El listado crecerá componente a componente cuando el propietario lo solicite.

## Reglas, márgenes y medidas

Las skills `.agents/skills/emil-design-eng`, `apple-design` y `mobile-native` favorecen **espacio proporcional al contexto, tipografía escalable, gestos directos y adaptabilidad**; **no proporcionan un número obligatorio para un margen universal**.

**Decisión aprobada:** margen horizontal del área de muestras de MASTER de **32 px**, con el token existente `var(--lab-space-8)` en escritorio y móvil. No convertirlo en margen universal de toda BeatGaler. La vista **Reglas → Márgenes** muestra únicamente el espacio aplicado en el taller; no hay editor ni nuevo sistema de tokens.

La Playbar conserva el alto **68 px** al reducirse horizontalmente (el reproductor original reducía a 62 px en tamaños estrechos). En el Lab, la portada pasa a 36 px cuando hay poco ancho (y vuelve a 48 px al ampliarse) y la barra de reproducción se mueve, con transición breve, desde debajo del nombre a una fila horizontal inferior que comienza debajo de la portada. Se calcula con el **ancho real disponible** y no con la ventana completa, para responder al cambio de tamaño de la navegación. En anchos extremadamente reducidos se ocultan solo acciones secundarias para conservar play/anterior/siguiente, portada, volumen y seek. Estas decisiones afectan solo la versión de MASTER, no producción.

## Componentes y subcomponentes

- **Implementado: Playbar.** El código visual en `DESIGN/MASTER/Player.tsx` proviene del reproductor publicado y conserva sus 14 iconos originales, slider vertical, barra de progreso y controles. MASTER solo sustituye las dependencias de producción con datos ficticios.
- **Botones de Playbar:** se mantienen **dentro del componente** mientras se revisa el conjunto. Cuando el propietario quiera perfeccionar un control individual, se puede añadir el ejemplo *debajo* de la barra y agruparlo en la navegación bajo **Playbar → Controles**. Si un botón demuestra reutilización real fuera de Playbar, entonces se extrae a una categoría general **Botones**. Evitar duplicar prematuramente los iconos o la implementación.
- **Pendiente:** cualquier componente distinto de Playbar; no crear fichas vacías, placeholders ni bibliotecas ficticias.

## Autoridad y mantenimiento

- Primero: decisiones del propietario sobre cada componente.
- Segundo: código de producción **publicado** para geometría, iconos y comportamiento existente.
- Tercero: lo implementado y verificable en `DESIGN/`. Un documento no obliga a crear funcionalidades no autorizadas.
- Skills pertinentes en `.agents/skills/` antes de proponer cambios; transcripción completa `UI-COLLECTIVE-TRANSCRIPT-ORIGINAL.txt` como referencia metodológica.
- `DESIGN.md` es inventario actual; `ARCHITECTURE.md` explica archivos; este `MASTER.md` recoge **cómo debe funcionar el taller**, sin competir con componentes reales.
- Probar build, TypeScript, estados, navegación colapsada/redimensionada, responsive, foco y popovers. Si no se probó visualmente, decirlo.

**Frontera:** solo `DESIGN/` y su documentación. No tocar `src/`, Cloud, API, `main` ni producción sin autorización.

## Ubicación física

El laboratorio se ejecuta exclusivamente desde `DESIGN/`. Componentes y demo de MASTER en `DESIGN/MASTER/`; Landing en `DESIGN/LANDING/`; Gallery en `DESIGN/GALLERY/`; assets y componentes de muestra compartidos en `DESIGN/shared/`. **Este `MASTER.md` especifica la intención**: no constituye una segunda implementación. Instrucciones de ejecución en `DESIGN/README.md`.
