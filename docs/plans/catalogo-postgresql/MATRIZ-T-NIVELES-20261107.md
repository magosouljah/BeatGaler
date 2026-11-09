# Matriz maestra T00–T25 por nivel — N1

Fecha: 2026-11-07. Complementa cada ficha homónima de [TAREAS](TAREAS.md), sin omitir ninguno de sus pasos/tests. Nombres principales copiados del plan; etiquetas de paquetes A/B/C son descomposición nueva, no renumeración. Aplicar [manual N1](EJECUCION-POR-NIVELES-20261107.md), especialmente reglas comunes, STOP §5 y handoff §9. Producto y prioridades de prueba: [r4](C12-V00-CIERRE-20261107.md), [r2](C12-DECISION-RECORD.md) y [plan B](C12-B-INTEGRACION-Y-PLAN-20261107.md) donde r4 no los sustituye.

## Convenciones ejecutables comunes a las 26 fichas

- **Entrada común:** encargo, Git/AGENTS, estado y evidencias de dependencias, C1–C12/M0–M6/R1–R3 aplicables y r4; nada de PASS implícito. **Salida común:** informe/handoff N1 §9, diff y tabla requisito→test→resultado. Los paths de cada ficha son adicionales a estos documentos.
- **PASS común P:** todos los pasos originales y casos añadidos completos, 0 FAIL y 0 SKIP obligatorios, artefactos trazables al código/entorno correcto; `git diff --check` y revisión de nuevos archivos. Una salida fake se etiqueta aislada; nunca certifica proveedor. Paquetes A/B parciales no cierran padre.
- **Comando C(Txx):** futuro `node scripts/catalog-check.cjs Txx`, solo tras T02 y manifiesto específico existente/validado. `C(perf)` y `C(all-local)` usan el mismo runner. No inventar comandos para suites no implementadas; su alta es entrega de T02/tarea propietaria antes de declarar PASS. Cada ficha conserva sus pruebas originales además de C.
- **Fallo R/E:** diagnóstico, acciones permitidas y escalamiento exactos de N1 §5, más particularidad de cada ficha. Nunca modificar expected/cobertura para obtener PASS.
- **Permiso común A:** encargo de esa tarea y entorno desechable autorizado. No hay permiso actual de ejecución. Acceso real exige autorización explícita identificada; una revisión técnica no lo concede.

## Índice maestro

| T | Nombre original | Dependencia principal / gate de entrada | Responsable / dificultad | Paquetes de menor coste y revisión |
| --- | --- | --- | --- | --- |
| T00 | Congelar la base y el ámbito de trabajo | Encargo T00; prepara G0 | IDE BAJA / baja, juicio externo | BAJA evidencia; Sol dictamen G0 |
| T01 | Cerrar el mapa de datos y consumidores | T00/G0 + autorización | IDE BAJA / media con diseño acotado | BAJA inventario; ALTA vacíos r4; MEDIA cobertura |
| T02 | Crear el arnés aislado y comandos de verificación | T01 | IDE MEDIA / media | MEDIA guardas; BAJA fixtures/tests negativos |
| T03 | Crear esquema base y repositorio de catálogo | T02 | IDE MEDIA / media | MEDIA constraints/transacción; BAJA DDL y casos ya fijados |
| T04 | Importador/exportador y comparación completa | T03 + mapa cerrado | IDE BAJA / media | BAJA codec; MEDIA revisión G1 |
| T05 | Autoridad, época y guardas internas | T04 | IDE MEDIA / media | MEDIA guard reutilizable; BAJA matriz de rechazo |
| T06 | Consultas paginadas y endpoints de lectura | T05 + C12 aprobada | IDE MEDIA / alta localizada | ALTA contratos nuevos; MEDIA SQL; BAJA casos |
| T07 | PATCH, trash y restore con concurrencia | T06 | IDE MEDIA / media-alta | MEDIA comandos/bulk; BAJA fallos por frontera |
| T08 | Cliente de lectura, navegación y feed durable | T07, V01/V02 | IDE MEDIA / media | V03–V05; BAJA regresiones de cliente |
| T09 | Intenciones, reservas y máquina de estados | T08 | IDE MEDIA / media | MEDIA transiciones; BAJA tabla de casos |
| T10 | Worker con leases y pruebas de caída | T09 | IDE MEDIA / media-alta | MEDIA worker; BAJA campañas crash |
| T11 | Resolver el contrato real de Telegram | T10 + sandbox autorizado | IDE ALTA / alta abierta | MEDIA harness cerrado; BAJA evidencias |
| T12 | Conectar transferencias y PROJECT a operaciones | T11 PASS; excepción mocks explícita | IDE MEDIA / media-alta | MEDIA adaptadores; BAJA regresiones/recibos |
| T13 | Cliente de mutaciones sin INDEX | T12, V00-A/B, V04 | IDE MEDIA / media | V07-A; BAJA casos UI cerrados |
| T14 | Playback, artwork y descargas desde referencias SQL | T13, V04, contratos T06 | IDE MEDIA / alta de integración | V06/V07-B; BAJA oracle/casos r4 |
| T15 | Purge durable, retención y limpieza segura | T14 | IDE MEDIA / media-alta | MEDIA journal/borrado; BAJA matriz de fallos |
| T16 | Integrar arranque y cercado exhaustivo | T15, V05/V06/V07 | IDE MEDIA / media-alta | V08 MEDIA, V09 BAJA; dictamen G3 MEDIA |
| T17 | CLI de sombra, freeze, corte y reversión | T16 | IDE MEDIA / media-alta | MEDIA checkpoints; BAJA CLI guards/ayuda |
| T18 | Ensayo completo de migración y rollback con nuevas escrituras | T17 | IDE BAJA / media, procedimiento cerrado | BAJA ensayo; MEDIA G4/lector independiente |
| T19 | Backup, restauración y journal de purges | T18 | IDE MEDIA / media-alta | MEDIA restore; BAJA campañas/cobertura |
| T20 | Capacidad, latencia y contención | T19, V09 | IDE BAJA / media, medición | V10 BAJA; MEDIA tuning delimitado |
| T21 | Preparar candidato y revisión de alta capacidad | T20, G2 real, G3 | IDE ALTA / alta, revisión final | BAJA empaqueta; ALTA revisa; MEDIA fixes |
| T22 | Sombra real autorizada | T21 + permiso puente/biblioteca | IDE BAJA / media, runbook cerrado | MEDIA G1 real; usuario autoriza M1–M2 |
| T23 | Piloto autorizado de una biblioteca | T22, G0–G4 + permiso corte | IDE MEDIA / media-alta operativa | BAJA observación; MEDIA runbook/diagnóstico |
| T24 | Cohortes y habilitación controlada de limpieza | T23 + permiso por cohorte/cleanup | IDE BAJA / media, runbook cerrado | MEDIA verifica anomalías; usuario autoriza |
| T25 | Cerrar reversibilidad y retirar dependencias activas de INDEX | T24 + ventana/excepciones + permiso | IDE BAJA / media, cierre probatorio | MEDIA revisa cierre; usuario autoriza |

