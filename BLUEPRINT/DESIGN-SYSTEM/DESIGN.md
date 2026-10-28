---
name: BeatGaler Design System
version: "0.1-lab"
status: "experimental — NOT approved for production"
last_reviewed: "2026-10-28"
scope: "Web: Design Lab only"
sources:
  current: "src/styles/design-foundations.css, src/styles/library-ux.css, src/components/ui/DesignPrimitives.tsx"
  runnable_tokens: "design-lab/tokens.css"
  runnable_components: "design-lab/components.tsx"
---

# BeatGaler — DESIGN.md

> **Contrato de diseño para exploración, no declaración de que el producto ya se rediseñó.** La aplicación y la landing son una misma marca con dos niveles de expresión. Aplicación: precisión, calma y utilidad. Landing: composición editorial, artística y cinematográfica. Las carátulas son las protagonistas; la interfaz les da contexto.

## 0. Cómo leer y aplicar este documento

**Leyenda de procedencia (obligatoria):**

- **[EXISTENTE]** Verificado en `main`, especialmente `src/styles/design-foundations.css`. Contrato del producto actual; no modificarlo por implicación.
- **[LAB]** Valor ejecutable en `design-lab/tokens.css` o regla de un componente ficticio. Es una **propuesta concreta para evaluar**, no está aprobada para producción.
- **[PENDIENTE]** Requiere comparación visual, accesibilidad y aprobación antes de adoptar en el producto.
- **[PRINCIPIO]** Restricción de diseño transversal, sin afirmar que todas las pantallas actuales la cumplan.

**Precedencia:** para describir el producto real, manda el código de `main`; para el laboratorio, manda `design-lab/tokens.css`; para futuras propuestas, este documento prescribe roles y criterios. Si los valores divergen, NO declarar paridad ni sustituir `src/` en silencio. Antes de migrar: inventariar diffs → obtener aprobación → migrar por componente → validar visual/funcional/accesibilidad.

**Referencias estudiadas:** el análisis no oficial [Coinbase DESIGN.md](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/coinbase/DESIGN.md) inspira el **nivel de especificación**, no su identidad. Apple aporta reducción de chrome y claridad. Las skills MIT de Emil Kowalski aportan respuesta física, interruptibilidad y economía de movimiento. Ver [REFERENCES.md](REFERENCES.md). No usar marcas, fuentes, fotos ni ilustraciones propietarias.

## 1. Principios visuales

1. **Contenido antes que interfaz:** artwork, nombre, autor/etiquetas y reproducción legibles en ese orden.
2. **Dos intensidades, un sistema:** landing permite escala, profundidad y narrativa; galería minimiza fricción y movimiento.
3. **Oscuridad construida, no negro plano:** cinco planos neutros, bordes sutiles, elevación reservada.
4. **Tipografía ópticamente ordenada:** titulares grandes solo donde aportan ritmo; datos densos con alineación constante.
5. **Acción reconocible sin saturación de color:** botón principal neutro de alto contraste. El acento cromático aún no es marca aprobada.
6. **Respuesta inmediata:** estados desde el contacto; nada de animar por animar.
7. **Una sola escala:** componentes y excepciones documentados. No adivinar nuevos hex/radios.
8. **Falsos significa desconectados:** prototipos sin datos reales, red, API, sesión ni audio.

## 2. Color: paleta, niveles y roles

### 2.1 Neutros — equivalencias actuales exactas

