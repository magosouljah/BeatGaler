# BeatGaler — Design System incremental

**Dirección aprobada:** MASTER será una página sencilla, casi Markdown. No implementar un dashboard de diseño, inspector, catálogo de decenas de componentes, editor global ni simuladores Fluid/Tablet/Phone. No diseñar componentes futuros por adelantado.

## Fuente de verdad

1. **Decisión del propietario:** define el siguiente componente a incorporar y su apariencia; se trabaja **uno por uno**.
2. **Código de producción:** `src/` y el commit publicado son la fuente del componente original que se quiere replicar. No copiar solo su apariencia aproximada si se puede utilizar el código y sus assets reales.
3. **Implementación en `design-lab/`:** es la fuente de lo que efectivamente existe en la demo; la documentación describe el código y no crea obligaciones imaginarias.
4. **Skills de `.agents/skills/`:** leer las relevantes antes de cambiar diseño, interacción, movimiento o responsividad. Orientan la calidad, sin imponer una arquitectura visual no autorizada.
5. **[UI Collective — transcripción original](UI-COLLECTIVE-TRANSCRIPT-ORIGINAL.txt):** referencia metodológica sobre variables, colecciones, escalas, componentes, estados y variantes. Se consulta, sin implementar su estructura completa antes de necesitarla.
6. `DESIGN.md` documenta lo existente; `ARCHITECTURE.md` explica la implementación; `REFERENCES.md` contiene referencias visuales; las notas del transcript son un resumen no normativo.

## Estado actual

**MASTER:** documentación simple con un único componente en revisión: **Playbar**. El componente vive en `design-lab/playbar/Player.tsx`, basado en `src/components/Player.tsx` de producción `release/0.9.0-beta.2`, con sus iconos PNG originales y barra vertical de volumen. El adaptador ficticio usa portadas locales y botones que modifican estado de prueba, no audio.

**Landing y Gallery:** permanecen como prototipos independientes, con la órbita de portadas y la galería ficticia anteriores. El reproductor viejo de Gallery sigue siendo una simulación distinta; **la Playbar de MASTER** es la que estamos revisando con código real.

**[PENDIENTE]:** aprobación visual y de comportamiento de la Playbar, revisión manual en móvil/teclado y futuros componentes solicitados expresamente. No asumir que lo no añadido está aprobado o diseñado.

## Regla para el siguiente cambio

Primero estudiar el componente real, luego traerlo al laboratorio sin dependencias de cuentas, API o Cloud, probar sus estados reales y documentar solo lo verificado. Crear nuevas categorías o controles únicamente cuando el trabajo concreto los necesite.

**Seguridad:** laboratorio local, sin llamadas de red, cuentas, datos privados ni audio. No modificar `src/`, `main` ni producción. No publicar carátulas de terceros sin revisar derechos.