## T00 — Congelar la base y el ámbito de trabajo

**Objetivo/responsable:** BAJA reúne evidencia reproducible de base y alcance; no necesita rediseñar C12 aprobado. Dificultad baja de preparación; Sol hace juicio independiente. **Dependencias/gate:** autorización T00, entrega G0; no requiere arnés T02 ni mapa T01 completo.

**Entradas/salidas:** T00-REVISION, T00-BASELINE-PASS, G0-POSTGRES-VERIFIED, LOCAL-BASELINE, manifests/locks, ENVIRONMENTS/CURRENT-STATE, script T00; salida acta formal nueva identificada en ESTADO/EVIDENCIA, no reescritura de resultados históricos.

**Orden:** A/BAJA: comprobar Git/AGENTS, preservar dirty, comparar código/tests/runner con SHA de evidencias y revisar 25 migraciones o justificar diferencias; resolver copia de ensayo segura ante guard dirty. Ejecutar solo whitelist inspeccionada, registrar smoke requerido que falte y descriptor/alcance. B/Sol: contrastar r4, base, perfil y evidencias; dictamen por requisito G0. No preguntar otra vez A1/A2/B/I1–I3.

**Pruebas/PASS:** las seis E4 y baseline ampliado original, rutas/auth/Playbar según gate; resultado real con 0 skips obligatorios, aislamiento descrito y C12 cerrado. Histórico 68/68 no cuenta como rerun. Probe acredita descriptor, no ICU SQL. P + dictamen formal.

**STOP/fallo:** BASE si script rechaza árbol, TEST si baseline incompleto, GATE si falta smoke/dictamen; R para fallos rutinarios, MEDIA para integración, ALTA solo nueva contradicción. Nunca commit/reset para satisfacer runner. **Revisión/permiso:** Sol G0; usuario abre T01 después. **Handoff:** hashes de base/runner/pruebas, descriptor, requisitos satisfechos y faltantes, autorización pendiente.

## T01 — Cerrar el mapa de datos y consumidores

**Objetivo/responsable:** BAJA hace inventario exhaustivo siguiendo procedimiento verificable, dificultad media por alcance; ninguna inferencia de esquema nueva queda escondida. **Dependencias:** T00/G0 formal y encargo T01; V00-B/V01-A se ejecutan aquí, no antes.

**Entradas/salidas:** EVIDENCIA E2, C4, r4 §§3–6, `src`, `cloud-server`, Desktop solo lectura; nuevos `contract-map.json`, `consumer-map.md` en este plan, fixtures sintéticas en `cloud-server/tests/fixtures/catalog/`. Añadir al mapa registro versionado de contratos/DDL propuestos y sus propietarios, sin migraciones ejecutables en esta tarea.

**A/BAJA, inventario:**

1. Guardar listado `rg --files src cloud-server tests scripts src-tauri/src` y SHA; buscar símbolos originales de TAREAS T01, más `setBeats`, `windowItems`, `displayedBeats`, `selectedIds`, `queueIds`, `releaseFile`, `allTags`, `tagFrequency`, `localStorage`, `Map`, `Set`, `get_index`, `replace_index`, `publishLibraryIndex`, wrappers/catch de recover. Limitar análisis a código productivo, separar tests y generados. No excluir un resultado por nombre de carpeta sin justificarlo.
2. Por aparición: path/símbolo/línea/SHA, caller y entrada real (HTTP/worker/hook/startup), tipo leído/escrito, autoridad, ámbito (ventana/entidad/operación/global SQL), tenant/era/version, vida/cleanup, decisión legacy-only/adaptar/derivada/Desktop, destino T/V y prueba. Recorrer imports/reexports/callbacks/registro dinámico hasta entrypoint; grep sin callers no cierra inventario.
3. Por JSON path C4: productor, tipo/rango, ausente/null, raw/proyección/DTO/destino SQL, referencia física, reversión, fixture válido/inválido y delta autorizado. Incluir v1/v2, archivos repetidos/desconocidos/multipart/PROJECT, wrappers, garbage, tombstones SQL-only, ID 256 vs capability 192, NUL/surrogates, bytes UTF8, color/crop/flags, ranks y todos los campos no enumerados en DTO ejemplo.
4. Agregar filas propuestas de membresías, selección/excepciones/rangos, facetas y representante, ronda/swaps/inverso/consumidos, cola, bulk/checkpoint/journal/lease. Registrar divergencia rename Web Set exacto vs Desktop normalizado; Desktop no se implementa. V01-A agrega fixtures de ventana/evicción y estado externo.

**B/ALTA, intervención concreta:** cerrar vacíos que el inventario evidencie: claves/FKs y owner, transiciones/revisión esperada, locks, distribución DDL T03/T07/T09/T14, fronteras de lote/recovery, membresía independiente de orden para sort/Shift, persistencia y límites de cola manual. No elegir política de producto nueva. Si falta información, STOP-CONTRACT con ejemplos; no dejar que BAJA diseñe durante DDL.

**C/BAJA y revisión MEDIA:** comprobar cobertura bidireccional: cada hallazgo clasificado tiene fila y test propietario; cada campo destino tiene fuente; cada operación C10 tiene entradas/helpers/catch identificados; cero consumidores productivos sin clase y cero paths sin regla. Repetir búsqueda final y explicar diferencias, no exigir falsamente cero llamadas legacy. MEDIA comprueba las rutas inversas desde cada entrypoint y la matriz de unknowns.

**Pruebas/PASS:** C12-U01/U02/N01/F01/F02/D01, originales T01 y V01-A; actual vs candidato separados, Node/Chrome/Edge cuando exige el caso, sin SQL T02. P + cobertura completa verificable y contrato B firmado. **STOP/fallo:** DATA ante raw ambiguo; CONTRACT ante consumidor global sobre ventana; MEDIA bug de mapa, ALTA decisión, usuario muestras reales. **Handoff:** mapas+hash, fixtures/oracles, búsqueda completa/clasificaciones y contratos nuevos; G1 todavía no completo sin T04.

## T02 — Crear el arnés aislado y comandos de verificación

**Objetivo/responsable:** MEDIA, dificultad media: aislamiento y subprocess/DB son varias fronteras aunque contrato esté definido. **Dependencias:** T01, descriptor G0; V01-B completa V01.

**Archivos:** nuevos `scripts/catalog-check.cjs`, `cloud-server/tests/helpers/catalog-test-db.cjs`, `catalog-fake-transport.cjs`, manifiesto de suites y `.github/workflows/catalog-checks.yml` según original; no publicar/disparar workflow automáticamente. Tests del arnés y fixtures V01.