| Rol semántico | Token actual [EXISTENTE] | HEX | Token de laboratorio [LAB] |
|---|---|---|---|
| Fondo base | `--bg-canvas` | `#090909` | `--lab-canvas` |
| Superficie 1 | `--bg-surface` | `#101010` | `--lab-surface` |
| Superficie 2 / panel | `--bg-raised` | `#151515` | `--lab-raised` |
| Hover / overlay opaco | `--bg-hover` | `#1c1c1c` | `--lab-hover` |
| Pressed | `--bg-pressed` | `#222222` | `--lab-pressed` |
| Texto primario | `--text-primary` | `#f2f2f2` | `--lab-ink` |
| Texto secundario | `--text-secondary` | `#b0b0b0` | `--lab-secondary` |
| Texto atenuado | `--text-muted` | `#8b8b8b` | `--lab-muted` |
| Texto inhabilitado | `--text-disabled` | `#666666` | `--lab-disabled` |
| Borde sutil | `--border-subtle` | `#242424` | `--lab-hairline` |
| Borde estándar | `--border-default` | `#343434` | `--lab-border` |
| Borde destacado | `--border-strong` | `#4a4a4a` | `--lab-border-strong` |
| Foco visible | `--focus-ring` | `#f2f2f2` | `--lab-focus` |

**[LAB — excepción explícita de canvas en landing]** `design-lab/tokens.css` usa `--lab-canvas: #0c0c0c`, igual a `BACKGROUND_HEX` de `src/lib/proceduralBeatBackground.ts` (generador original bg-v1), para evitar uniones visibles entre portadas y fondo. El canvas vigente de la aplicación real sigue siendo `#090909` [EXISTENTE]. El laboratorio no modifica producción. Portadas demo creadas mediante una copia exacta del generador dentro de `design-lab/` para conservar aislamiento; un test comprueba paridad con el original.

**[EXISTENTE]** `--bg-scrim: rgba(0,0,0,.72)`; `--text-inverse: #101010`. Usar scrim para modales, no como superficie ordinaria. No emplear `--text-disabled` para información importante: puede tener contraste insuficiente.

### 2.2 Acción, feedback y color expresivo

| Uso | Valor exacto | Estado / regla |
|---|---|---|
| CTA primario fondo | `#ececec` | [EXISTENTE] `.bg-button--primary` |
| CTA primario hover | `#ffffff` | [EXISTENTE] |
| Texto sobre CTA | `#101010` | [EXISTENTE] `--text-inverse` |
| Texto sobre estado oscuro | `#f2f2f2` | [EXISTENTE] |
| Error fondo / borde / texto | `#2a1111` / `#6d3030` / `#ffb4b4` | [EXISTENTE] |
| Éxito fondo / borde / texto | `#10261a` / `#2d6844` / `#a8e6bd` | [EXISTENTE] |
| Info fondo / borde / texto | `#121d2b` / `#304b6d` / `#b9d6ff` | [EXISTENTE] |
| Acento artístico opcional | `#c8b7ff` | [LAB] **solo experimento**, nunca indicar que es identidad aprobada |

**[PRINCIPIO]** Los colores de alertas describen el estado, nunca categorías musicales. El color de cada carátula puede ser vibrante, pero no se convierte automáticamente en color de CTA, foco o navegación. Acciones críticas siempre requieren texto/forma, no solo color. Probar relaciones WCAG AA antes de aprobar cambios del panel de tokens.

### 2.3 Superficies y combinaciones permitidas

- App `canvas → surface → raised`; el hover se aplica a elementos interactivos, no a secciones enteras.
- Landing utiliza la misma escala y puede superponer artwork/CSS decorativo, pero sin reemplazar la legibilidad del texto.
- Cards: texto primario `ink`, metadatos `secondary`, divisores `hairline`.
- **[LAB]** no se incorpora un tema claro todavía. No mezclar superficies de marca de Coinbase, Apple o Spotify.

## 3. Tipografía: familias, jerarquía y precisión

**[EXISTENTE]** Stack del sistema: `"SF Pro Text", "Segoe UI", "Helvetica Neue", system-ui, sans-serif`; no descargamos ni distribuimos SF Pro. **[LAB]** el mismo stack en toda la interfaz, sin librerías ni fuentes remotas. Titulares usan esta misma familia por ahora. Tracking en `em` es relativo al tamaño indicado. Tablas y BPM usan `font-variant-numeric: tabular-nums`, sin importar una fuente comercial.

