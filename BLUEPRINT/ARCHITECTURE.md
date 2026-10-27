# Arquitectura — mapa de decisiones y dudas

**Guía técnica, no certificación del runtime.** Ante una decisión, validar la ruta del SHA objetivo con código, migraciones, pruebas e instrumentación; no transformar propuestas antiguas en contratos vigentes.

| Área | Fuente y responsabilidad |
| --- | --- |
| Web | `src/` y tests: UI, login, biblioteca, subidas y reproducción. |
| Cloud | `cloud-server/`: APIs, Auth, autorizaciones, coordinación, reintentos y jobs. |
| PostgreSQL | Autoridad durable del control-plane, identidades/sesiones, Access, cuotas/reservas, billing, auditoría y reconciliación. Ver [ADR-0052](../docs/ADR-0052-DURABLE-DATA-ARCHITECTURE.md), migraciones y pruebas. El `NO-GO` de agosto en el ADR es histórico. |
| INDEX / medios | INDEX fijado: autoridad lógica histórica de beats, Trash y referencias; Telegram: medios físicos; PostgreSQL: ledger, reservas, punteros y tareas durables. No confundir las autoridades ni borrar datos por desincronización. |
| Billing | [Contrato comercial y acceso](BILLING-V1-POLICY.md), código y migraciones. |
| Operación | [GitHub workflow](../docs/operations/GITHUB-WORKFLOW.md), [AWS](../docs/operations/TASK-5.2-AWS-PRODUCTION-CONTRACT.md), [cutover/rollback](../docs/operations/TASK-5.2-PRODUCTIVE-CUTOVER-RUNBOOK.md), [observabilidad](../cloud-server/OPERATIONS-OBSERVABILITY.md). Validar vigencia antes de operar. |

## Invariantes

- El servidor autoriza acceso, recursos, ownership y límites; un cliente/bot ajeno no debe leer, fijar, modificar ni borrar biblioteca o archivos de otro usuario.
- INDEX, pins, recibos, cuotas, tombstones, Trash y purge deben mantenerse coherentes ante retry, crash, concurrencia y restauración. No perder ni resucitar datos.
- Coordinación durable e idempotencia antes de realizar efectos externos; incertidumbre se trata explícitamente. Evitar transacciones SQL abiertas mientras espera una llamada al proveedor.
- El viejo absoluto «Cloud cero bytes» no es universal: PROJECT Web tuvo una ruta que transitó bytes por Cloud. Auditar rutas reales; no imponer contratos superados.
- Pruebas locales, CI o Polar Sandbox certifican solo su entorno y SHA; no prueban por sí mismas carga masiva, producción o cobros reales.
- No exponer secretos, tokens, URLs firmadas ni payloads sensibles en logs/evidencia.

## Pendiente de investigar, no decidido

**MASTER, Transport Bots e INDEX:** el expediente [Fase 3 STEP 4](HISTORY.md) describía publicación y pin por MASTER y revocación de permiso de pin de Direct. Otros diseños Direct describen INDEX editado desde el bot asignado y MASTER usado para aprovisionar/recuperar. Existen operaciones Cloud de INDEX vía MASTER. **Estas descripciones divergen:** comprobar ruta Web + Cloud efectiva, derechos, reintentos, autoría, bloqueos, llamadas a Telegram, escala y riesgos de borrado antes de proponer otro dueño del INDEX.

Las antiguas matrices y arquitecturas extensas permanecen [accesibles por commit](HISTORY.md), no en el índice activo.