**Orden:** A/MEDIA: construir runner y allowlist de entorno sin `.env` heredado; identificar cluster dedicado, generar DB/marker/rol por run, verificar ownership antes de cleanup. Declarar nombres reales de suites y casos, exit !=0 si no existen o hay skip/prerequisito ausente; no fingir T03–T21 ya creadas. B/BAJA: fake transporte/clock y counters definidos, pruebas de env contaminado, URL ajena, marker/ownership falso, suite inexistente/skipped y cleanup ajeno. C/MEDIA verifica que no hay conexión antes de validar destino y aprueba plantilla para futuras suites.

**Pruebas/PASS:** `C(unit)` después de crear runner y pruebas; tests negativos originales, counters de red 0 en unit, DB efímera correcta y rechazo de borrado ajeno; V01-B navegador sin auth/red real. P + logs de aislamiento y cleanup solo de DB recién creada.

**STOP/fallo:** ENV si instancia no asignada o destino dudoso, cero escrituras; BAJA corrige fixture definida, MEDIA guardas; ALTA solo cambio del modelo de aislamiento. **Permiso:** A incluye entorno desechable concreto; ningún AWS/proveedor real. **Handoff:** comandos reales, manifiesto versionado, descriptor/guards, contrato de fake y artifacts, grupos futuros claramente pendientes.

## T03 — Crear esquema base y repositorio de catálogo

**Objetivo/responsable:** MEDIA, dificultad media por relaciones, tenant y transacciones; BAJA ejecuta DDL/casos cerrados. **Depende:** T02 y mapa T01-B, contribuye G1/G3.

**Archivos:** siguiente migración disponible `*_catalog_core.sql` (no asumir 0026 libre), `cloud-server/catalog/contract.js`, `repository.js`, schema integration y guard `postgres-migrations.js`. C3+r4: catálogo/raw, membresías base/facetas e índices según mapa de fases; no servicios worker anticipados.

**Orden:** A/MEDIA fija correspondencia exacta mapa→constraints/migración, helper transaccional mismo cliente/finally, sin transporte importado. B/BAJA escribe DDL ya fijado y fixtures negativas. C/MEDIA integra guard de esquema sin debilitar prohibiciones históricas; default LEGACY, cleanup=false, sin importar ni activar datos.

**Pruebas/PASS:** C(T03), fresh y upgrade desde las migraciones históricas, concurrente/idempotente; FK cruzada, active_generation ajena, partes duplicadas, negativos/estados imposibles rechazados por SQL, release comprobado. Medir tamaño inicial de filas nuevas, no llamarlo benchmark T20. P + constraints realmente ejecutados en DB aislada.

**STOP/fallo:** BASE si número/checksum cambió; DATA por incompatibilidad raw; CONTRACT si faltan FKs/orden de DDL. MEDIA errores SQL contra contrato, ALTA nuevo esquema incompatible. **Revisión/permiso:** MEDIA cierre, A; sin migración real. **Handoff:** migraciones/hashes, contratos repository, índices, resultados de upgrade/restricciones para T04.

## T04 — Importador/exportador y comparación completa

**Objetivo/responsable:** BAJA, dificultad media pero transformación detallada por mapa; MEDIA revisa G1. **Depende:** T03 y mapa cerrado, no proveedor.

**Archivos:** `catalog/legacy-codec.js`, `migration.js` solo transformación, `catalog-codec.test.cjs`, `catalog-roundtrip.integration.cjs` en rutas nuevas del original. Entradas: fixtures T01, C4, proyecciones r2/r4.

**Orden:** rechazar JSON ambiguo antes de escribir; implementar cada fila del mapa preservando raw/tipos/ausencias; staging 250 con checkpoint snapshot hash; export por wrappers/parts/extras; comparar path/identidad/ref con oracle de fixture independiente del exportador. Calcular presupuesto incremental y contrastarlo con bytes reales; distinguir source-roundtrip y authoritative-export con tombstones SQL-only.

**Pruebas/PASS:** C(T04), roundtrip profundo de todo mapa, crash/replay de cada lote sin duplicados, snapshot cambiado, duplicados/unsafe integers/unknowns, escapes y límite exacto, `estimate >= actual`. P + cero pérdidas/deltas no autorizados, sin writes de autoridad; G1 sintético por MEDIA, no elegibilidad real.

**STOP/fallo:** DATA con diff por path; BAJA corrige mapping inequívoco, MEDIA integración codec/repo, ALTA dato sin representación. Nunca normalizar raw o usar DTO UI para importar. **Permiso:** A; archivo real solo autorizado aparte. **Handoff:** mapa→casos completos, hashes exports/fixtures, codec/projectionVersion, informe G1 y limitaciones.

## T05 — Autoridad, época y guardas internas

**Objetivo/responsable:** MEDIA, dificultad media: un guard debe cubrir rutas y helpers existentes. **Depende:** T04; aporta G3.

**Archivos:** `catalog/authority.js`, entradas server/routes/helpers C10 del consumer-map, tests autoridad; inspeccionar Express wrappers y catch de recovery.

**Orden:** A/MEDIA resuelve user/vault/generation desde auth SQL, guard reusable; valida era/epoch/state antes de efecto y al commit; unknown falla cerrado y solo LEGACY explícito entra legacy. B/BAJA conecta cada entrada ya mapeada y pruebas parametrizadas de rechazo. C/MEDIA confirma orden efectivo de middleware/helper, sin retirar legacy.

**Pruebas/PASS:** C(T05), epoch ausente/vieja, era restaurada, FROZEN/REVIEW, callback tardío, invocación directa, tenant ajeno y cambio entre check/commit. Spies Telegram/MASTER/INDEX=0 al rechazar, 0 writes parciales; LEGACY conserva baseline. P + matriz C10 sin ruta omitida.

**STOP/fallo:** INTEGRITY si toca transporte antes de guard; MEDIA corrige orden dentro del contrato, ALTA si no hay punto de cercado suficiente. **Revisión/permiso:** MEDIA, A; guard SQL no certifica revocación física G2. **Handoff:** tabla entrypoint→guard→test, contratos contexto y códigos, negativa unknown para T06.

## T06 — Consultas paginadas y endpoints de lectura

**Objetivo/responsable:** MEDIA, alta complejidad localizada en contratos nuevos r4; no rediseñar sort/UX. **Depende:** T05, C12 ya aprobada, V01; V02 aquí.

**Archivos:** `catalog/queries.js`, `routes.js`, índices aditivos, contratos tipados/manifest de API nuevos registrados por T01, tests queries/HTTP; proyecciones codec y descriptor ICU verificado.

**A/ALTA, antes de clientes:** fijar request/response/errores/auth/era/revision/CAS/idempotencia de create/status/cancel conjuntos, selección/rango/excepciones y flags DTO, facetas/activos/search, preview/bulk/rename y comandos musicales/cola. Definir separación membresía de orden, reconstrucción/ronda y semántica de consumo/replay. Mantener endpoints ya fijados de beats/resume/edge/legacy; nombres de los adicionales se registran aquí, no se inventan en UI. Manifiesto distingue interfaces entregadas aquí de implementaciones T07/T10/T14; mocks explícitos nunca endpoint exitoso ficticio.