| Token [LAB] | Tamaño / line-height | Peso | Letter-spacing | Uso |
|---|---|---|---|---|
| `type.hero` | 72px / 1.02 | 600 | -0.055em | H1 landing ≥1280px |
| `type.display` | 56px / 1.05 | 600 | -0.048em | H1 landing 960–1279px |
| `type.h1` | 40px / 1.10 | 600 | -0.040em | H1 responsive / secciones hero |
| `type.h2` | 32px / 1.14 | 600 | -0.035em | Título sección |
| `type.h3` | 24px / 1.20 | 600 | -0.028em | Encabezados de módulos |
| `type.title` | 20px / 1.25 | 600 | -0.020em | Cabeceras de panel |
| `type.body-lg` | 16px / 1.50 | 400 | -0.008em | Texto de introducción |
| `type.body` | 14px / 1.50 | 400 | 0 | Texto funcional |
| `type.label` | 13px / 1.35 | 600 | 0 | Controles / tarjetas |
| `type.caption` | 12px / 1.40 | 400 | 0.005em | Metadatos / badges |
| `type.micro` | 11px / 1.35 | 500 | 0.015em | Únicamente adorno no esencial |
| `type.numeric` | 13px / 1.30 | 500 | 0 | Duración / BPM / conteos |

**[EXISTENTE]** El producto utiliza `--font-xs:11px`, `--font-sm:12px`, `--font-md:13px`, `--font-lg:16px`, `--font-xl:22px`, `--line-normal:1.5`. **[LAB]** el cuerpo de 14px, títulos mayores y display son propuestas, NO migración realizada. En texto informativo de lectura prolongada usar 16px, no caption. Máximo 2 pesos (400/600) por bloque; 3 solo si hay razón semántica. Texto no truncado en vistas de detalle y controles accesibles. Titulares landing: máximo 10–12 palabras, no más de dos líneas en desktop; en 320px permitir más líneas sin overflow.

## 4. Escala geométrica: espaciado, rejilla y contenedores

### 4.1 Escala de espaciado

**[EXISTENTE]** `--space-1…8`: `4, 8, 12, 16, 20, 24, 28, 32px`. **[LAB]** `--lab-space-1…8` refleja exactamente esos valores. Extensiones experimentales: `--lab-space-10:40px`, `--lab-space-12:48px`, `--lab-space-16:64px`, `--lab-space-24:96px`. Espacios fuera de escala están prohibidos salvo offsets ópticos documentados (±2px máximo).

### 4.2 Contenedores y grids [LAB]

| Elemento | Desktop (≥1280) | Tablet (640–1279) | Mobile (<640) |
|---|---|---|---|
| Ancho lectura / landing | max 1200px | calc(100%-64px) | calc(100%-40px) |
| Zona de controles app | max 1440px | 24px gutter | 16px gutter |
| Rejilla editorial | 12 columnas, gap 24px | 6 columnas, gap 20px | 4 columnas, gap 12px |
| Gallery artwork | minmax(176px, 1fr) | minmax(160px, 1fr) | minmax(136px, 1fr) |
| Cards por fila | responsive auto-fit, sin valor fijo | responsive auto-fit | 2 si caben; 1 si zoom rompe |
| Separación entre cards | 20px | 16px | 12px |
| Padding de cards | 20px | 16px | 12px |
| Separación de secciones landing | 96px | 64px | 48px |
| Separación módulos gallery | 32px | 24px | 20px |

**[EXISTENTE]** `src/styles/library-ux.css` define header de `min-height:58px`, `padding:7px 24px`, controles compactos de `36px` y ancho de búsqueda hasta `260px`. Las cifras de tabla arriba son **prototipo**, no descripción del shell productivo. No alterar el flujo ni el ancho de cards existentes sin probar truncamiento, zoom y selección múltiple.

### 4.3 Alineación

