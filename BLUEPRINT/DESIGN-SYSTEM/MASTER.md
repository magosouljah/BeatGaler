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

**Decisión actual (solo el espacio del taller):** margen del área de componentes de `var(--lab-space-6)` en escritorio (24 px) y `var(--lab-space-4)` en móvil (16 px). Ambas medidas **ya existen** en `design-lab/tokens.css`. No publicar estos márgenes como regla oficial para toda BeatGaler sin una decisión posterior. La vista **Reglas → Márgenes** muestra únicamente el espacio aplicado en el taller; no hay editor ni nuevo sistema de tokens.

La Playbar conserva sus propias medidas de producción. Si una medida del taller la restringe, se revisa el contexto del ejemplo antes de cambiar la Playbar.

## Componentes y subcomponentes

- **Implementado: Playbar.** El código visual en `design-lab/playbar/Player.tsx` proviene del reproductor publicado y conserva sus 14 iconos originales, slider vertical, barra de progreso y controles. MASTER solo sustituye las dependencias de producción con datos ficticios.
- **Botones de Playbar:** se mantienen **dentro del componente** mientras se revisa el conjunto. Cuando el propietario quiera perfeccionar un control individual, se puede añadir el ejemplo *debajo* de la barra y agruparlo en la navegación bajo **Playbar → Controles**. Si un botón demuestra reutilización real fuera de Playbar, entonces se extrae a una categoría general **Botones**. Evitar duplicar prematuramente los iconos o la implementación.
- **Pendiente:** cualquier componente distinto de Playbar; no crear fichas vacías, placeholders ni bibliotecas ficticias.

## Autoridad y mantenimiento

- Primero: decisiones del propietario sobre cada componente.
- Segundo: código de producción **publicado** para geometría, iconos y comportamiento existente.
- Tercero: lo implementado y verificable en `design-lab/`. Un documento no obliga a crear funcionalidades no autorizadas.
- Skills pertinentes en `.agents/skills/` antes de proponer cambios; transcripción completa `UI-COLLECTIVE-TRANSCRIPT-ORIGINAL.txt` como referencia metodológica.
- `DESIGN.md` es inventario actual; `ARCHITECTURE.md` explica archivos; este `MASTER.md` recoge **cómo debe funcionar el taller**, sin competir con componentes reales.
- Probar build, TypeScript, estados, navegación colapsada/redimensionada, responsive, foco y popovers. Si no se probó visualmente, decirlo.

**Frontera:** solo `design-lab/` y su documentación. No tocar `src/`, Cloud, API, `main` ni producción sin autorización.