**B/MEDIA:** implementar lectura C5+r2 §§3–5+V02; ICU und exacto y versionado, BPM binary64/clase, tags exactos/ANY/exclusión y q JS; HMAC/tupla/ordinal/count del mismo snapshot. Lectura Gallery SQL directa sin esperar membresía; implementar pasos de preparación <=240 invocables por arnés conforme r4, publicación READY validada; scheduling durable en T10. Facetas globales y count exacto según contratos, sin manifests/bytes.

**C/BAJA:** C12-Q01/Q02/Q03/B01/B02/L01, U02/N01/F01/F02, V02 y casos r4 (STALE/READY/crash/retry/cancel/contexto). C(T06), EXPLAIN ANALYZE/BUFFERS sobre sintéticos, 100k/1M para seek V02 sin convertirlo en certificado C11; edge/cursor ambiguo rechazado. Verificar ICU real no colación default del probe.

**PASS:** P + resultados globales, límites UTF8, 0 transporte aun caído, tuplas correctas y contratos nuevos completos antes de consumidor. G3/G4 globales aún pendientes. **STOP/fallo:** CONTRACT si forma falta; DESIGN-A por proveedor ICU incompatible; PERF por seek/count; MEDIA bug query/índice, ALTA estrategia/contexto insoluble. **Permiso/revisión:** A; ALTA revisa A una vez, MEDIA B/C. **Handoff:** API/SQL/types versionados, ejemplos y negativos, manifests, EXPLAIN, implementaciones pendientes adscritas por T.

## T07 — PATCH, trash y restore con concurrencia

**Objetivo/responsable:** MEDIA, dificultad media-alta por commits atómicos/bulk; contrato ya fijado. **Depende:** T06; r4 selección/bulk/rename servidor, facetas. **Archivos:** `catalog/commands.js`, migración operations/events/selección-bulk según mapa, tests commands/concurrency.

**Orden:** A/MEDIA implementar C6/C5 bajo lock biblioteca→beats ordenados, raw/proyecciones/tags/facetas/counters/budget/events/resultados atómicos; no SSE antes de commit. Añadir selección CAS/rangos y freeze durable selectionVersion/payload, lotes <=50, journal+checkpoint+avance de revisión mismo commit, conflicto externo detiene siguiente lote. Rename preview ACTIVE/TRASH y mutación metadata sin alterar status/fechas/refs. Pasos de lote invocables, scheduler T10. B/BAJA casos de frontera y reportes (total/confirmado/no ejecutado/cancelado/conflicto) contra oracle T01, nunca windowItems.

**Pruebas/PASS:** C(T07), dos conexiones misma versión=un éxito/un conflicto; beats distintos ambos; edit/trash/restore, no-op/replay, keys distintas, fallo entre sentencias y counter drift. r4: respuesta perdida pre/postcommit, workers duplicados, cancel, conflicto después lote 2, selección stale y rangos superpuestos, rename a existente con TRASH intacto. P + 0 Telegram/MASTER/ID3, atomicidad por lote y ningún COMPLETED parcial.

**STOP/fallo:** INTEGRITY por estados/refs/counter o pérdida parcial; CONTRACT por rango/version no fijados; R y MEDIA para bug, ALTA nueva regla. **Permiso/revisión:** A, MEDIA; no bulk real. **Handoff:** contratos de comandos/pasos para T10, matriz transaccional, fixtures parciales y UI de conflicto para T13.

## T08 — Cliente de lectura, navegación y feed durable

**Objetivo/responsable:** MEDIA, dificultad media de integración estado/URL; V03–V05 aisladas. **Depende:** T07, V01 y V02 PASS. **Archivos:** `src/features/catalog/` lectura, adaptador Web, navegación/window/pager legacy, `useCloudLibraryEvents.ts`; módulos catalog del plan B.

**Orden:** resolver contexto antes de elegir autoridad; POSTGRES sin crear transporte INDEX; feed durable con SSE como aviso, resync bounded. Construir geometría V03, store V04 y grid V05 en fixture sin activar producto; queryGeneration/abort/late results, account/era/generation en cache; errores diferenciados. URL bgAnchor/legacy aprobada, scroll continuo; el paso antiguo de botones anterior/siguiente se aplica solo al protocolo/LEGACY.

**Paquetes:** MEDIA implementa estado/navegación; BAJA agrega escenarios DOM/counters conforme tipos T06 y V fixtures. No añadir espera de conjunto READY a apertura ordinaria Gallery.

**Pruebas/PASS:** C(T08), `npm run test:typecheck`; offline/401/503/empty/no-results, coincidencias después240, evento perdido/410, cursor stale y una recuperación por generación, cuenta A→B. V03–V05 completos dentro de fixture; P + Telegram fake que arroja nunca llamado por metadata, legacy intacto. No PASS de activación T16.

**STOP/fallo:** BUDGET/NAV/LAYOUT con E; MEDIA corrige wiring/aritmética, ALTA si diseño fijo falla; UX si pager POSTGRES. **Revisión/permiso:** MEDIA, A. **Handoff:** tipos/store/API, medidas CSS reales, presupuestos observados/pendientes, casos T08 y frontera de composición todavía apagada.

## T09 — Intenciones, reservas y máquina de estados

**Objetivo/responsable:** MEDIA, dificultad media; C7 define transiciones, no se necesita ALTA por importancia de cuota. **Depende:** T08. **Archivos:** migración operations/parts/reservations/jobs según plan, `catalog/operations.js`, endpoints C5 y tests operaciones/cuota.

**Orden:** A/MEDIA completar máquina durable con transiciones guardadas en repositorio, reserva bajo lock y Access inyectado; random_id int64 como string persistido con sender/partKey/dispatch antes del efecto. Recibo candidato != VERIFIED, commit responde 202 mientras falta verificación. B/BAJA implementar tabla de casos de contrato; no activar transporte. Integrar operations metadata previas sin confundirlas con direct_operations INDEX.

**Pruebas/PASS:** C(T09), última plaza con dos imports=solo una reserva; tombstone, cancel/expire/renew, downgrade, key/body distinto, replay COMMITTED y callbacks viejos. P + counters únicos, no resurrección ni recibo de cliente usado como prueba remota, 0 bootstrap INDEX.

**STOP/fallo:** INTEGRITY si cuota/estado diverge; CONTRACT si transición no descrita; R/MEDIA para implementación, ALTA nueva transición con efecto incierto. **Permiso/revisión:** A, MEDIA. **Handoff:** tabla transición→guard→test, IDs/checkpoints y jobs, contratos para worker/transport con verificación real pendiente T11.

## T10 — Worker con leases y pruebas de caída

**Objetivo/responsable:** MEDIA, dificultad media-alta por concurrencia y recuperación; diseño C8 cerrado. **Depende:** T09. **Archivos:** `catalog/worker.js`, repo jobs, `cloud-server/catalog-worker.js`, pruebas worker/faults; conectar pasos membresía/bulk de T06/T07.

