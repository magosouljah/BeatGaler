# BeatGaler — DESIGN.md

**Estado: propuesta inicial para prototipos, no contrato visual final ni cambio aplicado a producción.**

## 1. Personalidad y atmósfera

BeatGaler es una biblioteca creativa para guardar, organizar y escuchar beats y proyectos.

- **Galería:** utilidad refinada; ritmo visual ordenado, controles discretos, búsqueda y reproducción inmediatas, portadas dominantes, claridad antes que espectáculo.
- **Landing:** galería cinética/cinematográfica; composición espacial de portadas que orbitan el CTA central. La animación invita a explorar sin dificultar «Create Galer».
- **Consistencia:** mismo logo, lenguaje tipográfico, neutros, radios, estados y tratamiento de contenido. La landing amplía la expresividad; la galería reduce el movimiento continuo.

## 2. Principios no negociables

1. **Contenido primero:** arte y títulos reconocibles. No introducir adornos que desplacen información útil.
2. **Respuesta inmediata y agencia:** hover, clic, teclado y scroll con feedback; toda animación se puede interrumpir, pausar o reducir.
3. **Sistema antes que casos aislados:** reusar tokens, botones y superficies. Las excepciones se justifican.
4. **Simplicidad funcional:** acciones frecuentes obvias; opciones avanzadas sin saturar la primera vista.
5. **Accesibilidad y rendimiento:** contrastes, foco visible, controles táctiles, degradación progresiva y presupuesto de animación.
6. **Originalidad:** inspiración en principios de otras marcas, nunca réplica de assets, textos publicitarios, logotipos o identidad.

## 3. Colores y tokens existentes (hechos en `main`)

**Referencia actual:** `src/styles/design-foundations.css`. Estos valores existen hoy; **no** son decisiones nuevas aprobadas para el rediseño.

| Rol | Token actual | Valor |
| --- | --- | --- |
| Canvas | `--bg-canvas` | `#090909` |
| Superficie | `--bg-surface` | `#101010` |
| Elevado | `--bg-raised` | `#151515` |
| Hover | `--bg-hover` | `#1c1c1c` |
| Texto principal | `--text-primary` | `#f2f2f2` |
| Texto secundario | `--text-secondary` | `#b0b0b0` |
| Borde discreto | `--border-subtle` | `#242424` |
| Foco | `--focus-ring` | `#f2f2f2` |

Mantener neutros oscuros y blancos suaves como punto de partida; el color intenso provendrá principalmente de las portadas. No adoptar verdes, azules ni acentos propietarios de otras marcas sin selección expresa. Colores semánticos de estado (éxito, error, aviso) permanecen diferenciados de la marca.

## 4. Tipografía, geometría y espacio

- La app ya declara `"SF Pro Text", "Segoe UI", "Helvetica Neue", system-ui, sans-serif` como familia de fallback. No distribuir fuentes de Apple ni asumir que están disponibles en todos los sistemas.
- **Propuesta:** jerarquía tipográfica breve y coherente; títulos expresivos en landing, tamaños funcionales legibles en galería; tracking ajustado al tamaño y líneas confortables.
- Espaciado existente: `--space-1` a `--space-8` = 4, 8, 12, 16, 20, 24, 28 y 32 px.
- Radios existentes: `--radius-sm` = 8px, `--radius-md` = 12px, `--radius-lg` = 16px, `--radius-pill` = 999px.
- Controles estándar existentes: `--control-height` = 44px. En zonas densas, el blanco táctil efectivo no debe sacrificarse por estética.
- Usar alineaciones precisas y aire suficiente; no depender de posiciones rígidas que rompan en móvil.

## 5. Componentes a explorar — no implementar todavía en producción

**Compartidos:** logo, botón primario / secundario / texto, icon button, etiquetas, foco, estados disabled / loading / error, artwork tile, tipografía de títulos y metadatos.