- Pasos horizontales sobre el mismo borde de contenedor; iconos al centro geométrico, texto alineado por baseline.
- Portada cuadrada `aspect-ratio:1/1`; `object-fit:cover` solo para medios propios/licenciados. Texto visible para carátulas sin imagen.
- Caption a 8px del título, metadata secundaria 4px del título; controles de acción a 12px mínimo de contenidos vecinos.
- El scroll de la biblioteca es vertical y natural. Nada de overflow horizontal accidental en 320px o 200% zoom.

## 5. Forma, bordes, sombras y profundidad

| Token | Valor exacto | Estado |
|---|---|---|
| `radius.sm` | 8px | [EXISTENTE] `--radius-sm` |
| `radius.md` | 12px | [EXISTENTE] `--radius-md` |
| `radius.lg` | 16px | [EXISTENTE] `--radius-lg` |
| `radius.pill` | 999px | [EXISTENTE] `--radius-pill` |
| `radius.artwork` | 12px | [LAB] propuesta |
| `radius.panel` | 16px | [LAB] reutiliza lg |
| `border.hairline` | 1px `#242424` | [EXISTENTE] valor |
| `border.default` | 1px `#343434` | [EXISTENTE] valor |
| `focus.outer` | 2px solid `#f2f2f2`, offset 2px | [EXISTENTE] |
| `shadow.card` | `0 24px 80px rgba(0,0,0,.55)` | [EXISTENTE] |
| `shadow.dialog` | `0 28px 96px rgba(0,0,0,.7)` | [EXISTENTE] |

**Profundidad en cuatro niveles [LAB]:** L0 canvas (sin borde); L1 surface (hairline opcional); L2 raised (hairline); L3 popover (shadow.card); L4 diálogo (scrim + shadow.dialog). Landing puede utilizar superposición de artworks ficticios como narrativa, no sombras enormes por cada control. No emplear `backdrop-filter` en listas grandes: coste y legibilidad. No inventar otros niveles de sombra sin documentar usos concretos.

## 6. Componentes: anatomía, medidas, estados, accesibilidad

Las reglas siguientes son **[LAB]** salvo valores marcados [EXISTENTE]. Los componentes ejecutables viven en `design-lab/components.tsx`. Especificar estados `default`, `hover`, `active`, `focus-visible`, `disabled`, `loading` y `error` cuando corresponda. Sin navegación auténtica ni funciones reales en mocks.

### 6.1 Botones

| Variante | Alto / padding | Superficie / texto / borde | Uso |
|---|---|---|---|
| Primary | 44px; 12px 16px | `#ececec` / `#101010` / `#ececec` | Acción principal, máximo 1 por zona |
| Secondary | 44px; 12px 16px | `#151515` / `#f2f2f2` / `#343434` | Siguiente mejor acción |
| Ghost | 44px; 10px 12px | transparent / `#b0b0b0` / transparent | Acciones auxiliares |
| Destructive | 44px; 12px 16px | `#2a1111` / `#ffb4b4` / `#6d3030` | Confirmación de acción destructiva |
| Icon | 44×44px; centrado | Igual a secondary/ghost | Requiere `aria-label` |
| Compact visual | 36px visual | solo si zona de interacción efectiva ≥44px | Densidad en barra de herramientas |
| Hero CTA | 52px; 16px 24px | igual a Primary; `radius.pill` [LAB] | Solo landing |

**Estados [LAB]:** hover primary `#ffffff`; secondary `#1c1c1c`; ghost `#1c1c1c`; pressed usa `#222222` para oscuros / `scale(.985)` de 120ms para todos; focus-visible anillo exterior de 2px sin esconderlo; disabled `opacity:.5`, no hover ni clic; loading spinner local y botón disabled, conserva ancho/texto y `aria-busy`. Error jamás sustituye el label por color. **[EXISTENTE]** botón actual 44px, radios 8px, 13px/650, variantes primary/secondary/ghost/danger. El hero pill 52px y peso 600 son experimentos; no reescribir variantes productivas.

