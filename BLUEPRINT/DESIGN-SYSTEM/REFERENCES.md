# Referencias y procedencia — Design System

Revisión inicial de los **repositorios completos** y selección de documentos especialmente útiles para las dos primeras pantallas. Son **fuentes de estudio**, no archivos para copiar dentro del producto ni reglas obligatorias.

## Colección de sistemas `DESIGN.md`

**Repositorio:** [VoltAgent / awesome-design-md](https://github.com/VoltAgent/awesome-design-md) · [README](https://github.com/VoltAgent/awesome-design-md/blob/main/README.md) · [Licencia MIT](https://github.com/VoltAgent/awesome-design-md/blob/main/LICENSE).

Colección amplia de análisis `DESIGN.md` de marcas y productos, organizada por áreas. Sirve para aprender la estructura de una especificación de diseño: tema y atmósfera, roles de color, tipografía, componentes, espaciados, profundidad, responsividad y antipatrones. Estos archivos son reconstrucciones/análisis, **no** guías oficiales de las marcas.

Especialmente relevantes:

- [Coinbase](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/coinbase/DESIGN.md): referencia principal de **profundidad y estructura de especificación** (tokens YAML, tabla de componentes, estado, comportamiento y reglas). Es un análisis de terceros, no un sistema oficial ni fuente de identidad para BeatGaler.

- [Apple](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/apple/DESIGN.md): aire, jerarquía, discreción de la UI y fotografía protagonista.
- [Spotify](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/spotify/DESIGN.md): fondos oscuros, carátulas como fuente de color y lectura musical.
- [Linear](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md): superficies contenidas, bordes finos, densidad medida.
- [Runway](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/runwayml/DESIGN.md): dirección artística cinematográfica y protagonismo visual.
- [Framer](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/framer/DESIGN.md): landing dinámica y uso selectivo de profundidad.
- [Figma](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/figma/DESIGN.md): lenguaje de herramientas visuales y estructura de UI.

No mezclaremos los tokens cromáticos y fuentes de esas marcas: crearíamos una aplicación inconsistente.

## Ingeniería de diseño y animaciones

**Repositorio:** [emilkowalski / skills](https://github.com/emilkowalski/skills) · [README](https://github.com/emilkowalski/skills/blob/main/README.md) · [Licencia MIT](https://github.com/emilkowalski/skills/blob/main/LICENSE).

No se limita a `apple-design`: hay habilidades de diseño, construcción de animaciones, revisión, rendimiento, prototipos y prueba de casos límite. Selección:

- [apple-design/SKILL.md](https://github.com/emilkowalski/skills/blob/main/skills/apple-design/SKILL.md): respuesta inmediata, direct manipulation, momentum, springs interrumpibles, jerarquía espacial, tipografía y movimiento reducido.
- [animate/SKILL.md](https://github.com/emilkowalski/skills/blob/main/skills/animate/SKILL.md): decidir si animar, propósito, timing, easing y salida.
- [animation-performance/SKILL.md](https://github.com/emilkowalski/skills/blob/main/skills/animation-performance/SKILL.md): costes layout/paint/composite, evitar trabajo por frame y medir.
- [review-animations/STANDARDS.md](https://github.com/emilkowalski/skills/blob/main/skills/review-animations/STANDARDS.md): estándares para revisar coherencia y fluidez.
- [prototype/SKILL.md](https://github.com/emilkowalski/skills/blob/main/skills/prototype/SKILL.md): comparar variantes genuinamente diferentes en un selector y aprobar una.
- [break-ui/SKILL.md](https://github.com/emilkowalski/skills/blob/main/skills/break-ui/SKILL.md): estrés con datos reales extremos y vacío.

La habilidad `apple-design` es una **interpretación para web** basada en charlas de diseño de Apple; no debe confundirse con una especificación oficial de Apple ni copiarse como instrucciones para agentes sin revisar su idoneidad.

Referencia oficial complementaria: [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/).

## Estado real de BeatGaler

- [Fundamentos CSS](../../src/styles/design-foundations.css): tokens y componentes de estilo **existentes**, punto de partida real.
- [Composición de biblioteca](../../src/styles/library-ux.css): cabecera, rejilla, filtros, responsive.
- [Primitivas de UI](../../src/components/ui/DesignPrimitives.tsx): componentes actuales que hay que revisar antes de duplicar.
- [Shell de aplicación](../../src/app/AppShell.tsx): estructura real de la galería, **no** destino del prototipo aislado.

## Uso, licencia y límites

Los dos repositorios citados declaran licencia **MIT**. Si más adelante se reutilizara código o texto sustancial de un archivo MIT, conservar avisos de copyright y licencia requeridos. En esta carpeta **solo hay síntesis y propuestas originales**, no una copia masiva de los repositorios.

La licencia MIT de estas recopilaciones **no** autoriza por sí sola a distribuir fuentes comerciales, fotografías, portadas, iconos de terceros ni a copiar marcas registradas. Para mocks, usar portadas propias, demo o assets con licencias comprobadas. Registrar la procedencia de cualquier asset reutilizado.

**Criterio:** consultar el material original cuando sea necesario; mantener este BLUEPRINT ligero y específico para BeatGaler.