**Landing falsa:**
- Marca BeatGaler arriba a la izquierda; acceso «Log in» arriba a la derecha (sin login real).
- Centro: CTA «Create Galer» o «Join», con texto breve que explique el valor sin prometer funcionalidades no verificadas.
- Portadas en un anillo espacial tridimensional, inspirado en la tercera imagen de referencia del usuario: profundidad, perspectivas y ritmo equilibrado. No debe parecer una plantilla de streaming ni copiar un sitio existente.
- Movimiento continuo lento solo en esta experiencia; repulsión suave y limitada al acercar el puntero, sin empujar imágenes sobre el CTA. El efecto es secundario al contenido.
- En móvil: menos portadas, órbita simplificada o composición estática, CTA siempre disponible.

**Galería falsa:**
- Header ligero, búsqueda, orden, filtros por etiquetas, selección y navegación clara.
- Rejilla de carátulas; estados hover/focus, reproducción simulada, detalles suficientes para distinguir beats.
- Estados demostrables: galería llena, vacía, carga, error, nombres y etiquetas extensos, selección múltiple.
- Reducir animaciones decorativas; no entorpecer encontrar → escuchar → organizar.

## 6. Motion y física

- Tokens actuales `--motion-fast: 120ms`, `--motion-normal: 180ms`, `--ease-standard: cubic-bezier(0.2, 0.7, 0.2, 1)`; no cambiarlos silenciosamente.
- Animar preferentemente **transform** y **opacity**; evitar forzar layout y evitar re-render de React en cada frame.
- La interacción debe empezar al contacto, heredar continuidad y permitir reversión; resorts/springs solo si mejoran el control.
- La órbita puede usar CSS/WAAPI u otra técnica según mediciones. No añadir un framework 3D pesado sin necesidad comprobada.
- Respetar `prefers-reduced-motion`: reemplazar órbita, parallax y repulsión por composición estática o transición mínima. Considerar pausa en fondo, pestaña oculta y contenido fuera de vista.
- Medir suavidad y consumo en móvil real; no interpretar un mock fluido en desktop como garantía de rendimiento.

## 7. Accesibilidad y responsive

- Contraste adecuado (objetivo WCAG AA en texto normal y controles pertinentes); foco visible; navegación por teclado y etiquetas accesibles.
- Evitar acciones disponibles exclusivamente en hover; targets táctiles cómodos (referencia de 44px).
- Texto ampliado, 320–390px de ancho, tablet, desktop y zoom; diseño sin scroll horizontal accidental.
- La portada no debe introducir flashes ni movimiento vestibular inevitable. Dar opción de pausar si hay animación ambiental persistente.
- Loading, error y vacío deben comunicar estado sin depender solo del color.

## 8. Hacer / evitar

| Hacer | Evitar |
| --- | --- |
| Dar protagonismo a la música y carátulas | Decoración constante en cada control |
| Usar tokens y componentes comunes | Colores/tamaños ad hoc por pantalla |
| Probar variantes reales y elegir | Aceptar el primer diseño generado |
| Animar para feedback o narrativa | Transiciones lentas en tareas frecuentes |
| Aislar mocks y datos ficticios | Conectar demos a servicios productivos |
| Adaptar principios de buenas referencias | Clonar identidad Apple, Spotify, Linear o Runway |

## 9. Diseño → implementación

La aprobación visual será por componente o por pantalla, no por un «rediseño» monolítico. Antes de portar al producto: comparar con `src/styles/design-foundations.css`, `src/styles/library-ux.css`, `src/components/ui/DesignPrimitives.tsx`, `src/components/BeatCard.tsx` y `src/app/AppShell.tsx`. No duplicar estilos globales ni reescribir lógica de auth, audio, INDEX o Cloud.

**Lo que aún debemos escoger mediante prototipos:** tipografía final, acento propio de BeatGaler, tamaños de carátulas, geometría de la órbita, ritmo de animación, CTA final y composición móvil. No declarar estos puntos cerrados antes de ver y usar ambas pantallas.