**Orden:** MEDIA claim <=10, lease 60s/generación, concurrencia 2 global/1 biblioteca para efectos, release SQL antes de transporte; checkpoint condicionado, dispatch incierto a RECONCILE. Renovación/backoff/FLOOD_WAIT y BLOCKED según C8; shutdown deja estado durable. BAJA automatiza pausa/muerte en cada frontera y captura recursos. Verificar BUILDING→READY/STALE y bulk tras reinicio sin recalcular miembros.

**Pruebas/PASS:** C(T10), dos procesos nunca confirman mismo job con token viejo; fake lento 30s y metadata sigue; crash antes/después de claim/dispatch/receipt/commit; pool/locks de operación remota liberados. P + recovery exacta en PostgreSQL aislado, health/backlog; no G2 real.

**STOP/fallo:** INTEGRITY por checkpoint duplicado, TRANSPORT por retry de envío incierto; MEDIA bug lease, ALTA si protocolo no puede cercar efecto. **Permiso/revisión:** A, MEDIA; entrypoint apagado por defecto. **Handoff:** jobs reales registrados, campañas fault/restart, métricas, instrucciones seguras de runner para T11/T12.

## T11 — Resolver el contrato real de Telegram

**Objetivo/responsable:** ALTA, dificultad alta abierta: el plan no demuestra reconciliación SDK ni revocación física de auth keys. **Depende:** T10; sandbox explícito, no bots productivos/compartidos reales. Aporta G2.

**Archivos:** SDK/locks instalados solo lectura inicial, futuro `scripts/catalog-transport-contract.cjs`, worker Web de prueba, informe adaptador preciso. **Orden:** A/ALTA formular experimentos/expected y límites por identidad/sesión; MEDIA construir harness seguro bajo ese contrato y BAJA preparar fixtures/checklists. Terminar paquete con comandos reales y efectos antes de solicitar permiso de sandbox faltante. B ejecutar solo sandbox autorizado: Direct y MASTER PROJECT, reinicio/reconexión, send aceptado/respuesta perdida, random_id mismo, receipts duplicados/cero/múltiples, mismo filename distinto archivo; sesión antigua ya emitida y pin/edit/delete propios/ajenos, bot compartido de laboratorio. C/ALTA decidir condición exacta para reenvío/reconcile/BLOCKED y cercado, versionada.

**Pruebas/PASS:** runner de experimento creado/verificado, C(T11) lo referencia; evidencia proveedor real, SDK/locks, IDs redactados, ventana real de deduplicación y tabla de errores. P + ningún acceso destructivo antiguo sobre medios retenidos tras procedimiento probado. No extrapolar ventana indefinida.

**STOP/fallo:** APPROVAL sin sandbox; TRANSPORT si resultado incierto/fence insuficiente, conservar BLOCKED y alternativas, no cambiar SDK o rotar bots por intuición. **Revisión/permiso:** ALTA G2, usuario sandbox/identidades; nueva estrategia se prueba antes del piloto. **Handoff:** receta exacta SDK/Long/errors/reconcile y fencing con pruebas; T12 mocks solo por encargo expreso si T11 sigue STOP, sin PASS ficticio.

## T12 — Conectar transferencias y PROJECT a operaciones

**Objetivo/responsable:** MEDIA, dificultad media-alta por rutas de bytes existentes; contrato proveedor ya cerrado. **Depende:** T11 PASS o encargo limitado a mocks expresamente etiquetado, que no habilita G2. **Archivos:** `catalog/transport.js`, Web worker/protocol/session, `project-upload-authority.js`, `project-upload-route.js`, adaptadores MASTER.

**Orden:** MEDIA aplicar C7 usando randomId/recibo por parte de T11 y tenant/vault, intención PROJECT antes de enviar; separar transacciones/red/temporales, conservar Access/admisión/strip y transporte existente. Commit solo tras verificación de partes, retener anteriores/nuevos no vinculados en conflicto. BAJA casos de respuestas perdidas, reselección y cancelación según manifest; no cambiar SDK ni convertir PROJECT a Direct genérico.

**Pruebas/PASS:** C(T12), typecheck y suites PROJECT admission/route/master-message auditadas; perdida en reserve/upload/receipt/commit, downgrade, replace stale, multipart histórico, archivo distinto reseleccionado, cancel upload, temporal perdido. P + 0 cliente SQL retenido durante hash/send/verify; nivel PROVIDER/BYTES veraz y G2 real para activación.

**STOP/fallo:** TRANSPORT ante caso fuera de T11; MEDIA integración rutinaria, ALTA investigación nueva, usuario permiso de proveedor. **Revisión/permiso:** MEDIA, A; mocks no producción. **Handoff:** adaptadores/contratos, receipts sintéticos, métricas de recursos y errores UI para T13.

## T13 — Cliente de mutaciones sin INDEX

**Objetivo/responsable:** MEDIA, dificultad media por UX/cancelaciones y operaciones; V07-A aquí. **Depende:** T12, V00-A/B, V04, contratos T06/T07. No depende de T14 ni de V07-B.

**Archivos:** `catalogMutations.ts`, `webBeatEdit.ts`, `webImportCommit.ts`, `webTrash.ts`, `webGalerCloudTransport.ts`, `webAdapter.ts`, InteractionStore/bulk/drawer/tagRename según V07. **Orden:** metadata PATCH y transferencias operations/receipt/commit; detalle SQL para versión, sin INDEX. Conservar ID3/ZIP/progreso. Selección token/count server-side, Shift/Select All/excepciones y aviso condicional r4; sort preserva selección/reinicia ancla. Bulk reporta por lote, cancel no revierte confirmado; rename ACTIVE/TRASH y facetas globales. Persistir referencia de operación por cuenta sin tokens/secretos; purge muestra pendiente. BAJA implementa casos DOM parametrizados; MEDIA integra y cierra V07-A.

**Pruebas/PASS:** C(T13), typecheck; conflicto preserva draft/no PATCH auto con nueva versión, retry misma operación, reload, cuenta, cuota, retain tras conflicto; bulk desde Drawer con versiones/legacy no editado, stale selección bloquea; operación evictada no se pierde; rename parcial nunca éxito total. P + get_index/replace_index=0 en todas mutaciones POSTGRES.

**STOP/fallo:** INTERACTION/CONTRACT si falta manifest, INTEGRITY por selección parcial/estado TRASH; MEDIA bug UI, ALTA contrato ausente. **Permiso/revisión:** A/MEDIA; sin activación Gallery completa. **Handoff:** V07-A completo, mocks/casos para T14, contrato status/cancel/progreso y fuentes independientes de ventana.

## T14 — Playback, artwork y descargas desde referencias SQL

**Objetivo/responsable:** MEDIA, dificultad alta de integración con algoritmo ya decidido; ALTA solo escalamiento demostrado. **Depende:** T13, V04 y contrato musical T06-A; V06/V07-B.

