# Historia y decisiones conservadas

**Archivo histórico en Git, no en el árbol activo:** [BLUEPRINT íntegro antes de la limpieza (commit 748c1de6)](https://github.com/magosouljah/BeatGaler/tree/748c1de6a309162d2727e4e272098e7d007f3f49/BLUEPRINT). Allí están los 48 documentos originales con sus rutas, contratos, procedimientos, gates, logs, SHAs y detalles. El historial de Git permite recuperar cada archivo sin acumular decenas de Markdown en el BLUEPRINT actual.

**Los estados PASS / NO-GO / PENDING son válidos solamente para el SHA, fecha y entorno que los produjeron.**

- **Visión y método:** antiguos `V1.md`, `BRUNO.md`, `SYSTEM.md`, `WORKPLAN.md` y `ROADMAP.md`: simplicidad, no perder datos y dos flujos fundamentales. Desktop/offline/YouTube eran visión aspiracional, no funciones Web certificadas.
- **Fase 2:** `PHASE-2-CLOSURE.md` documentó cierre de la carrera FramedWriter (fix `f067c21c9280ce2b6f9a17c91461865c22c347a8`), pruebas y límites de las mediciones WebDriver; no garantía general de tiempos.
- **Fase 3/Billing:** `PHASE-3-STATUS.md`, nueve `BILLING-V1-*.md`, STEP14/15 y `v1-gates/` contienen evidencias de cuotas, reservas, INDEX, PROJECT, permisos, pagos y recuperaciones. Algunos escenarios financieros/Browser permanecían PARTIAL o pendientes de pruebas externas. Las líneas antiguas que emitían welcome fueron **sustituidas por política Free de `main`**.
- **Cierre V1 anterior:** `V1-CLOSURE-PLAN.md`, `V1-CLOSURE-GATES.md`, matrices, handoffs y `PHASE-3-STEP-15-*.md` se referían a worktrees, asignaciones, fases y SHAs históricos; **no** son el plan obligatorio actual.
- **Arquitectura:** [ADR-0052](../docs/ADR-0052-DURABLE-DATA-ARCHITECTURE.md) describe separación PostgreSQL/control-plane, INDEX lógico y medios externos. El `implementation not started / NO-GO` de agosto es histórico. Los flujos Web PROJECT cambiaron la antigua premisa absoluta de Cloud sin bytes.
- **Operación:** conservar fuentes de trabajo de AWS/rollback en `docs/operations/`; [incidente EC2 2026-10-27](OPERATIONS/INCIDENT-2026-10-27-EC2-NETWORK.md) permanece íntegro y en observación.

**Para investigar:** abrir el archivo histórico por SHA, comprobar fecha/entorno y contrastar con código, tests, PR y release evaluados. Si una decisión sigue vigente, actualizar [DIRECTION](DIRECTION.md), [ARCHITECTURE](ARCHITECTURE.md) o [BILLING](BILLING-V1-POLICY.md); no reintroducir archivos de fases.
