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

La Playbar conserva el alto **68 px** en ambos tamaños. La portada mantiene una caja estable de 48 px: al comprimir el Lab, su imagen se transforma a 36 px y sube 4 px **en una única animación de transform, sin saltos de layout**. El texto del nombre y los metadatos sube 4 px para dejar al menos 10 px de aire antes del scrubber; además, **el texto se desplaza 6 px a la izquierda al compactar** y vuelve al ampliar, con exactamente el mismo `--lab-normal` (180 ms) y `--lab-ease` que la portada. Así los **12 px de separación visible portada–texto permanecen constantes durante toda la transición**, no solo al terminar. La barra de reproducción, siempre en el mismo plano inferior, se extiende desde el texto hasta el borde visual izquierdo de la portada al cruzar el modo compacto; ese único cambio se anima con FLIP (transform, 180 ms) y admite reversión. Entre cambios de modo, la barra sigue el ancho real disponible por CSS, sin animar left/width ni esperar medidas del ResizeObserver. La referencia es el **canvas disponible**, no el ancho global de la ventana. Se respeta `prefers-reduced-motion`, y en anchos extremos se ocultan controles secundarios para preservar transporte, portada, volumen y seek. Estas decisiones afectan solo la versión de MASTER, no producción.

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
