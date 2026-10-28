# BeatGaler Design System — Arquitectura operativa

**Estado:** [LAB], propuesta de arquitectura; no aprobada ni importada a producción. **Fuente de criterios:** [DESIGN.md](DESIGN.md) y [UI-COLLECTIVE-TRANSCRIPT-NOTES.md](UI-COLLECTIVE-TRANSCRIPT-NOTES.md).

## Qué convierte una guía visual en un design system

No basta una página MASTER de muestras ni una tabla de tamaños. El sistema necesita una **fuente de verdad versionada** para tokens, contratos de componentes, variantes, estados, composición, accesibilidad, documentación, pruebas y un proceso explícito de adopción.

## 1. Tokens con dependencias dirigidas (Brand → Alias → Mapped)

| Nivel | Contiene | Ejemplo propuesto [LAB] | No debe contener |
|---|---|---|---|
| Brand | valores puros / escalas / familias | `brand.neutral.900` → hex, `brand.scale.400` → 16px | `button`, `errorText`, `background` |
| Alias | intención semántica compartida | `alias.neutral.canvas` → brand, `alias.feedback.error` → brand | referencias directas a componentes |
| Mapped | uso visual concreto y estados | `mapped.button.primary.background.default` → alias | hex y números sin referencia salvo excepción justificada |

**Invariantes:** Brand solo literales; Alias solo referencias a Brand; Mapped solo Alias o tokens Mapped sin ciclos. Resolución determinista; no permitir referencias rotas. Mantener unidades (`px`, color, tiempo), descripción, origen y estado de aprobación. Los nombres son semánticos; no renombrar silenciosamente. No inventar escalas innecesarias: solo valores utilizados. A diferencia de un cambio de tema, una modificación de Brand puede afectar muchos componentes y exige evaluación de impacto.

**Escala geométrica inicial [LAB]:** `25=1, 50=2, 100=4, 200=8, 300=12, 400=16, 500=20, 600=24, 700=28, 800=32, 900=40, 1000=48, 1100=64` (px). Ejemplo del tutorial, **no reemplaza** todos los valores actuales. Cualquier desviación queda documentada.

**Temas:** primera versión usa tema dark, una marca, variantes responsivas explícitas. Brand/alias pueden admitir futuros modos sin duplicar todos los componentes.

## 2. Contrato obligatorio de componentes

Cada componente debe tener **un fichero de especificación** (o una sección equivalente versionada) que incluya:

1. Propósito y uso prohibido; composición y anatomía (slots, texto, iconos).
2. API de propiedades y valores predeterminados; variantes enumeradas y relaciones permitidas.
3. Medidas calculables a partir de tokens (alto, ancho intrínseco, padding, gap, iconografía, tipografía).
4. Estados default, hover, pressed, focused, disabled, loading, selected, error según aplique.
5. Interacción real en Design Lab (si es mock, describir simulaciones), semántica y teclado.
6. Reglas responsive / truncamiento / contenido largo, contraste, reduced motion.
7. Ejemplos de uso correcto/incorrecto y pruebas visuales/automatizadas.
8. Origen [EXISTENTE]/[LAB]/[PENDIENTE] y decisiones pendientes.

**Botones:** la ecuación de ancho = ancho medido del contenido + suma de iconos + separación entre slots + padding izquierdo + derecho + bordes. La altura se deriva de tipografía, line-height, padding vertical y objetivo táctil. No fijar `min-width` estético para simular densidad. El contrato existente de botones en DESIGN.md permanece vigente hasta migración explícita.

## 3. Estructura propuesta, incremental

```text
BLUEPRINT/DESIGN-SYSTEM/
  README.md
  DESIGN.md                         # dirección y reglas vigentes del laboratorio
  ARCHITECTURE.md                   # arquitectura y contrato de componentes
  UI-COLLECTIVE-TRANSCRIPT-NOTES.md # estudio de la transcripción
  REFERENCES.md                     # otras referencias
design-lab/
  tokens.css                        # implementación actual, conservar
  components.tsx                    # primitivos actuales, conservar
  GalleryPage.tsx / App.tsx         # pantallas demo, no componentes fundacionales
```

**Próximo paso de implementación [PENDIENTE]:** definir el esquema de tokens fuente (`brand/alias/mapped`) y un resolvedor/validador que emita CSS; migrar primero `LabButton` como componente de referencia; documentar inputs, tags y player después. No afirmar que la arquitectura escrita ya equivale a una librería completa.

## 4. Verificación y adopción

- Contratos y snapshots de tokens; detección de ciclos y referencias rotas.
- Pruebas de cada estado y variante con interacción real; accesibilidad WCAG/teclado/táctil y zoom 200%.
- Capturas en 320, 390, 768, 1024 y 1440px, temas relevantes, portadas Generated y Real.
- Registrar decisiones, cambios incompatibles y deprecaciones.
- Permitir solo lectura desde `src/` durante el estudio. No importar Design Lab a producto, no publicar ni alterar main hasta autorización.

## 5. Ejemplo de mapeo ilustrativo [LAB]

```
brand.neutral.950 = "#0c0c0c"      (laboratorio)
alias.surface.canvas -> brand.neutral.950
mapped.gallery.canvas -> alias.surface.canvas
mapped.button.primary.label -> alias.neutral.onPrimary
```

`#090909` del canvas actual de producto no se cambia. Los colores definidos en Design Lab todavía no son identidad aprobada.
