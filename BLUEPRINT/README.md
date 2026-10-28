# BLUEPRINT — BeatGaler

**Guía de dirección, no plan de ejecución.** Sin cronogramas, fases obligatorias ni una tarea por archivo. Solo se crea un plan concreto cuando se elige trabajar en un tema.

| Documento | Contenido |
| --- | --- |
| [DIRECTION.md](DIRECTION.md) | Orden **recomendado y flexible** hacia V1: auditoría → rendimiento → UX/landing → limpieza incremental → validación. Marketing en paralelo. |
| [DESIGN-SYSTEM/](DESIGN-SYSTEM/) | Identidad visual BeatGaler, reglas de consistencia, referencias externas y prototipos **falsos** de landing/galería. |
| [TECHNICAL-CORE-AUDIT-V1.md](TECHNICAL-CORE-AUDIT-V1.md) | **Plan específico del paso 1:** auditoría técnica Web + Cloud; todos los hallazgos de la inspección estática, riesgos, fuentes, verificaciones y criterios de cierre. |
| [CURRENT-STATE.md](CURRENT-STATE.md) | Producción, desarrollo, decisiones vigentes y límites. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Mapa técnico, invariantes y auditorías pendientes. |
| [BILLING-V1-POLICY.md](BILLING-V1-POLICY.md) | Reglas de planes, acceso y dinero. |
| [HISTORY.md](HISTORY.md) | Decisiones y expedientes históricos recuperables por SHA. |
| [Incidente EC2, 27-10-2026](OPERATIONS/INCIDENT-2026-10-27-EC2-NETWORK.md) | Registro íntegro: recuperado, observación, no investigación activa. |

**Fuente de verdad:** código, migraciones, tests, runtime, PRs y CI. Un documento histórico o el plan de auditoría no certifican lo publicado. La documentación especializada que sigue vigente está en `docs/` y `cloud-server/`.

**Producción protegida:** Web + Cloud `v0.9.0-beta.2`, release `a8418223527f88e9d34db8e05abb10216942013c`. No publicar `main` sin permiso. Desktop/Tauri, suspendido.

En lugar de otra carpeta de archivo, los expedientes eliminados se consultan en el [BLUEPRINT original fijado por commit](https://github.com/magosouljah/BeatGaler/tree/748c1de6a309162d2727e4e272098e7d007f3f49/BLUEPRINT).