**Archivos:** `catalogLibrary.ts`, `webDownloads.ts`, routing/decorators/loadArtwork, playback queue/controller/cache/startup/registry, nuevo PlaybackSession y persistencia de ronda en servidor según mapa r4.

**Orden:** MEDIA A separa currentBeat/cola/media del grid y valida owner/era/epoch/beat/fileVersion/Access; startup <=14. Implementa Next/Previous global sobre nuevo query, prioridad cola en Next/ended, seek Previous >0,05 y no consumo de cola en Previous. B implementa Fisher–Yates perezoso persistido tal como r4 §5: RNG uniforme por rejection, swaps/inverso/consumidos, lock, sequence CAS, resultado idempotente; commit antes de media. Revisión reconstruye conjunto preservando consumidos; filtros nueva ronda/sort conserva consumidos; repeat/fin exactos. C BAJA prepara oracle de rondas sintéticas y campañas fijadas; integra V07-B coexistencia sin retener ventanas.

**Pruebas/PASS:** C(T14), typecheck, suites playback auditadas; C12-P01/P02 y V06, play/seek/replace, lazy artwork, multipart completo/hash/tamaño, denied/trash/restore, logout/cuenta. r4 N=0/1/2/240/100k/1M, caminos RNG exhaustivos N pequeño y prueba estadística con umbral prerregistrado, swap inverso, replay/duplicados/crash/cambio revisión/cola/actual/fin/repeat. P + ninguna repetición automática por ronda, sin llamada RNG m=0, 0 release por eviction, cache bounded, fallo transporte conserva target.

**STOP/fallo:** PLAYBACK/SHUFFLE/INTEGRITY; MEDIA corrige algoritmo contra oracle, ALTA si r4 no realizable o perf exige alternativa (STOP-SHUFFLE-PERF). No historial ilimitado, fallback INDEX ni repeticiones para pasar. **Permiso/revisión:** A/MEDIA; validación perf completa sigue T20. **Handoff:** V06/V07 completo, fuente/owners y manifests, tests exhaustivos/stat método, métricas iniciales sin venderlas como SLO.

## T15 — Purge durable, retención y limpieza segura

**Objetivo/responsable:** MEDIA, dificultad media-alta; C9 ya prescribe seguridad, por eso ALTA no ejecuta rutina. **Depende:** T14. **Archivos:** migración purge, commands/worker/adaptador delete/journal, tests.

**Orden:** MEDIA capturar trash por revisión, enumerar todas referencias actuales/retenidas/metadata/parts/recibos/topics y generaciones; OPAQUE/shared/hold/retención bloquean. DELETING impide nuevos vínculos; journal fuera de DB confirmado antes del delete, sin SQL retenido; ausencia autorizada demuestra eliminación, no regex. Cuota solo al PURGED completo una vez. BAJA implementa matriz de fallos por parte/estado y objeto compartido con dobles; cleanup real apagado.

**Pruebas/PASS:** C(T15), caída cada parte, 403/404/timeout/chat incorrecto, lease viejo, purge vs restore/replace/receipt, shared/topic ajeno/reserva huérfana/repeated purge, journal no disponible=0 delete. P + recuperación parcial exacta, 0 borrado retenido/referido, counters únicos.

**STOP/fallo:** INTEGRITY/TRANSPORT si incertidumbre o acceso destructivo no demostrado; MEDIA bug local, ALTA nuevas reglas de retención/borrado, usuario cualquier permiso real. Nunca liberar cuota antes ni ejecutar delete desde cliente. **Revisión/permiso:** A, MEDIA; G2 y G4 siguen necesarios. **Handoff:** manifest objetos/estados, evidencia de journal y guardas, procedimientos para T19 restore anterior a purge.

## T16 — Integrar arranque y cercado exhaustivo

**Objetivo/responsable:** MEDIA, dificultad media-alta por composition y middleware; V08 y V09. **Depende:** T15, V05/V06/V07 completos. **Archivos:** server/server-core/authority/capabilities/startup-routing/publication/recovery/worker legacy, AppShell/Workspace y providers por autoridad.

**Orden:** MEDIA V08 compone ramas con hooks estables, sin array global/pager POSTGRES; guardas C10 en entradas/helpers/catch y wrappers, schema/protocol antes de efectos. Startup POSTGRES no ensureAll/recoverAll/migrateLegacyProjects; LEGACY conserva recorrido. BAJA V09 prueba navegador/accesibilidad/visual y regresa inventario buscando nuevas entradas. MEDIA verifica cobertura y emite G3 de alcance probado, sin confundir clientes simulados con auth keys T11.

**Pruebas/PASS:** C(T16), dos bibliotecas LEGACY/POSTGRES, restart cloud/worker, Telegram caído y REVIEW aislada, cliente Web/worker/Desktop viejo incompatible antes de writes; V09 0 skips y todos casos del plan B §9 aplicables. P + cero recuperación INDEX POSTGRES, flags off, unknown fail-closed, UI/auth intactas.

**STOP/fallo:** INTEGRITY por ruta sin fence, UX por función perdida, CONTRACT por provider mezclado; MEDIA integración, ALTA ausencia de frontera segura. **Permiso/revisión:** A/MEDIA G3; no desplegar. **Handoff:** consumer-map actualizado, manifest middleware/proveedores, V09 capturas/lector/counters, dictamen G3 para CLI/candidato.

## T17 — CLI de sombra, freeze, corte y reversión

**Objetivo/responsable:** MEDIA, dificultad media-alta; procedimiento M/R cerrado, comandos deben materializarlo. **Depende:** T16. **Archivos:** futuro `cloud-server/scripts/catalog-migration.cjs`, `catalog/migration.js`, tests CLI/restart y MIGRACION con ayuda/comandos reales.

**Orden:** MEDIA implementa todos subcomandos originales (inspect/import-shadow/compare/freeze/drain/validate-final/cutover/export-rollback/publish-rollback/return-legacy/resume) con dry-run default, apply/run/owner/vault/era/epoch/descriptor explícitos y checkpoint durable. M3 drain incluye operaciones legacy/remotas inciertas, no lista local vacía. R2 export actualizado/publicación privilegiada fuera de SQL y conciliación antes de authority. BAJA añade parser/guards/ayuda y fallos por cada checkpoint conforme manifest; nunca inventar comando aplicado en doc.

**Pruebas/PASS:** C(T17), C12-M01/M02; dry-run sin efectos, parámetros faltantes/placeholder/epoch/SHA/hash incorrectos, snapshot distinto, reinicio/replay, export fuera de cota, callback viejo y corte sin validación rechazados. P + autoridad inequívoca y no vaciado ante error; ayuda real documentada.

**STOP/fallo:** CONTRACT si comando exige decisión faltante; INTEGRITY por checkpoint/authority ambiguos; APPROVAL ante real. MEDIA bug de CLI, ALTA nueva secuencia/rollback; no SQL manual ni helper publish antiguo saltando guard. **Revisión/permiso:** A/MEDIA. **Handoff:** CLI probada, manifest M0 concreto para ensayo, fault matrix y procedimiento contención para T18/T21.

