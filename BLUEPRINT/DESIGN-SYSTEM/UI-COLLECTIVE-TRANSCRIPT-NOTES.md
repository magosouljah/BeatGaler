# Notas de referencia — transcripción de UI Collective

**Fuente:** transcripción completa proporcionada por el propietario (28-10-2026), archivo original `Texto pegado(20261028-172408).txt` en la conversación. Estas son notas de estudio, no un respaldo literal de las ~208 KB del archivo. No se adjudica al autor ninguna regla que no aparezca en el contenido.

## 1. Enfoque del tutorial
El tutorial construye un **sistema de diseño inicial** en Figma, con variables, colecciones y un conjunto de componentes con variantes. Su alcance declarado es el *framework* de los componentes, no una biblioteca de máxima sofisticación. Habla también de organización y publicación de librerías.

## 2. Tres niveles de tokens (modelo elegido en la fuente)
1. **Brand:** valores primitivos, sin rol de interfaz. Escalas cromáticas (ej. red/100), familia y pesos tipográficos, escala numérica. La numeración 50/100/150/200 permite insertar valores intermedios sin renombrar toda la escala.
2. **Alias:** rol general de marca/semántica. Ejemplos: primary, neutral, error, warning, success e information; también bordes y radios. Se resuelven a Brand, no son los valores finales de un botón.
3. **Mapped / Maps:** tokens aplicados al uso concreto de los elementos: superficie de acción, texto sobre acción, estados y estilos de componente. La capa final se resuelve a Alias.

El tutorial contrasta explícitamente esta arquitectura con la alternativa **dos niveles** (Primitive + Semantic); no dice que dos niveles sean incorrectos. La elección de tres favorece los escenarios multibrand. Para BeatGaler, se propone como estructura de trabajo **[LAB]**, sujeta a validación de utilidad.

## 3. Escalas y numeración
- La fuente recomienda evitar cientos de escalas innecesarias. Comenzar por roles utilizados y crecer según necesidad.
- Para medidas propone una escala base de 4 px: 100=4, 200=8, 300=12, 400=16, 500=20, 600=24, 700=28, 800=32; 25=1 y 50=2 para bordes/foco; luego saltos 900=40, 1000=48, 1100=64.
- El tutorial usa nombres como sm/md/lg cuando la dimensión tiene pocas opciones (por ejemplo, border width).
- Especifica familias y pesos de fuente como valores, posteriormente enlazados a estilos y usos.

## 4. Componentes
- Empezar por la anatomía y el auto-layout: componentes con contenido real editable, padding variable, huecos y tamaños coherentes.
- Crear variantes para tamaño, estilo y estado donde corresponda, evitando duplicar cada aspecto sin razón.
- Vincular estados visuales (default, hover, etc.) a roles mapeados para evitar aplicar colores directamente.
- Componer componentes complejos a partir de piezas menores. La fuente construye patrones como botones, controles, formularios y tablas; no implica que BeatGaler ya los tenga.

## 5. Múltiples marcas y publicación
- Diferencia **branded house** (familia de marcas con gran parte de los tokens compartidos) y **house of brands** (identidades distintas), destacando la importancia de resolver roles sin reescribir componentes.
- Señala prácticas de organización de componentes y publicación de librerías en Figma. Esto no publica automáticamente nada en BeatGaler.

## 6. Adaptación a BeatGaler (propuesta nuestra, no afirmación del video)
- Seguir con una identidad y un solo tema oscuro, preservando `#0c0c0c` del laboratorio y el `#090909` actual de producto hasta aprobación.
- Introducir Brand → Alias → Mapped **sin reescribir `src/`** y sin exigir Figma para que exista un contrato verificable.
- Mantener datos de demostración, portadas locales y selección Generated/Real en Design Lab.
- Versionar tokens y contratos de componentes; pruebas de referencias válidas, dimensiones, semántica, accesibilidad, visual y responsive antes de migrar.
- Distinguir claramente [EXISTENTE], [LAB] y [PENDIENTE].

**Límite:** estas notas sintetizan las ideas técnicas; el video no determina qué componentes, colores o estructura específicos debe adoptar BeatGaler.
