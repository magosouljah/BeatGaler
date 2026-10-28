# Design System — BeatGaler

> Guía viva de identidad y experiencia, no cronograma ni plan de ejecución. Estado: **dirección inicial de diseño**, sujeta a prototipos y aprobación visual.

## Identidad acordada

**Una sola marca, dos intensidades:**

- **Aplicación / Galería:** elegante, tranquila, rápida, precisa y predecible. Aprender de la claridad y el oficio de interfaces Apple, sin copiar la identidad de Apple.
- **Landing:** artística, inmersiva y más atrevida; portadas y música como protagonistas, movimiento espacial deliberado. Compartir tipografía, colores, componentes y tono con la aplicación.
- **Principio:** las portadas proporcionan la personalidad; la interfaz no compite con ellas.

## Alcance de la exploración actual

Solo **dos pantallas ficticias**: (1) Landing pública y (2) Galería / biblioteca. Usar datos y carátulas demostrativas autorizadas. Los prototipos no deben necesitar login, Telegram, MASTER, INDEX, Cloud, PostgreSQL, billing ni servicios reales. Un botón del prototipo puede cambiar de estado o navegar entre mocks, pero nunca ejecutar una acción real: debe ser evidente que es un demo.

La exploración debe correr **aislada de la aplicación y de producción**. No sustituir el frontend productivo, no editar un flujo real por conveniencia y no publicar en beatgaler.com sin decisión separada.

## Documentos

- [DESIGN.md](DESIGN.md) — lenguaje visual, reglas iniciales, interacción, accesibilidad y límites de los mocks.
- [REFERENCES.md](REFERENCES.md) — análisis consultados, procedencia, licencias y selección razonada.

## Método de trabajo

1. Consultar este directorio y el código real antes de decidir un cambio de diseño.
2. Crear variantes **interactivas** de un componente o pantalla, compararlas en escritorio y móvil y dejar que el propietario elija.
3. Convertir solo lo aprobado en tokens y componentes reutilizables; documentar desviaciones intencionales.
4. Validar con contenido largo, biblioteca vacía, carga, errores, teclado, tacto, contraste y movimiento reducido antes de llevarlo al producto.

**Una sola fuente de verdad por etapa:** mientras experimentamos, este DESIGN.md expresa la dirección propuesta; los estilos y componentes que ya usa la aplicación son la realidad de `main`. Después de aprobar una decisión, sincronizar la documentación con su implementación efectiva, sin proclamar aplicado lo que solo existe en un mock.

El objetivo es que BeatGaler se sienta coherente, simple y distinguible; no coleccionar guías externas ni mantener cientos de tareas.