## T18 — Ensayo completo de migración y rollback con nuevas escrituras

**Objetivo/responsable:** BAJA, dificultad media de ejecución secuencial; T17 debe dejar receta cerrada, MEDIA evalúa evidencia independiente. **Depende:** T17, fixtures completas; Telegram falso/PG desechable, fase proveedor con permiso aparte.

**Archivos/salida:** suites/artefactos de ensayo T18, fixtures T01, CLI T17, MIGRACION. No modificar producto para hacer pasar escenario sin clasificar defecto.

**Orden:** sombra→compare→freeze→drain→snapshot final→corte; comprobar 0 copia/movimiento medios. Crear beat/editar/replace/trash/restore; dejar RPC incierta y demostrar drain bloqueado, resolver por protocolo. Export/publicar/return legacy actuales; usar lector legacy del código como oracle adicional, no exportador contra sí mismo. Crash entre publish/return y reanudar; probar cota antes del commit.

**Pruebas/PASS:** C(T18), todas fases M/R, nuevas escrituras conservadas y partes/tombstones/cuotas íntegros; export >15 MiB y máximo legacy 16 MiB con guardas, sin fallback a snapshot viejo. P + reporte por fase, distinguendo dobles/proveedor. Contribuye G4, no lo cierra solo.

**STOP/fallo:** DATA/INTEGRITY ante diferencia; BAJA R si script/fixture cerrada, MEDIA CLI/codec, ALTA rollback no representable, usuario proveedor. No retry ciego ni reparar snapshot. **Revisión/permiso:** MEDIA lector independiente, A. **Handoff:** logs/checkpoints/hashes por fase, diff semántico, evidencia de rollback con writes para T19/T21.

## T19 — Backup, restauración y journal de purges

**Objetivo/responsable:** MEDIA, dificultad media-alta por DB/journal/bytes/era. **Depende:** T18, backend aprobado o dobles explícitos. **Archivos:** `catalog/backup.js`, harness backup/restore/manifests, runbook; no provisionar AWS.

**Orden:** MEDIA snapshot/export con hash lectura; restore aislado sin workers/credenciales, restore_hold por política externa y era nueva. BAJA ejecuta A backup→replace/purge→restore A, carga journal posterior; verifica cada parte y bytes de backup. Ausencia irrecuperable bloquea, no «presente» por fila SQL. Medir RPO/RTO reales del entorno y cobertura metadata vs medios. Backend/PITR concreto requiere descriptor/contrato; si falta no lo inventar.

**Pruebas/PASS:** C(T19), C12-R01, corrupt/missing backup, Telegram inaccesible, journal incompleto, sesión/lease era antigua y copia de bytes íntegra. P + hashes/retención/restore correctos y objetivos C12 medidos; G4 real pendiente si entorno no representativo. No prometer recuperación de Telegram sin copia verificada.

**STOP/fallo:** ENV por destino restore no aislado, INTEGRITY por medio faltante, CONTRACT por backend nuevo; MEDIA wiring, ALTA reparación/estrategia, usuario recursos/permisos. No retirar hold ni activar workers para probar a ciegas. **Revisión/permiso:** MEDIA G4 parcial, A; backend real requiere permiso. **Handoff:** coverage/hashes/RPO/RTO y journal, runbook ensayado con limitaciones para T20/T21.

## T20 — Capacidad, latencia y contención

**Objetivo/responsable:** BAJA, dificultad media de campaña especificada; MEDIA tuning solo si falla, ALTA arquitectura solo si necesario. **Depende:** T19/V09, perfil C11-LAB-v1 completo; V10 aquí.

**Archivos:** generador sintético, futuro `scripts/catalog-benchmark.cjs`, runner manifest/perf y reportes. **Orden:** comprobar recursos/digest/config del perfil, semilla777/datasets; registrar preparación índices/membresía/disco/WAL y rebuild ICU por separado. Ejecutar frío/caliente, warmup2min/muestra10min, 20 clientes/2 transfers; todas queries/filtros/count/legacy/deep/contención. V10 mide UI, scroll/backtracking, soak≥20min y recursos de ronda/selección/facetas/cleanup; no cargar N IDs en cliente de prueba. BAJA calcula series/percentiles/error y MEDIA verifica metodología, una optimización por cambio con rerun comparable si falla.

**Pruebas/PASS:** C(perf), C12-X01/V-PERF y r4 §5/7; p95 metadata/PATCH≤250ms, p99 metadata≤1s, memoria inicial y steady-state del perfil≤20MiB de delta, bytes≤2MiB, 0 SQL retenido/red metadata; budgets plan B completos, frame/soak y rondas completas 100k/1M. P exige todos perfiles obligatorios, sin skips ni ocultar errores como respuestas rápidas.

**STOP/fallo:** ENV si hardware falta; PERF/BUDGET con crudos/EXPLAIN; SHUFFLE-PERF si preparación/disco/reconstrucciones incumplen. BAJA no ajusta SLO/N; MEDIA fuga/índice, ALTA nueva estrategia o writers impiden READY, usuario nuevos recursos. **Permiso/revisión:** A, MEDIA metodología/G4. **Handoff:** reporte por perfil y primer target frío/caliente, traces/hashes y coste O(N) disco explícito, lista de incumplimientos sin rebaja.

## T21 — Preparar candidato y revisión de alta capacidad

**Objetivo/responsable:** ALTA, revisión crítica final expresamente exigida por plan, dificultad alta de juicio, no ejecución rutinaria. **Depende:** T20/G2 real/G3; V11-A consume V10, G1 sintético y evidencia G4 de laboratorio representativo, no depende G1 real T22.

**Archivos/salida:** paquete candidato con SHA/hash dirty si aún no commit, migraciones, flags, versiones puente, manifiestos, CLI/runbooks y diferencias respecto del desplegado observado. **Orden:** A/BAJA corre C(all-local), `npm run test:typecheck`, `npm run build:web`, diff check; todas regresiones auditadas del original y V09 por impacto. Produce índice de evidencias G0–G4, sin claims derivados solo de resúmenes. B/ALTA revisa contrato/mapa/esquema/fallos/aislamiento/rollback/Shuffle y riesgos irreversibles; emite GO/NO-GO técnico por puerta. C/MEDIA corrige hallazgos delimitados, BAJA repite afectados y refresca candidato; contrato cambiado reabre gate afectado.

**Pruebas/PASS:** P + paquete completo, todas suites requeridas y review hallazgos críticos cerrados, runtime observado no inferido de docs. Prohibido placeholder `cloud-server npm test`. Una autorización faltante no convierte paquete listo en permiso; reportar STOP-APPROVAL para ejecución real.

