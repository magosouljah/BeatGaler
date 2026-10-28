# ARCHITECTURE.md — Arquitectura vigente del Design Lab

**Documento descriptivo, subordinado a [README.md](README.md).** El código de `design-lab/` es la fuente técnica de verdad. No se obliga a Brand → Alias → Mapped solo porque la transcripción de UI Collective lo utiliza.

## Estructura implementada [LAB]

```text
design-lab/
  main.tsx, index.html, vite.config.ts     # Entrada y build aislados
  App.tsx                                 # Estado compartido / Landing / navegación
  GalleryPage.tsx                         # Galería ficticia con interacciones
  components.tsx                          # Primitivas BeatGaler reutilizadas
  tokens.css                              # Escalas y roles CSS existentes
  lab.css, gallery.css                    # Landing, Gallery y componentes originales
  coverSources.ts, data.ts                # Fuentes de portada y fixtures
  system/
    catalog.ts                            # 58 fichas: área, grupo, contratos
    foundations.ts                        # Valores editables → CSS custom properties
    primitives.tsx                        # Componentes de controles y UI
    MasterPage.tsx                        # Workbench y muestras con estado local
    studio.css                            # Layout premium, inspector, responsive
  motion/
    physics.ts                            # Springs, campo de fuerza, inercia, gravedad
    Orbit.tsx                             # Órbita extraída, compartida por dos vistas
    MotionPlayground.tsx                  # Laboratorio físico interactivo
  tsconfig.json                           # TypeScript estricto sólo para Design Lab
  lab-contract.test.mjs                   # Contratos anteriores + aislamiento
  system-contract.test.mjs                # Contratos de catálogo y matemáticas físicas
```

## Dependencias y flujo

1. `App.tsx` mantiene **estado local** de colores, ajustes de Foundations, muestra de artwork, reproducción simulada, beat elegido y colores de tags.
2. `system/foundations.ts` traduce los ajustes a variables CSS del contenedor `.lab-root`. `tokens.css` contiene los defaults; no hay generador externo de temas ni actualización de `src/`.
3. `MasterPage` utiliza el catálogo de metadatos para navegación y documentación, y construye demos de los mismos componentes React de `components.tsx` y `system/primitives.tsx`. **El catálogo no genera código ni exporta paquetes**.
4. Landing y MASTER importan una **única implementación** de `motion/Orbit.tsx`. La órbita llama a `vectorForce`, el motor puro en `motion/physics.ts`.
5. Gallery y MASTER utilizan `LabBeatTile`, `LabArtwork`, `LabPlayer` y `LabButton`; Gallery conserva algunas particularidades visuales locales.
6. El standalone build Vite no importa la app real; los datos de demo permanecen en memoria y las portadas locales no hacen peticiones de red.

## Tokens: dos responsabilidades sin sobreingeniería

- **Valores base:** defaults y escala en `tokens.css` con editor local en `system/foundations.ts`.
- **Roles aplicados:** propiedades `--lab-*` consumidas por componentes, algunas dinámicas en `.lab-root` con `toLabVariables`.

No se implementó un esquema separado **Brand / Alias / Mapped** ni versionado de tokens por marca. La transcripción enseña su uso, pero para BeatGaler experimental (una identidad y un tema oscuro) se ha conservado una estructura directa. La necesidad futura de alias se debe justificar con casos reales.

## Física: contratos ejecutables

- `springStep(axis, target, dt, {stiffness,damping,mass})`: integración estable, retargeting y continuidad de velocidad.
- `vectorForce(position, center, radius, strength, mode)`: campo radial local de repulsión o atracción.
- `inertialProjection(position, velocity, friction)`: predicción de destino al soltar.
- `integrateGravity(position, velocity, dt, gravity, floor, bounce)`: aceleración, suelo y restitución.

El playground usa `requestAnimationFrame`, puntero, captura durante drag, teclado y consulta `prefers-reduced-motion`. El motor es reutilizable, **no un motor de colisiones general ni un sistema de gestos de producción**. Los efectos espaciales usados en Landing aún contienen geometría específica de ese caso, apropiada para `Orbit`.

## [PENDIENTE]

- Pruebas de interacción navegador/E2E, accesibilidad real, medición de rendimiento y validación en hardware móvil.
- Más control sobre propiedades y estados de todas las fichas; completar la composición de menús avanzados y navegación por teclado.
- Auditar valores CSS literales de Gallery y Landing para una convergencia gradual a los mismos tokens sin dañar el diseño existente.

**Alcance:** rama `design/beatgaler-design-system-lab-v1`, sin cambios a `main`, `src/` ni despliegue Web + Cloud. Para inventario de componentes actuales, ver [DESIGN.md](DESIGN.md).