### 6.2 Campos, búsqueda, selects y validación

| Elemento | Alto | Estilo / estados |
|---|---|---|
| Text input | 44px | raised, borde default 1px, radio 8px, padding 0 14px |
| Search | 44px | mismo input, icono búsqueda decorativo, label accesible |
| Select / sort | 44px | mismo rectángulo, opciones nativas mientras no se justifique un menú custom |
| Textarea | min 96px | mismos colores, resize vertical |
| Checkbox | 18px visual + hit-area 44px | checked visible, label asociado |
| Filter chip | 36px visual, hit-area ≥44px | pill; `aria-pressed`; estado seleccionado ink sobre pressed |

**Focus** siempre 2px `focus` + offset 2px; `aria-invalid` y mensaje próximo en error; ayuda y error asociados por `aria-describedby`; placeholder nunca sustituye label. Disabled describe por qué cuando sea necesario, con texto auxiliar. Buscar en el mock filtra exclusivamente el arreglo local, sin fetch.

### 6.3 Navegación y estructura

- **App header [EXISTENTE]:** `min-height:58px`; **Lab header [LAB]:** 64px, alineación vertical, logotipo tipográfico ficticio y controles a la derecha.
- **Landing nav [LAB]:** 72px desktop, 64px móvil; marca, enlace ficticio de exploración y CTA. Sin simular un login auténtico.
- **Secciones:** etiquetas pequeñas sobrias, títulos en jerarquía, evitar separadores si la estructura ya es clara.
- **Tab navigation del laboratorio:** `Components / Landing / Gallery`, `aria-current` o estado seleccionado legible; no usar rutas del producto real.
- **Popover/menu:** raised, border.default, radius.md, padding 8px, shadow.card; cerrar con Escape y clic exterior; foco retorna al disparador. Para el primer laboratorio usar select nativo. Evitar menú no accesible.

### 6.4 Cards, artwork, tags y listas

- **Artwork [LAB]:** 1:1; radius 12px; superficie de fallback con color procedural **ficticio**, nunca descarga de assets; overlay de controles solo en hover/focus, pero siempre existe acción alternativa por teclado/táctil.
- **Beat tile [LAB]:** portada + título (14/600), metadata (12/400), BPM/keys tabulares; 12px de separación portada/texto, 4px título/meta. truncar solo en rejilla, mostrar completo en detalle. No hacer card entera un botón si contiene otros botones anidados.
- **Tag chip:** padding horizontal 12px, min-height 32px, radius.pill, surface raised, border hairline, 12/500; filtros interactivos con hit-area 44px.
- **Panel/card:** surface, radio 16px, borde 1px hairline, padding 20px. Hover altera borde o background, no levanta todas las cards.
- **Estados gallery:** loaded, empty, filtered-empty, loading, error, selected; diseñar componentes específicos antes de adoptarlos. En el laboratorio inicial solo se construye filled + filtered-empty.
- **List rows:** min-height 52px, padding horizontal 12px, divisor 1px hairline; icono a la izquierda, texto, métrica tabular a la derecha.

### 6.5 Player — solo simulación [LAB]

| Elemento | Medida | Comportamiento |
|---|---|---|
| Dock | min-height 80px; padding 12px 20px | sticky al borde inferior de gallery; no cubre contenido |
| Mini artwork | 48×48px; radius 8px | conserva 1:1 |
| Play / pause | 44×44px; icono + label accesible | toggle de estado local **sin audio** |
| Título + autor | 14px/600 + 12px/400 | elipsis con acceso al nombre completo |
| Progreso visual | alto 3px, `#b0b0b0` | decorativo en v0.1, sin `input type=range` engañoso |
| Tiempo | 12px, tabular | números falsos fijos, sin clocks |

**[PRINCIPIO]** Un reproductor real necesita semántica de seek, buffer, error, volumen, cola y persistencia; NO se deduce que el mock implemente audio. No importar `src/components/Player.tsx`, ni pedir red, ni fingir descarga.