**STOP/fallo:** TEST→MEDIA según R, diseño/riesgo→ALTA; permiso→usuario solo con paquete listo. **Revisión/permiso:** ALTA por candidato, usuario despliegue/lectura real posterior. **Handoff:** comandos existentes con target/efecto y contención, GO/NO-GO por gate, permisos aún faltantes para T22.

## T22 — Sombra real autorizada

**Objetivo/responsable:** BAJA, ejecución de M1–M2 cerrados, dificultad media operativa; no interpreta divergencias. **Depende:** T21, permiso explícito puente/expansión y captura/import de biblioteca específica. V11-B.

**Entradas/salidas:** paquete T21/M0, CLI T17 ensayada, estado runtime/DB observado autorizado, snapshot protegido; reporte G1 real por biblioteca. **Orden:** verificar autorización/target/SHA/era/epoch; desplegar versión compatible con flags off solo según comandos revisados; confirmar instancias/esquema/backups; capturar pin/SQL/ledger/tombstones/recibos estable sin recover reparador; importar STAGING y comparar todos paths. No cambiar autoridad, pin o bytes. MEDIA evalúa G1 real contra fuente y lector, no conteos únicamente.

**Pruebas/PASS:** checks reales M1/M2 y smoke autorizado, hashes/pin antes/después, comparación completa/no pérdidas, 0 mutación legacy/medios. P + informe elegibilidad de esa biblioteca, no de otras. No prueba destructiva real para fencing.

**STOP/fallo:** APPROVAL/BASE/ENV antes de efectos; DATA/TRANSPORT por snapshot inestable/operaciones desconocidas; BAJA conserva REVIEW, MEDIA diagnostica, ALTA contrato/autoridad incierta. No recaptura reparadora ni adopta snapshot inconsistente. **Revisión/permiso:** MEDIA G1, usuario indispensable; T23 permiso separado. **Handoff:** manifest/hash/era/epoch y compare, inventario procesos/clientes, elegibilidad/pendientes.

## T23 — Piloto autorizado de una biblioteca

**Objetivo/responsable:** MEDIA, dificultad media-alta de operación y diagnóstico bajo runbook cerrado; ALTA solo incidente crítico nuevo. **Depende:** T22, G0–G4 y permiso de corte por user/vault/era/epoch, capacidad de contención. V11-C.

**Entradas/salidas:** M0 real final, M3–M5, paquetes G1–G4/CLI, medios de prueba autorizados; informe piloto y observación. **Orden:** verificar instancias puente y sesiones, freeze/drain/fencing, capturar snapshot final nuevo y repetir compare/export/cotas, corte SQL atómico; inspeccionar resultado perdido antes de reintentar. Smoke de funciones aprobadas; cleanup off. BAJA registra métricas/alertas durante ventana de 48h propuesta por plan y fijada en manifiesto; no reducirla durante ejecución.

**Pruebas/PASS:** lectura/global/filtros, metadata, import/replace/trash/restore, play/seek/download/auth; una autoridad, epoch/callbacks correctos, reversión actual disponible y cero alertas de integridad durante observación. P + todos M3–M5 y G4 representativo; smoke real no reemplaza T11 sandbox.

**STOP/fallo:** cualquier precondición M3/M4→sin corte; INTEGRITY/TRANSPORT→contención autorizada, MEDIA determina estado, ALTA estrategia nueva; usuario efectos adicionales. Nunca rollback a snapshot viejo, limpieza automática o reset métricas. **Revisión/permiso:** MEDIA técnico, usuario corte. **Handoff:** timeline/checkpoints/autoridad/smoke/observación y capacidad rollback, permiso de cohorte todavía faltante.

## T24 — Cohortes y habilitación controlada de limpieza

**Objetivo/responsable:** BAJA, dificultad media con runbook probado; MEDIA verifica anomalías y recuperación. **Depende:** T23 + permiso por lista/cohorte y cleanup independiente. **Entradas/salidas:** M6, manifests por biblioteca, backup/retención/journal y G2, reporte individual.

**Orden:** lista explícita máximo inicial5; cada biblioteca repite M2–M5 y snapshot final, sin heredar G1 ajeno; observar≥24h cada cohorte. REVIEW no se sobrescribe. Preparar y comprobar condiciones de cleanup (backup, retención, ventana reversible, restore_hold, referencias/journal); solo activarlo con permiso específico. BAJA puede cerrar tarea con cleanup apagado, como original, y debe declararlo.

**Pruebas/PASS:** verificación por biblioteca, SLO/integridad/smoke, restore/rollback vigentes; no confirmar cleanup por mero flag. P + reporte de cada identidad/estado/permiso/observación, cero bibliotecas REVIEW tratadas como migradas.

**STOP/fallo:** APPROVAL si lista/efecto no autorizado, INTEGRITY/PERF si regresión; BAJA no amplía cohorte ni modifica timeout, MEDIA diagnóstico/contención, ALTA recuperación nueva. **Revisión/permiso:** MEDIA valida evidencia, usuario cada cohorte/cleanup. **Handoff:** lista migradas/excepciones, retenciones/ventanas, estado cleanup exacto y elegibilidad T25. T25 no requiere haber borrado medios.

## T25 — Cerrar reversibilidad y retirar dependencias activas de INDEX

**Objetivo/responsable:** BAJA, dificultad media probatoria; runbook acotado y revisión MEDIA, no diseño de eliminación. **Depende:** T24, bibliotecas elegibles migradas/excepciones explícitas, ventana terminada y autorización para cierre.

**Entradas/salidas:** consumer-map T16 actualizado, telemetría por autoridad, manifests/ventanas/backups/runbooks; documentación operativa y registro de cierre por biblioteca. **Orden:** verificar 0 rutas runtime POSTGRES usando INDEX con inventario+telemetría, conservar LEGACY para excepciones; conservar snapshots/codecs/journals durante retención. Confirmar bloqueo cliente antiguo, rollback binario solo puente y backups/restore/ownership alertas. Solo retirar cota reversible de biblioteca cuyo cierre esté autorizado. Si hace falta código de retirada no especificado, MEDIA define patch dentro del contrato antes de BAJA; no DROP ni delete histórico.

**Pruebas/PASS:** matriz de rutas por autoridad y regresiones afectadas vía runner existente auditado, smoke, evidencia recurrente backup/restore y ausencia de dependencia INDEX POSTGRES; count de pendientes/excepciones explícito. P final solo si requisitos completos; entrega parcial si REVIEW, nunca todas migradas ficticias.

**STOP/fallo:** INTEGRITY por dependencia activa, APPROVAL por ventana/retirada no autorizada, CONTRACT si requiere subplan de eliminación. MEDIA patch/diagnóstico, ALTA nueva estrategia postreversión; usuario permiso irreversible. **Revisión/permiso:** MEDIA verifica cierre, usuario autoriza cada retirada de ventana/cota; no por calendario. **Handoff final:** evidencias/hash/estado por biblioteca, retención, alertas y recuperación operativa, excepciones con dueño y ninguna tarea oculta.
