# BLUEPRINT — BeatGaler

**Guía de dirección, no plan de ejecución.** Sin cronogramas, fases obligatorias ni una tarea por archivo. Solo se crea un plan concreto cuando se elige trabajar en un tema.

| Documento | Contenido |
| --- | --- |
| [DIRECTION.md](DIRECTION.md) | Orden **recomendado y flexible** hacia V1: auditoría → rendimiento → UX/landing → limpieza incremental → validación. Marketing en paralelo. |
| [DESIGN-SYSTEM/](DESIGN-SYSTEM/) | Design System vivo del laboratorio: MASTER, Landing y Gallery; skills, decisiones y referencias sin autoridad visual paralela. |
| [TECHNICAL-CORE-AUDIT-V1.md](TECHNICAL-CORE-AUDIT-V1.md) | **Plan específico del paso 1:** auditoría técnica Web + Cloud; todos los hallazgos de la inspección estática, riesgos, fuentes, verificaciones y criterios de cierre. |
| [CURRENT-STATE.md](CURRENT-STATE.md) | Producción, desarrollo, decisiones vigentes y límites. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Mapa técnico, invariantes y auditorías pendientes. |
| [BILLING-V1-POLICY.md](BILLING-V1-POLICY.md) | Reglas de planes, acceso y dinero. |
| [HISTORY.md](HISTORY.md) | Decisiones y expedientes históricos recuperables por SHA. |
| [Incidente EC2, 27-10-2026](OPERATIONS/INCIDENT-2026-10-27-EC2-NETWORK.md) | Registro íntegro: recuperado, observación, no investigación activa. |

## Regla obligatoria para cualquier IA que diseñe BeatGaler

Antes de crear, rediseñar o modificar componentes, Landing, Gallery, MASTER, interacciones, animaciones o físicas:

1. Leer [DESIGN-SYSTEM/README.md](DESIGN-SYSTEM/README.md) y examinar **el código que realmente se ejecuta** en `design-lab/`.
2. **Leer y aplicar las skills relevantes** instaladas en [`.agents/skills/`](../.agents/skills/README.md); por ejemplo, `apple-design` / `emil-design-eng` para interfaz, `animate` / `animation-performance` para movimiento, `mobile-native` para táctil y `prototype` para alternativas.
3. Diseñar primero en el prototipo interactivo, comparar allí y registrar solo lo realmente implementado o expresamente aprobado. **No convertir un texto de referencia en una regla obligatoria** ni agregar capas de tokens sin necesidad comprobada.

Para este trabajo, las reglas y precedencias específicas están exclusivamente en `DESIGN-SYSTEM/README.md`. MASTER es un espacio de trabajo en revisión visual, no una propuesta estética aprobada.

**Fuente de verdad:** código, migraciones, tests, runtime, PRs y CI. Un documento histórico o el plan de auditoría no certifican lo publicado. La documentación especializada que sigue vigente está en `docs/` y `cloud-server/`.

**Producción protegida:** Web + Cloud `v0.9.0-beta.2`, release `a8418223527f88e9d34db8e05abb10216942013c`. No publicar `main` sin permiso. Desktop/Tauri, suspendido.

En lugar de otra carpeta de archivo, los expedientes eliminados se consultan en el [BLUEPRINT original fijado por commit](https://github.com/magosouljah/BeatGaler/tree/748c1de6a309162d2727e4e272098e7d007f3f49/BLUEPRINT).