## 7. Movimiento, respuesta y física

| Token | Valor exacto | Origen |
|---|---|---|
| `motion.fast` | 120ms | [EXISTENTE] `--motion-fast` |
| `motion.normal` | 180ms | [EXISTENTE] `--motion-normal` |
| `motion.slow` | 260ms | [LAB] propuesta, solo transiciones ocasionales |
| `ease.standard` | `cubic-bezier(0.2,0.7,0.2,1)` | [EXISTENTE] |
| `spring.sheet` | stiffness 320, damping 34, mass 1 | [PENDIENTE] sugerencia si surge gesto real; **no implementada** |
| `orbit.ambient` | ciclo ≥32s, transform/opacity | [PENDIENTE] dirección cinematográfica, **no implementada** |

**Matriz:** focus/click feedback 0–120ms; hover 120ms; popover 120–180ms; panel ocasional 180–260ms; acción frecuente y teclado: instantánea; ambient continuo: solo en landing, pausado fuera de vista y bajo `prefers-reduced-motion`. **No usar `transition: all` ni animar layout, `left/top/width/height`, sombras en cada frame, blur intensivo o re-render React por frame.** Para gestos futuros: seguimiento 1:1, interrupción y reversión en cualquier punto, herencia de velocidad y límites elásticos deliberados. No introducir motor de springs o 3D sin probar necesidad y rendimiento en móvil. **En el primer laboratorio la composición de portadas es estática**; se experimenta primero con geometría y tokens.

## 8. Responsive, accesibilidad y rendimiento

### 8.1 Breakpoints [LAB; no reemplazan media queries existentes]

| Rango | Reglas |
|---|---|
| 320–639px (mobile) | gutter 20px landing / 16px gallery; hero 40px o clamp; nav compacta; cards auto-fit, 2-up cuando quepan |
| 640–959px (tablet) | gutter 32px; hero 56px; header simplificado; 6 columnas |
| 960–1279px (desktop) | landing hero 56px; dos bloques laterales; 12 columnas |
| ≥1280px (wide) | hero 72px; max landing 1200px; app 1440px; sin crecimiento ilimitado de texto |

**[EXISTENTE]** breakpoints reales varían entre 390/430px y otras media queries de `src/`; evitar prometer equivalencia o reemplazarlos sin auditoría. Validar 320, 375, 390, 640, 768, 1024, 1440px, zoom 200%, navegadores con fonts no SF.

### 8.2 Checklist no negociable

- Texto normal ≥4.5:1, grande ≥3:1, bordes/indicadores funcionales ≥3:1 donde aplique; revalidar cada token editado. No confiar en contraste original después de cambios.
- Hit area objetivo ≥44×44px para acciones principales; un icono visual de 18px no equivale a un botón táctil de 18px.
- Foco visible (no solo hover); acciones alcanzables por teclado; orden de tabulación acorde al DOM; Escape devuelve el control si hay popover.
- Un solo H1 por pantalla; landmarks `header/main/nav`; labels visibles; ARIA solo cuando corresponde.
- `prefers-reduced-motion: reduce`: desactivar ambient, transformaciones y feedback no esencial; no contenido exclusivamente animado.
- Portadas informativas con descripción; artwork ficticio decorativo con nombre visible adyacente. Evitar autoplay de audio, flashes y contenido que cambie inesperadamente.
- Estados asíncronos reales deberán tener `aria-live` moderado, error legible, retry; el mock no llama servicios.
- Performance: no añadir dependencias grandes, imágenes remotas, vídeo, canvas 3D, fuentes remotas, observers ni timers al primer laboratorio.

## 9. Dirección por pantalla y límites del primer laboratorio

### Landing [LAB]

Primera maqueta: nav, etiqueta editorial, H1, texto corto, CTA ficticio, composición estática de portadas generadas en CSS. Aún **no** definir copy final, órbita real, física, transiciones de scroll, autenticación, pricing ni videos. Artworks solo son ejemplos procedurales. Desktop puede apilar planos y usar perspectivas suaves; móvil reduce la composición en favor de legibilidad.

