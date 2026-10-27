# Auditoría técnica integral del núcleo — Paso 1 recomendado hacia V1

> **Ámbito:** BeatGaler Web + Cloud, exclusivamente. **Estado:** plan de investigación sustentado en una inspección estática de código; NO es una auditoría ejecutada, una certificación de V1, un backlog obligatorio ni una autorización para modificar código o producción.
>
> **Corte de código observado:** `main` @ `10ae1908d947cc4f6981469f9a722936ec3ee57e` (27-10-2026). **Producción distinta:** `v0.9.0-beta.2` @ `a8418223527f88e9d34db8e05abb10216942013c`. Validar de nuevo SHA y rutas si `main` cambia.
>
> **Prioridad:** este es el trabajo recomendado n.º 1 en [DIRECTION.md](DIRECTION.md); no adelanta obligatoriamente los trabajos 2–5. Los planes de implementación de cada cambio se preparan **después** de confirmar problemas y criterios de aceptación.
>
> **Regla innegociable:** no hacer pruebas destructivas, mutaciones en bases, llamadas reales a Telegram, tests de carga, despliegues, cambios de permisos o de secretos sin aislamiento comprobado y autorización explícita. Ver [Issue #133](https://github.com/magosouljah/BeatGaler/issues/133). No reabrir el incidente EC2 del 27-10-2026 como parte de este frente: permanece documentado/en observación.

## 1. Objetivo, preguntas y resultado esperado

Entender exactamente quién es autoridad de cada dato, qué hace Web, Cloud, PostgreSQL, MASTER y cada Transport Bot; qué puede fallar bajo concurrencia, reintentos, caída de un proceso, Telegram degradado, varias instalaciones y muchos usuarios; cómo se recupera sin pérdida o resurrección de datos; y qué evidencia falta para afirmar que el núcleo es seguro, rápido, comprensible y escalable.

La auditoría **no** comienza reescribiendo la arquitectura ni sustituyendo MASTER: primero debe reconstruir la ruta de **publicar, fijar, leer, reemplazar, reconciliar y eliminar INDEX**, incluidas todas las rutas heredadas. Después evaluar integridad, aislamiento, coordinación, capacidad y operación. Cada conclusión se clasifica `CONFIRMADO POR CÓDIGO`, `CONFIRMADO POR PRUEBA AISLADA`, `CONFIRMADO POR MEDICIÓN`, `HIPÓTESIS` o `NO VERIFICADO`, con SHA, ruta, línea y evidencia reproducible.

Entregables de cierre: (a) mapa de responsabilidades y flujo real por caso de uso; (b) inventario de invariantes, permisos, estados y límites; (c) matriz de riesgos con severidad, posibilidad y evidencia; (d) matriz de pruebas seguras / fallos / concurrencia con resultados; (e) mediciones de latencia, colas y capacidad, señalando entorno; (f) propuestas de corrección con trade-offs y prioridades, **sin ejecutarlas automáticamente**; (g) decisión fundamentada de qué es bloqueo para V1, qué puede esperar y qué no necesita tocarse.

## 2. Mapa técnico preliminar (no equivale a certificación)

```text
Navegador React / TypeScript / Vite
  ├── UI, biblioteca, reproducción, subida, cachés
  ├── Worker @mtcute/web ────────> Transport Bot ─────> Vault Telegram privado
  │                                (lectura/media)       ├─ beats/archivos
  │                                                      └─ INDEX fijado
  └── HTTPS / Cloud API (Express / Node)
       ├── login, sesiones, permisos/capabilities, cuotas, Access
       ├── coordinación Direct, asignación, idempotencia
       ├── INDEX publish/purge ───> MASTER (GramJS) ───> Vault / pin / borrado
       ├── PROJECT upload bytes ──> MASTER ────────────> Vault
       ├── reconciliación / operaciones / estado durable
       └── PostgreSQL (control-plane, punteros, ledger, reservas, jobs)
```

El INDEX Telegram es autoridad lógica de biblioteca/Trash/tombstones; PostgreSQL da autoridad durable a identidad, ownership, permisos, cuotas, punteros y reconciliación; Telegram guarda los medios físicos. No confundir estas fuentes de verdad ni interpretar un estado parcial como permiso de borrar.

### Rutas y responsabilidades observadas

| Elemento | Evidencia verificada en `main` | Límite de la conclusión |
| --- | --- | --- |
| Publicación Web del INDEX | `src/features/cloud/webGalerCloudTransport.ts:250–259` delega en `publishWebTransportIndex`; `src/features/cloud/webTransportSession.ts:632–649` llama `/transport/index/publish`. | Camino principal trazado; falta barrido de todos los productores, handlers y feature flags. |
| Gate Cloud de publicación | `cloud-server/server-core.js:2293–2314` exige autenticación, scope `replace_index`, capability y usa `libraryIndexPublication.publish`. | Auditar todas las rutas indirectas, identidad, expiración, revocación y carreras. |
| MASTER publica/fija | `cloud-server/library-index-publication.js:196–416` llama `transport.publishIndexBuffer`; `cloud-server/direct-transport-control.js:1699–1709` prepara publicación por MASTER. | Demostrado en camino Cloud inspeccionado; no inferir coste o saturación. |
| Worker lee INDEX | `src/features/cloud/webTransport.worker.ts:2308–2505` hace lectura prioritaria, reintentos y recuperación. | Medir races contra reemplazo y precalentamiento, no asumir que son fallos. |
| Ruta de escritura heredada | `src/features/cloud/webTransport.worker.ts:2529–2569`: `replaceLibraryIndex` aún envía, fija y trata de borrar el INDEX desde el bot. | **No está demostrado** que sea alcanzable desde el flujo Web actual ni que el bot conserve los derechos necesarios. Trazar mensajes del Worker/exports/call-sites y permisos antes de calificarla como vulnerabilidad o código muerto. |
| Permisos Transport Bot | `cloud-server/direct-transport-control.js:710–713` declara `pinMessages:false`, `deleteMessages:false`, `editMessages:false`. | Probar derechos efectivos en Vaults nuevos y heredados; no asumir estado real desde declaración. |
| Reparación de derechos READY | `cloud-server/direct-index-pin-authority.js:9–59` y `cloud-server/direct-persistent-session-runtime.js:187–192`: garantizar restricción antes de devolver credencial temporal. | Evaluar fallos parciales, reintento y ventanas temporales entre Telegram y SQL. |
| Puntero / concurrencia INDEX | `cloud-server/vault-index-pointer-store.js` y `cloud-server/atomic-library-index.js` ofrecen contratos de puntero/actualización atómica; `library-index-publication.js` usa `expectedMessageId`, SHA y ledger. | Verificar secuencia de commit, crash, conflictos entre procesos y reversión. |
| Protección de borrado | `library-index-publication.js:270–380` exige purge verificado, protege tombstones y solicita verificación de borrado externo. | Verificar ningún otro endpoint/worker puede evadirlo; reconstruir casos Trash → purge → restore. |
| PROJECT Web | `cloud-server/server-core.js:2276–2291`, `project-upload-route.js`, `project-upload-admission.js` y `project-upload-authority.js:28–95`: entrada de bytes por Cloud, temporal, límites, hash, MASTER, verificación y ledger. | No reintroducir el absoluto obsoleto «Cloud nunca toca bytes»; medir RAM, disco, cleanup y ancho de banda. |
| Upload tradicional | `cloud-server/legacy-media-upload-disable.js`: rutas legacy de media declaradas deshabilitadas/410 pese a existir parte del wiring anterior en `server-core.js`. | Comprobar montaje exacto y ausencia de bypass bajo tests aislados. |
| Access | `cloud-server/access-runtime.js`, `billing-access-resolver.js`, `server-core.js:1094–1125`: autorización backend, identidad y entitlements. | Auditar consumo de capacidades, **no** rehacer toda la política Billing en este paso. |
| Capabilities | `cloud-server/direct-capability-boundary.js:229–296`: concesiones activas/scoped en PostgreSQL, locks y verificaciones. | Probar tenant-boundaries, caducidad, revocación, replay, scope y fail-closed. |
| Asignación Direct | `cloud-server/direct-transport-control.js:343–383` mantiene estado JSON con lock de fichero (`.lock`) y espera síncrona `Atomics.wait`. | Confirmar semántica multiproceso/multihost, filesystem compartido, reaper y coste del bloqueo. |
| Serialización INDEX | `cloud-server/direct-transport-control.js:1352–1457` serializa `get_index`/`replace_index` **por chat/Vault**, no global por bot; cuenta generaciones de documento y reclaims. | Comprobar conflictos con otros endpoints, workers y procesos, y que distintas Vaults compartiendo bot progresan. |
| MASTER pool | `cloud-server/direct-transport-control.js:464–540` carga `masters`, `masterForVault`, registry; abre clientes GramJS por operación. | Medir sesiones simultáneas, costo de conexión/resolución, límites y failover. No afirmar que solo hay un MASTER ni que es cuello real. |
| Seguridad HTTP | `server-core.js:1094–1125` y middleware de transporte validan bearer, instalación y ownership. | Ejecutar matriz exhaustiva de API e instalación cruzada; revisar CSRF/CORS/origen/cookies y límites. |
| Readiness | `cloud-server/runtime-operability.js:74–103`: `/readyz` verifica estado draining y PostgreSQL con timeout. | Un 200 **no demuestra** que Telegram/MASTER/bots funcionen, ni confirma capacidad real. |
| Observabilidad | `cloud-server/OPERATIONS-OBSERVABILITY.md`, `operations-observability.js`, `operations-runtime.js` documentan instrumentación y contratos operativos. | No asumir paging externo, alertas y SLOs realmente conectados. |
| Estados de recuperación | `direct-operation-repository.js`, `index-reconciliation.js`, `garbage-journal-repository.js`, `garbage-reconciliation-worker.js` contienen fases/reconciliación durable. | Confirmar caller, scheduler, startup, reintentos, DLQ, idempotencia y cierre real del ciclo. |
| Cap histórico en SQL | `cloud-server/migrations/0001_control_plane.sql:115–143` incluye trigger de **4 leases activos por bot**. | Es migración histórica; cotejar esquema final y ruta de leasing actual **antes** de sostener que limita a 4 usuarios o contradice bot sharing. |
| Altas Free | En `main` nuevos usuarios empiezan Free; grants históricos `source='welcome'` sobreviven hasta expirar. | No atribuir el cambio a beta.2 publicada ni alterar grants históricos. [Política](BILLING-V1-POLICY.md). |

## 3. Hallazgos de riesgo — confirmado frente a pendiente

### Confirmado por lectura estática y de atención inmediata

1. **Prueba PostgreSQL potencialmente destructiva:** `cloud-server/tests/postgres-live.integration.cjs:32–49` obtiene `DATABASE_URL` del entorno (fallback `127.0.0.1/.../beatgaler_ci`) y ejecuta sin gate visible en ese fragmento `DROP SCHEMA public CASCADE; CREATE SCHEMA public`. Ejecutarla contra una DB equivocada destruye el esquema. **NO ejecutar ese archivo ni comandos agregados que lo incluyan** sin preflight externo ineludible, DB descartable y credenciales mínimas, según Issue #133.
2. **SQL abierto durante efectos Telegram:** `library-index-publication.js:196–416` hace `BEGIN` + `FOR UPDATE` de Vault/cuota y espera lectura/publicación/pin/verificación externa antes de `COMMIT`; `project-upload-authority.js:28–95` y `direct-index-pin-authority.js:9–30` exhiben patrón similar. Existe ventana de locks prolongados y transacción abierta; **no** está cuantificada la latencia ni demostrados deadlocks o saturación.
3. **Estado mixto de coordinación:** Direct usa mutaciones de JSON/fichero y lock síncrono, y PostgreSQL para otras autoridades. Verificar comportamiento bajo dos procesos, fallo de host, stale lock, restart, cambios concurrentes y split-brain; no declarar automáticamente que falla en un solo host.
4. **Dependencia privilegiada:** MAIN INDEX publish/pin y PROJECT Web pasan por Cloud/MASTER. No hay aún métricas de límites Telegram, flood waits, reintentos, coste por Vault, ni failover real; analizar antes de rediseñar.
5. **Código de reemplazo bot en Worker:** el código que pinnea/elimina existe y diverge del camino Cloud. Es **hallazgo de deuda/ambigüedad de rutas**, no bypass probado.
6. **Semántica limitada de `readyz`:** readiness sólo certifica las dependencias que comprueba, no Telegram end-to-end.
7. **Tests disponibles ≠ carga real:** `cloud-server/tests/stage1-multi-account-concurrency.test.cjs` usa recursos/mocks locales, escenarios de 3/10/80 sesiones, Vaults compartiendo bot y serialización; `cloud-server/tests/capacity-load-harness.cjs` es cola `setTimeout` sintética. Ninguno demuestra por sí mismo capacidad de 10/50/100 usuarios reales, latencia de Telegram ni comportamiento productivo.

### Riesgos abiertos: NO promover a «bug confirmado» sin evidencia

- Reachability de la escritura heredada del Worker y posibilidad real de fijar/borrar INDEX con bot en Vault existente.
- Pérdida o resurrección de beats/PROJECT/Trash/tombstones por timeout, doble envío, crash después de pin y antes de commit, borrado parcial o read-after-write.
- Falta de wiring efectivo de reconciliación de garbage: en la inspección preliminar no se identificó un caller externo inequívoco de `runGarbageReconciliationCycle`; verificar imports y rutas de startup antes de concluir que no corre.
- Cuello de botella por MASTER, Telegram, Cloud, PostgreSQL, estado JSON, conexiones, Worker, red o cuota del plan: requiere instrumentación comparativa.
- Fuga cross-tenant, capability replay/escapada de scope, token stale, sesiones cruzadas, bot compartido/instalación incorrecta: adversarial tests controlados.
- Limits reales EC2/RDS, readiness insuficiente para incidentes, saturación de disco temporal, conexión Telegram, colas/retry storms y faltas de alerta.
- Validez en esquema **actual** del trigger histórico de 4 leases.
- Duplicaciones, código muerto o logs inseguros: inventariar call-sites/build/config antes de borrar.

## 4. Bloques de investigación ejecutables (flexibles, no cronograma)

### Bloque 0 — Base segura, reproducción y protección de producción (precondición para ensayos)

**Objetivo:** reproducibilidad sin posibilidad de tocar datos, cuentas ni Telegram reales por accidente.

**Inspeccionar:** `package.json`, `cloud-server/package.json`, scripts de tests, `cloud-server/tests/*integration*`, `postgres-runtime-config.js`, `postgres-migrations.js`, workflows `.github/workflows/`, `docs/operations/`, controles de secretos, mocks y fixtures; Issue #133.

**Trabajo:**
- Fijar SHA de código y lockfile, mapa de variables, servicios, endpoints y secretos **por nombres, nunca valores**. Separar dev/test/prod con credenciales mínimas y redes distintas.
- Inventariar cada test/script como `unitario sin I/O`, `temporal descartable`, `DB con escrituras`, `destructivo`, `proveedor Telegram`, `pago/sandbox`, `producción prohibida`. No deducir seguridad por extensión `.test`.
- Preflight ejecutado **fuera del propio test**: base y host exactos allowlisted, identidad DB verificada, DB efímera propiedad del runner, usuario sin permisos en prod, rechazo por defecto de URLs desconocidas y nombre de DB de producción.
- Aislar storage local, puertos, archivos pool JSON y secrets; guardar artefactos sin PII y medir coste de tests. Prohibir `DROP SCHEMA` en DB no descartable.
- Antes de tests con Telegram, obtener aprobación específica para Vaults/bots de laboratorio sin relación con cuentas reales. Antes de backups/restores, DB temporal.

**Salida:** mapa de tests y dependencias; procedimiento de entorno seguro; ejecución **solo** de pruebas comprobadas inocuas; listado de ensayos bloqueados. **Bloqueador:** Issue #133 sin resolver para escrituras.

### Bloque 1 — MASTER, Transport Bots, permisos y ciclo completo del INDEX (primer análisis sustantivo)

**Objetivo:** saber exactamente quién puede escribir/pinear/borrar, en qué secuencia, con qué garantías y cómo se recupera.

**Rastrear:**
- Web: `src/features/cloud/webGalerCloudTransport.ts`, `webTransportSession.ts`, `webTransport.worker.ts`, `webTransportWorkerClient.ts`/call-sites reales si existen; startup, import/edit, Trash, cancelaciones.
- Cloud: `cloud-server/server-core.js`, `library-index-publication.js`, `direct-transport-control.js`, `direct-index-pin-authority.js`, `direct-persistent-session-runtime.js`, `vault-index-pointer-store.js`, `atomic-library-index.js`.
- SQL: `migrations/0014_vault_index_pointer.sql`, `0015_library_beat_quota.sql`, `0016_direct_index_pin_authority.sql`, `0025_fresh_vault_index_bootstrap.sql`; permisos efectivos de Telegram.
- Tests existentes: `library-index-publication.integration.cjs`, `fresh-vault-index-bootstrap.test.cjs`, `vault-index-pointer-store.test.cjs`, `direct-index-operation-liveness.test.cjs`, `direct-index-operation-document-context.test.cjs`, `master-index-flood-wait.test.cjs`, `master-storage-recovery.test.cjs`.

**Preguntas obligatorias:**
1. ¿Qué ruta se ejecuta realmente para primer INDEX, editar beat, guardar, borrar a Trash, purge, revertir y recuperarse de Vault vacío/existente?
2. ¿Se invoca alguna vez `replaceLibraryIndex` en el Worker? ¿Puede un mensaje público/de Worker llegar a ella? ¿Qué permisos reales tiene el bot en READY antiguo y nuevo? ¿Cómo se evitan bypasses?
3. ¿Puede MASTER publicar el mismo INDEX dos veces por timeout? ¿Cuándo se verifica el pin? ¿Cuándo se elimina el INDEX anterior? ¿Qué pasa si Telegram confirma y el commit SQL falla?
4. ¿Cómo se resuelve una colisión entre dos dispositivos, dos procesos Cloud, un retry y un Worker que leyó una versión vieja? ¿Son CAS/expectedMessageId/fencing suficientes?
5. ¿Qué permisos mínimos necesitan MASTER, bots, browser y workers? ¿Quién puede banear, borrar, elevar privilegios, girar tokens o cambiar propietario?
6. ¿Cómo opera el pool multi-MASTER, el mapping Vault→MASTER, la desconexión/reauth, flood wait y el failover? ¿Qué llamadas usan MASTER aunque no debieran?
7. ¿Cuál es la fuente de verdad cuando pin Telegram, puntero SQL y manifest divergen? ¿Con qué reglas se reconcilia sin resucitar contenido?

**Método:** diagramas de secuencia por caso; matriz de «principal → endpoint → capability → Vault → acción permitida»; búsqueda exhaustiva de llamadas y rutas; pruebas con mocks de pin/send/delete + fault injection; sólo después ensayo Telegram laboratorio aprobado.

**Cierre:** un único contrato verificable para autoridad de INDEX, trazas y estado previo/posterior de cada transición; rutas heredadas clasificadas activas/inaccesibles/inseguras con evidencia. No recomendar quitar MASTER ni reotorgar pin a bots hasta disponer de esta prueba.

### Bloque 2 — Integridad, idempotencia, transacciones, crash y recuperación

**Objetivo:** no perder ni duplicar beats, PROJECT, cuotas, reservas ni tombstones bajo incertidumbre.

**Inspeccionar:** `library-index-publication.js` (publish/recover/purge), `direct-operation-repository.js`, `index-reconciliation.js`, `garbage-journal-repository.js`, `garbage-reconciliation-worker.js`, `vault-index-pointer-store.js`, `library-*` stores, `project-upload-authority.js`, `startup-vault-recovery.js`, `migrations/0014–0018*.sql`.

**Matriz de fallos:** antes/después de reservar cuota; antes de subir; bytes subidos pero respuesta perdida; antes/después de pin; antes/después de CAS SQL; cleanup del pin antiguo; tras `EXTERNAL_EFFECT`, `INDEX_COMMITTED`, `COMMITTED`, `RECONCILE`; aborto del navegador; restart de Cloud; timeout Telegram; doble callback; mensaje faltante; purge parcial; restauración de snapshot SQL desalineado de Telegram.

**Verificaciones:**
- Estados `PREPARED → EXTERNAL_EFFECT → INDEX_COMMITTED → COMMITTED` y rama `RECONCILE`: origen, cambios durables, idempotency keys, leases, TTL y eventual convergence.
- Tratar efectos externos no transaccionales (Telegram) como confirmación ambigua; no repetir ni eliminar sin observación y prueba de ownership.
- Revisar orden de locks, uso de `FOR UPDATE`, tiempo máximo dentro de TX, `statement_timeout`, `lock_timeout`, rollback y cleanup; medir, no suponer.
- Garantizar invariantes de deleted/tombstones y quota; no resucitar contenido tras downgrade, purge, retry o recuperación. PROJECT con hash/tamaño/partes/manifest correctos.
- Comprobar `runGarbageReconciliationCycle` y workers: quién los arranca, frecuencia, recuperación post-crash, observabilidad, reintentos, estados terminales y alertas.
- Simular dos procesos en DB efímera para detectar doble commit, perdida de idempotencia, deadlocks y stale locks.

**Cierre:** tabla de operaciones con precondiciones, invariantes, puntos de commit y recuperador; resultados de fallos en laboratorio; correcciones ordenadas sólo si se reproduce un defecto.

### Bloque 3 — Seguridad, aislamiento por usuario y permisos del transporte

**Objetivo:** ningún usuario/instalación/bot obtiene datos o permisos de otro.

**Inspeccionar:** `server-core.js` Auth y rutas de transporte; `direct-capability-boundary.js`, `direct-transport-capability-view.js`, `web-transport-envelope.js`, `direct-persistent-*runtime.js`, `postgres-installation-claim-coordinator.js`, `auth-abuse-controls.js`, `auth-durable-abuse-controls.js`, `project-access.js`, `access-runtime.js` y sus migraciones.

**Casos:** tokens caducados/revocados, credenciales temporales y rotadas, 2 instalaciones del mismo usuario, otro usuario reutilizando `sessionId`/`operationId`, Vault ID cambiado, `scope.objectIds` falsificado, ids Telegram de otra biblioteca, bot compartido entre Vaults, doble pestaña/document generation, CSRF/CORS, rate limits, reclamación concurrente de instalación, sesiones OAuth/login, salida y revocación, archivos temporales expuestos, logs con secretos.

**Método:** threat model y matriz actor×endpoint×recurso; tests adversariales en mocks y PostgreSQL aislado; inspección de respuestas y telemetría redacted. Las comprobaciones del frontend **no** sustituyen verificaciones backend.

**Cierre:** pruebas negativas de lectura/modificación cross-tenant y principal equivocado; lista de secretos, scopes y rutas sensibles con owners claros; sin cambio de permisos Telegram sin pruebas.

### Bloque 4 — Concurrencia, persistencia y múltiples procesos/hosts

**Objetivo:** saber si coordinación funciona para varias instalaciones, usuarios y procesos sin doble autoridad.

**Inspeccionar:** `direct-transport-control.js` (`withPoolLock`, `mutateState`, `stateSnapshot`, `beginOperation`, reaper), `direct-persistent-assignment-runtime.js`, `direct-persistent-session-runtime.js`, `postgres-control-plane-runtime.js`, `postgres-installation-claim-coordinator.js`, tablas `direct_leases`, `direct_operations`, `vaults`, `vault_index_pointers`.

**Preguntas:** ¿qué vive en JSON vs SQL? ¿Qué parte supone filesystem local compartido? ¿Qué pasa con un lock obsoleto, proceso pausado, 2 réplicas en discos independientes o un restart en mitad de operación? ¿Es la serialización por Vault realmente global? ¿Qué hacen heartbeats/generations/reaper ante respuesta tardía? ¿La asignación bot↔Vault persiste de forma coherente? ¿El trigger SQL de 4 leases sigue aplicando a la ruta actual, o es residuo histórico? ¿Cómo progresa otro Vault usando el mismo bot?

**Método:** casos deterministas de 2 instancias, luego varias; repetición y seeds; mismas/diferentes Vaults, 2 pestañas y 2 dispositivos; falsificar pausas/crashes controlados; medir tiempos de lock síncrono, contention SQL y reintentos.

**Pruebas base:** `stage1-multi-account-concurrency.test.cjs`, `direct-stale-operation-cleanup.test.cjs`, `direct-index-operation-document-context.test.cjs`, `direct-vault-assignment.postgres.integration.cjs`, `postgres-installation-claim-cross-process.integration.cjs` (no ejecutar sin clasificación del bloque 0).

**Cierre:** contrato explícito single-host o multi-host; medidas y restricciones reales; ninguna dependencia accidental de lock local cuando se anuncie horizontal scaling.

### Bloque 5 — Rendimiento, capacidad y límites (diagnóstico; optimización principal será paso 2)

**Objetivo:** obtener baseline de latencia y capacidad del núcleo, localizar cuellos verificables sin abrir refactor prematuro.

**Recorridos medibles:** login/sesión → credencial/READY → cargar INDEX/biblioteca → primer audio → cambiar pista → descargar; upload beat → metadata/INDEX → PROJECT ZIP → edición; pin/purge/recovery; navegación y caché tras refresh y dos dispositivos.

**Puntos de medición:** navegador (TTFB, LCP/interacción, Worker bootstrap, cache hit/miss, lectura INDEX, time-to-first-audio, buffering, throughput/rendimiento del upload), Cloud (RPS, p50/p95/p99, error/timeouts, event-loop lag, CPU/RAM, temp disk, file descriptors, colas y waits), PostgreSQL (pool usage, wait/locks, transacciones largas, queries), Telegram (round trips, FLOOD_WAIT, conexiones Master y bot, reintentos, bytes), red/proveedor/infra. Segmentar por Vault, tipo de operación y entorno **sin datos personales**.

**Plan progresivo, NO promesa ni benchmark ya ejecutado:**
1. Baseline controlado unitario/sintético sin acceso externo; 1 usuario lógico.
2. Casos de **10**, **50** y **100** usuarios simulados/instalaciones, sólo en entorno privado descartable con carga limitada y métricas; mix representativo de lectura, publicación y upload, mismas/diferentes Vaults, bot compartido.
3. Fault injection de lentitud, 429/flood wait, red rota, reinicio, cola plena y reintentos; verificar backpressure, fail-closed y recuperación.
4. Sólo con aprobación explícita, laboratorio Telegram separado para confrontar mock vs proveedor; nunca convertir ensayo en load-test a la infraestructura pública.

**Notas:** `stage1-multi-account-concurrency.test.cjs` (3/10/80 escenarios locales) y `capacity-load-harness.cjs` (cola sintética `setTimeout`) **no** acreditan 100 usuarios reales ni p95 del proveedor. Evaluar límites reales y costo de EC2/RDS, sin inferir saturación del incidente EC2 documentado. No fijar SLO numérico contractual sin primero definir tráfico y objetivos de producto; reportar todos los números junto a tamaño de muestra y entorno.

**Cierre:** baseline, tabla de cuellos ordenada por impacto, presupuesto de recursos, capacidad máxima **medida por escenario** y siguientes experimentos para el paso 2.

### Bloque 6 — Operación, observabilidad, respaldos y restauración

**Objetivo:** detectar degradación, reducir incertidumbre, recuperar servicio y datos sin efectos irreversibles.

**Inspeccionar:** `runtime-operability.js`, `operations-runtime.js`, `operations-observability.js`, `cloud-server/OPERATIONS-OBSERVABILITY.md`, `postgres-bootstrap.js`, `postgres-restore.verify.cjs`, `docs/operations/TASK-5.2-*.md`, workflows de release/CI, snapshots/migraciones y estado de workers.

**Preguntas:** ¿se distinguen `healthz`/readiness/servicio funcional? ¿Cómo se detectan MASTER caído, bot degradado, pool agotado, queue/reconcilers estancados, disco temporal lleno, SQL locks, Telegram throttling y fallos silenciosos de upload? ¿Alertas llegan realmente a un responsable? ¿Hay redacción de tokens/datos privados? ¿Existen backup y restore **probados**, con coherencia entre PG, INDEX y objetos Telegram? ¿Se puede hacer rollback de código y migraciones? ¿Se preservan diagnósticos y auditoría sin logs ruidosos en browser?

**Método:** revisar wiring y configuración (sin exponer secretos); ensayos de recuperación sólo sobre snapshots y recursos efímeros; documentar RPO/RTO **observados**, no heredados como PASS de runbooks; procedimientos de parada segura, drain, retry y reversión.

**Cierre:** lista verificable de métricas/alertas y rutas de respuesta, ejercicio de restauración aislado y matriz de dependencias; `readyz=200` no es sustituto de E2E.

### Bloque 7 — Mantenibilidad, calidad, deuda y Access mínimo

**Objetivo:** entender el código completamente y disponer de cambios seguros; no empezar borrado masivo.

**Inspeccionar:** arquitectura `src/features/`, `cloud-server/`, separación `server-core.js`/`server.js`, workers, estado UI, schemas, scripts, tests CI, dependencias, complejidad de `direct-transport-control.js` y `library-index-publication.js`; `access-runtime.js`, `billing-access-resolver.js`, tests de acceso.

**Trabajo:** mapa por módulo y dueño de responsabilidades; inventario de rutas activas/legacy (incluido `replaceLibraryIndex` bot y media legacy 410); duplicación de lógica entre cliente/Cloud; contratos/types y estados; errores y mensajes seguros; cobertura por invariante, no sólo porcentaje; flakiness, tests omitidos y scripts peligrosos; dependencias/secret scan; logging/debug del navegador que revela Telegram o datos internos; discrepancias docs-runtime; edge cases de Free + grants históricos intactos.

**Access mínimo:** garantizar que register/login empieza Free en `main`, grants `welcome` anteriores siguen hasta expirar, capability/cuota se resuelven server-side y baja de plan no borra beats/PROJECT/Trash. No hacer auditoría completa de cobros Polar en este paso (contrato separado en `BILLING-V1-POLICY.md`).

**Cierre:** mapa de módulos, deudas con evidencia, cobertura/regresiones faltantes y propuestas de refactor **incremental** para el paso 4; evitar reescribir código robusto sólo por tamaño.

## 5. Escenarios críticos de aceptación del núcleo

| Escenario a verificar | Invariante requerido |
| --- | --- |
| Dos dispositivos publican INDEX mismo Vault | Un único orden autoritativo; no sobrescribir cambio ajeno ni perder beats. |
| Dos Vaults comparten Transport Bot | Datos/sesiones aislados; lecturas y escritores de Vault distinto progresan sin fuga. |
| Cloud cae después de Telegram pin y antes de PG commit | Reintento/reconciliación llega a estado válido sin duplicados destructivos ni borrado prematuro. |
| Telegram falla tras subir media o PROJECT | Bytes observados, hash/tamaño y recibos reconciliados; no dobles cargos/cuotas ni archivo perdido silencioso. |
| Bot intenta fijar/borrar INDEX | Sólo actor autorizado puede efectuarlo; permisos reales verificados incluso Vault antiguo. |
| Purge con tombstone, Trash y restos físicos | No resurrección; sólo purge confirmado puede eliminar assets correspondientes y ledger consistente. |
| Downgrade/expiración de Access | Nunca borrar biblioteca; nuevas acciones sujetas a plan efectivo. |
| Otro usuario reutiliza ID/capability/credencial | Denegación por ownership/scope/expiración en backend. |
| Dos procesos Cloud y un lock obsoleto | Sin doble autoridad, bloqueo indefinido, stale state ni corrupción. |
| PostgreSQL/Telegram/MASTER se degradan | Fallo explícito, operación segura/reconciliable, señal observable y recuperación documentada. |
| Backup PG restaurado con pin más nuevo | Procedimiento seguro de reconciliación sin borrado automático ni resurrección. |
| 10/50/100 sesiones sintéticas | Medidas reales del escenario aislado, tasa de error y latencia reproducibles, sin confundir con producción. |
| Reload de pestaña durante get/replace INDEX | Generación/fencing previene resultado obsoleto y deadlock funcional. |
| Dos rutas de upload (beat vs PROJECT) | Owner, cuotas, bytes y temporales correctos; evitar credenciales y rutas legacy abiertas. |

Para cada caso: fixture y entorno, commit, pasos, triggers de fallo, resultado esperado/observado, logs sanitizados, consulta SQL de verificación, evidencia de Telegram simulado/laboratorio, clasificación PASS/FAIL/NO PROBADO. Una prueba aislada PASS no es certificación de carga real.

## 6. Severidad, decisiones y criterios para cerrar Paso 1

**Severidad orientativa antes de probar** (no equivale a diagnóstico definitivo):

- **P0 de seguridad operativa:** ejecutar scripts que pueden `DROP SCHEMA` contra DB equivocada. Bloquea tests de escritura hasta aislamiento validado.
- **P1 a investigar:** autorización y autoridad del INDEX / pin; consistencia Telegram↔SQL; recuperabilidad de operaciones ambiguas; cross-tenant; locks SQL durante red; coordinación entre procesos.
- **P2 a medir:** latencias reales de MASTER, bot pooling, carga de INDEX, temporales PROJECT, saturación RDS/EC2, readiness/alerting, límites de concurrencia.
- **P3 organizativo:** código heredado no alcanzable, logging no sensible, complejidad y documentación; elevar severidad si evidencia muestra exposición.

**No confundir:** riesgo = posibilidad razonada; bug = falla reproducible; decisión arquitectónica = comparación entre alternativas con datos. No crear «cuello de botella MASTER» o «bots pueden borrar INDEX» como hechos sin demostrarlo.

El paso puede considerarse auditado cuando: están mapeadas todas las escrituras/lecturas del INDEX y permisos efectivos; existe modelo de invariantes y autoridad para beats/Trash/PROJECT/cuotas; los tests peligrosos están aislados; rutas multiusuario/cross-tenant tienen evidencia negativa; se conocen procesos y workers de recuperación; hay línea base de latencias y recursos; y la lista de defectos comprobados tiene reproducciones, riesgos y alternativas. Si algo requiere producción/proveedor y aún no hay permiso, etiquetarlo **NO VERIFICADO** y no bloquear todo el documento para fingir PASS.

**Primer trabajo concreto recomendado:** sin correr comandos peligrosos ni cambiar producción, completar **Bloque 1 (INDEX: actores, permisos, lifecycle y rutas)** con diagrama end-to-end y matriz de acceso, apoyándose en el inventario y la barrera de seguridad del Bloque 0. Sólo después decidir si hay que modificar MASTER, bots, SQL o el Worker.

## 7. Fuentes, tests y reglas de mantenimiento

**Fuentes de código observadas:** [Web transport](https://github.com/magosouljah/BeatGaler/tree/10ae1908d947cc4f6981469f9a722936ec3ee57e/src/features/cloud), [Worker](https://github.com/magosouljah/BeatGaler/blob/10ae1908d947cc4f6981469f9a722936ec3ee57e/src/features/cloud/webTransport.worker.ts), [Cloud](https://github.com/magosouljah/BeatGaler/tree/10ae1908d947cc4f6981469f9a722936ec3ee57e/cloud-server), [tests Cloud](https://github.com/magosouljah/BeatGaler/tree/10ae1908d947cc4f6981469f9a722936ec3ee57e/cloud-server/tests), [migraciones](https://github.com/magosouljah/BeatGaler/tree/10ae1908d947cc4f6981469f9a722936ec3ee57e/cloud-server/migrations), [operación](https://github.com/magosouljah/BeatGaler/tree/10ae1908d947cc4f6981469f9a722936ec3ee57e/docs/operations), [Issue #133](https://github.com/magosouljah/BeatGaler/issues/133), [política Access/Billing](BILLING-V1-POLICY.md).

Otros tests del área que deben clasificarse y reutilizarse selectivamente: `cloud-server/tests/direct-capability-boundary.test.cjs`, `direct-capability-postgres.integration.cjs`, `atomic-library-index.test.cjs`, `library-index-publication.integration.cjs`, `project-access.integration.cjs`, `project-upload-route.test.cjs`, `project-upload-admission.test.cjs`, `project-master-message.test.cjs`, `garbage-journal-repository.test.cjs`, `direct-persistent-ready-no-master.test.cjs`, `direct-persistent-cleanup.test.cjs`, `operations-observability.test.cjs`, `postgres-restore.verify.cjs`. No ejecutar por nombre antes del Bloque 0.

**Conservar BLUEPRINT pequeño:** este documento concentra los hallazgos y el plan específico del Paso 1; [DIRECTION](DIRECTION.md) guarda exclusivamente el orden recomendado de frentes, no un calendario. Al terminar, condensar resultados comprobados en [ARCHITECTURE](ARCHITECTURE.md) y [CURRENT-STATE](CURRENT-STATE.md) sólo cuando corresponda; conservar las evidencias detalladas en un informe/PR específico sin agregar decenas de archivos a la guía.

**Fuera de alcance:** desplegar `main`, tocar producción, reinvestigar incidente EC2, reactivar Desktop/Tauri, modificar cobros reales, marketing/campañas o prometer escalabilidad sin evidencia. Los pasos 2 (rendimiento/estabilidad), 3 (UX/landing), 4 (limpieza incremental) y 5 (validación final) tienen autonomía y sus planes se definirán cuando se elijan.