### Gallery [LAB]

Primera maqueta: shell, cabecera, búsqueda local, filtros demo, rejilla de artwork, player ficticio. No hay importación, uploads, persistencia, Cloud, MASTER, INDEX, Telegram, billing ni acceso a archivos. Estados y filtros se resuelven en memoria. Las futuras pantallas podrán ampliarse por componente sin tocar la app.

### Components [LAB]

Inventario vivo de botones, estados, campos, tokens editables, chips, cards, mini player y contraste visual. Los tokens editables alteran CSS variables **solo bajo el root del laboratorio**. Reset restituye defaults; nada se guarda ni afecta producción.

## 10. Qué hacer / qué evitar — criterios de revisión para IA

| Hacer | Evitar |
|---|---|
| Releer `DESIGN.md` + `tokens.css` antes de crear componente | Asumir que una propuesta de laboratorio es decisión aprobada |
| Reutilizar token de rol y primitiva antes de escribir CSS nuevo | Hex, sombras, padding y radios ad hoc en vistas |
| Usar el mismo tema en landing y gallery | Un tema visual independiente por página |
| Validar hover, active, focus, disabled, teclado y móvil | Una captura bonita solo desktop |
| Mantener datos completamente ficticios, sin fetch/audio | Conectar prototipo a producto, API o credenciales |
| Aislar animaciones y probar movimiento reducido | Animaciones constantes en tareas frecuentes |
| Dar protagonismo a artworks y jerarquía | Sombras, gradientes y blur decorativos en toda card |
| Señalar desacuerdos entre código real y propuestas | Reemplazar CSS productivo por suposición |

## 11. Instrucciones operativas para IA

1. Leer `BLUEPRINT/DESIGN-SYSTEM/{README,DESIGN,REFERENCES}.md`, `src/styles/design-foundations.css`, `src/styles/library-ux.css` y la primitiva relevante antes de diseñar.
2. Declarar para cada cambio: **[EXISTENTE]**, **[LAB]** o **[PENDIENTE]**. Nunca editar un valor de producción para que coincida con este documento sin aprobación.
3. Consultar `design-lab/tokens.css` para cada valor ejecutable. Si hay un nuevo rol, añadir un token allí y actualizar la tabla aquí; no crear variantes casi duplicadas.
4. Crear composiciones desde `design-lab/components.tsx`, evitar dependencia de `src/`, servicios y assets remotos. Mantener componentes semánticos sin botones anidados.
5. Antes de entregar: comprobar 320/390/768/1440px, focus visible, reduced motion, textos largos, filtros sin resultados y panel de tokens.
6. Si se cambió un token base existente en LAB, explicar exactamente qué valor cambió, por qué y que **no se alteró en el producto**.
7. Solo con aprobación del propietario portar cambios selectivamente a `src/`, preservar comportamientos reales y añadir pruebas relevantes.
8. No llamar una maqueta «pantalla final» ni confundir playback falso con un reproductor operativo.

## 12. Decisiones pendientes [PENDIENTE]

- Aprobar o descartar el **acento experimental `#c8b7ff`** como color de identidad; por ahora el CTA sigue neutro.
- Ratificar tamaño de cuerpo de 14px en app vs 13px existente, tracking de títulos y radios de artwork.
- Elegir dirección final de la composición landing, y si requiere órbita; validar energía, consumo y opción de pausa antes de cualquier animación persistente.
- Comparar densidad y navegación real de gallery frente al mock; no trasladar cambios del player sin verificar accesibilidad ni tiempo de primera reproducción.
- Establecer un procedimiento de revisión visual y aprobación cuando haya variantes reales.

**Alcance verificado de este PR:** especificación + Design Lab ficticio. **No** cambio productivo, no decisión de identidad final, no certificación de contraste para cualquier token modificado manualmente.
