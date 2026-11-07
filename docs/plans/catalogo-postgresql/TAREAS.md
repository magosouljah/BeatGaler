# Tareas para ejecución controlada

**No ejecutadas.** La autorización recibida en esta conversación es producir el plan. Estas instrucciones no constituyen autorización actual para implementarlo ni para acceder a servicios reales.

## Reglas de cada tarea

- Ejecutar en orden. Una sola tarea por encargo; sin agentes paralelos salvo instrucción expresa posterior.
- Antes: leer ESTADO, comprobar dependencias PASS, Git/AGENTS y alcance. Registrar cambios preexistentes; no limpiar, resetear, stash ni modificar trabajo ajeno.
- Después: `git diff --check`; pruebas de la tarea; informe y actualización ESTADO. PASS solo si todo lo requerido se ejecutó y pasó, sin skip. `PASS-AISLADO` no satisface una prueba de proveedor real.
- Una prueba roja exige identificar causa con evidencia. Está permitido corregir un defecto local inequívoco dentro del contrato y repetir las pruebas afectadas; no relajar asserts, tiempos, tamaños, permisos ni invariantes. Si la causa exige cambiar el contrato o no se puede demostrar, STOP.
- Los nombres de módulos nuevos de CONTRATO y los comandos `catalog-*` aquí definidos **son entregables futuros**. No existen todavía. T02 crea el runner; T17 crea la CLI. No ejecutar un nombre como si ya existiera.
- Conservar evidencia redacted en `artifacts/catalog/<run-id>/`. No versionar snapshots de usuarios, credenciales, IDs privados ni archivos de medios. Versionar solo fixtures sintéticos y resúmenes sin datos privados.

## Catálogo de paradas

| Código | Disparador | Salida obligatoria |
| --- | --- | --- |
| STOP-BASE | SHA/ramas/migraciones/instrucciones cambian fuera del trabajo aprobado. | Diff acotado y base encontrada; alta capacidad determina rebase del plan. |
| STOP-DATA | Campo/ID/parte/referencia ambiguos, pérdida de roundtrip, ledger/pin divergen. | JSON paths anonimizados, conteos/hashes, ningún dato corregido. |
| STOP-DESIGN | Hace falta una decisión no cubierta o contradicción de contrato. | Regla afectada, evidencia y opciones; no elegir para seguir. |
| STOP-ENV | DB no aislada, versión/extensión inesperada, URL no identificada. | Identificador del entorno sin secretos y comprobación fallida; cero escrituras. |
| STOP-TEST | Fallo de prueba cuya causa no está demostrada, baseline rojo o skip requerido. | Comando, exit code, log, caso mínimo y diagnóstico parcial. |
| STOP-TRANSPORT | Resultado remoto incierto no reconciliable, sesión antigua conserva acceso destructivo. | Estado de operación y evidencia del proveedor; no reenviar/borrar/rotar por cuenta propia. |
| STOP-INTEGRITY | Referencia ajena, conteo/counter inconsistente, resurrección, ejecución de autoridad incorrecta. | Congelar biblioteca afectada si existe procedimiento autorizado; conservar evidencia. |
| STOP-PERF | Presupuesto/SLO incumplido en perfil aprobado. | Datos crudos, entorno, queries y EXPLAIN; no cambiar umbrales. |
| STOP-APPROVAL | Siguiente paso implica servicio/dato real no autorizado. | Paquete concreto revisable, comando exacto y efecto esperado; detenerse. |

En todos los STOP: no comenzar otra tarea, no ejecutar rollback de datos por intuición. Las maniobras de contención de MIGRACION solo se ejecutan si están autorizadas y se cumplen sus precondiciones.

## T00 — Congelar la base y el ámbito de trabajo

**Depende de:** autorización para empezar implementación. **Salida:** G0 parcial; no cambia producto.

1. Ejecutar desde raíz `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git rev-parse main`, `node --version`, `npm --version`. Volver a buscar AGENTS aplicables.
2. Comparar los módulos de EVIDENCIA con el SHA de implementación. No cambiar a `main` ni sobrescribir la rama de UI automáticamente. Crear rama/worktree aislado si el encargo lo permite; dejar ruta y SHA explícitos en ESTADO.
3. Leer `docs/ENVIRONMENTS.md`, BLUEPRINT/CURRENT-STATE y ambos manifests/lockfiles. Registrar 25 migraciones o explicar diferencias; no asumir que 0026 sigue disponible.
4. Repetir los seis tests de E4. Auditar cualquier suite adicional antes de ejecutarla: hay suites destructivas y otras que usan servicios.
5. Registrar entorno de ensayo PostgreSQL elegido, versión exacta, colación y disponibilidad de pg_trgm; no conectar a un URL desconocido para “ver qué hay”. Si todavía no hay entorno, registrar STOP-ENV para integraciones, sin inventarlo.
6. Una inteligencia de alta capacidad fija/acepta las decisiones C12, recursos de performance y fronteras del piloto. Registrar aceptación/revisión, no asumirla del plan inicial del usuario.

**PASS:** baseline reproducible, árbol ajeno preservado, entorno de pruebas identificado, C12 cerrado. **STOP:** cualquiera de estas entradas no se puede demostrar. Ninguna consulta de AWS/producción es requisito para comenzar esquema local; sí lo será para el lanzamiento.

## T01 — Cerrar el mapa de datos y consumidores

**Depende de:** T00. **Archivos:** fixtures sintéticos nuevos en `cloud-server/tests/fixtures/catalog/`; `contract-map.json` y `consumer-map.md` dentro de este plan.

1. Inventariar productores/consumidores Web/Cloud/legacy: módulos E2, `src-tauri/src/versioning.rs`, constructores de manifest en commands.rs, descargas, import, edición, papelera, tags, order, playback y startup routing.
2. Usar `rg` para localizar `getLibraryIndex`, `replaceLibraryIndex`, `get_index`, `replace_index`, `readTelegramLibraryIndex`, `library_beats`, `library_trash_purges`, `garbage_journal`, `routing/reconcile`, `deleteMessages`, `deleteTopic`, `pinExistingIndexMessage`. Clasificar cada aparición productiva como legacy-only/adaptar/derivada; tests separados.
3. Crear mapa por JSON path según C4. Incluir formatos v1/v2 conocidos, flags, proyecto multipart, files de tipos desconocidos/repetidos, garbage y wrappers de trash. Si v1 no puede exportarse sin pérdida, marcar biblioteca no elegible; no convertir sin contrato.
4. Crear fixtures: vacío certificado, beat mínimo válido, todos los slots, null/ausente, Unicode/tags repetidos, 256 caracteres de ID, metadata_message_id, multipart, tombstones SQL-only, referencia compartida, JSON inválido/duplicado, puntero ausente en biblioteca no vacía, bytes por encima del límite reversible.
5. Probar como dato el orden/filtro actual y los cambios aceptados C12. Delimitar funciones solo Desktop para no añadirlas implícitamente a Web.

**PASS:** cada campo y ruta tiene destino/regla/fixture; ninguna referencia se descarta. **STOP-DATA/DESIGN:** formato no interpretable o consumidor no cubierto. Una muestra real requiere autorización y anonimización; estas fixtures no afirman cubrir todas las bibliotecas reales.

## T02 — Crear el arnés aislado y comandos de verificación

**Depende de:** T01. **Archivos nuevos:** `scripts/catalog-check.cjs`, `cloud-server/tests/helpers/catalog-test-db.cjs`, `catalog-fake-transport.cjs`, manifiesto de suites, `.github/workflows/catalog-checks.yml` (solo definir, sin desplegar).

1. Runner acepta `T03`…`T21`, `unit`, `integration`, `faults`, `web`, `all-local`, `perf`. Rechaza suites inexistentes y prerequisitos ausentes con exit !=0. Reporta total ejecutado/fallado/skipped y produce `summary.json`, `summary.txt`, logs por comando.
2. Hijo recibe entorno construido por allowlist: PATH/runtime y variables de prueba explícitas. No heredar DATABASE_URL, RESTORE_DATABASE_URL, AWS, Telegram, Polar, SMTP ni `.env` del proyecto. No imprimir secretos.
3. DB de tests: instancia desechable dedicada o cluster local expresamente asignado, nunca Local real. Aceptar solo `CATALOG_TEST_ADMIN_URL` cuyo host/puerto/rol coincidan con descriptor aprobado; nombre generado `beatgaler_catalog_test_<random>`. Crear DB nueva, marcador aleatorio y rol de prueba. Verificar current_database, servidor, marcador y ownership antes de cada cleanup.
4. No confiar solo en localhost/nombre: puede apuntar a un túnel o DB de trabajo. El descriptor del arnés debe identificar la instancia dedicada. No ejecutar scripts históricos destructivos apuntándolos a DATABASE_URL de usuario.
5. Fake transport permite pausar cada frontera, perder respuestas, devolver permisos/ausencia, duplicar recibos, matar worker y retrasar red. Instrumentar adquisición/liberación de cliente y transacciones por operación.
6. Pruebas del propio arnés deben rechazar URL no allowlisted, env contaminado, DB sin marcador, borrado de DB ajena, suite skipped y cleanup fuera de alcance. Borrar solo DB recién creada y verificada por ese run.

**Verificar:** `node scripts/catalog-check.cjs unit` después de crear sus pruebas. **PASS:** 0 accesos de red externa en unit y rechazo demostrado de entornos peligrosos. **STOP-ENV:** no hay instancia segura; no “aprovechar” la DB abierta del desarrollador.

## T03 — Crear esquema base y repositorio de catálogo

**Depende de:** T02. **Archivos:** próxima migración `*_catalog_core.sql`, `catalog/{contract,repository}.js`, `tests/catalog-schema.integration.cjs`.

1. Añadir tablas de C3 para biblioteca, generaciones, beats/tags/trash/tombstones, archivos/partes/objetos/ubicaciones/vínculos y campos legacy. Operaciones/jobs/purge se añaden después.
2. Default LEGACY y cleanup deshabilitado; no importar ni cambiar autoridad durante migración SQL.
3. Actualizar el guard de `postgres-migrations.js` y prueba de esquema para reconocer explícitamente el nuevo contrato. Mantener prohibición de secretos y garantías legacy; no solo eludirla con nombres.
4. Repositorio exige tenant+generation en cada operación. Helper transaccional usa un mismo cliente y finally release; no recibe transporte como dependencia.
5. Probar fresh DB y upgrade de las 25 migraciones; aplicación concurrente/idempotente; FK de otro usuario, parte duplicada, negativos, estado imposible y active_generation ajena rechazados.

**Verificar:** `node scripts/catalog-check.cjs T03`. **PASS:** restricciones probadas en PostgreSQL real aislado, legacy conserva resultados. **STOP:** tocar migración histórica/checksum o descubrir datos legacy incompatibles con constraint nuevo.

## T04 — Importador/exportador y comparación completa

**Depende de:** T03. **Archivos:** `catalog/legacy-codec.js`, `catalog/migration.js` (solo transformación), `tests/catalog-codec.test.cjs`, `catalog-roundtrip.integration.cjs`.

1. Implementar C4 sobre archivos/fixtures explícitos; parser rechaza ambigüedades antes de escribir.
2. Staging por generación y lotes de 250; checkpoint por snapshot hash; reanudar después de cada lote y comprobar no duplicación.
3. Exportar reconstruyendo wrappers/arrays/partes/extras; no usar DTO UI.
4. Generar reporte de diferencias por path, identidad y referencias, incluido estado SQL-only de tombstones/PROJECT/garbage. OPAQUE no impide preservar, sí validar para operaciones destructivas.
5. Implementar presupuesto de export incremental y test con escapes Unicode, cambios de longitud de `sort_order`, trash wrappers, tombstones y límite exacto. Comparar cota con export completo.

**Verificar:** `node scripts/catalog-check.cjs T04`. **PASS/G1 local:** todos los roundtrips válidos equivalentes, inválidos bloqueados, cero escrituras de autoridad. **STOP-DATA:** cualquier diferencia no incluida expresamente en C4.

## T05 — Autoridad, época y guardas internas

**Depende de:** T04. **Archivos:** `catalog/authority.js`, integración mínima de server/routes/helpers de C10, tests de autoridad.

1. Contexto resuelve usuario/vault/generación desde autenticación SQL. Estado de migración y época consultados en cada entrada y revalidados al commit.
2. Crear guard único reutilizable. Unknown library/context incompleto falla cerrado; fallback solo cuando el registro dice LEGACY.
3. Añadir guardas en helpers legacy de publish/recover/quota/purge/bootstrap/routing y en catch paths. En LEGACY mantener comportamiento base. En POSTGRES rechazar antes de invocar transporte.
4. Probar epoch ausente/vieja, mutación en FROZEN/REVIEW, callback tardío, invocación directa del helper, cuenta ajena y estado cambiado entre validación y commit.

**Verificar:** `node scripts/catalog-check.cjs T05`. **PASS:** spies externos 0 al rechazar, ninguna escritura parcial. **STOP-INTEGRITY:** hay ruta que toca Telegram antes de la guarda.

## T06 — Consultas paginadas y endpoints de lectura

**Depende de:** T05 y búsqueda/colación C12 aprobadas. **Archivos:** `catalog/{queries,routes}.js`, migration índices, pruebas queries/HTTP.

1. Implementar context/list/detail/files con límites C5, autenticación existente y queries parametrizadas. Allowlist de sorts y filtros; no interpolar identificadores arbitrarios.
2. Keyset en ambas direcciones con tupla completa y firma de cursor. Verificar revisión y filtros; siguiente página ante cambio devuelve CURSOR_STALE.
3. Filtrar globalmente en SQL y usar tags exactos; misma semántica en todas las páginas. List no selecciona legacy_json, audio, artwork bytes ni manifests completos.
4. Test con 3 páginas, empates, Unicode, búsqueda/tags fuera de primera página, siguiente/anterior, cursor adulterado, otro usuario/epoch, trash y biblioteca vacía certificada.
5. Registrar EXPLAIN de página inicial/profunda y consultas de filtros; no exigir index scan a un planner sobre 5 filas como prueba de escalabilidad.

**Verificar:** `node scripts/catalog-check.cjs T06`. **PASS:** respuesta acotada, datos globales correctos y 0 llamadas transporte aun si Telegram está caído.

## T07 — PATCH, trash y restore con concurrencia

**Depende de:** T06. **Archivos:** `catalog/commands.js`, nueva migración operations/events para metadata, pruebas commands/concurrency.

1. Implementar C6, idempotencia C5 y actualización de ledger/counters/budget en la misma transacción. Crear events transaccionales, no publicar SSE antes de COMMIT.
2. Versionar cada cambio efectivo; replay conserva versión/resultados. No-op con misma intención no suma contadores ni crea assets.
3. Dos conexiones/procesos con mismo expectedVersion: exactamente un cambio compatible con la versión inicial; el otro recibe conflicto. Dos beats distintos mantienen ambos cambios.
4. Probar edit vs trash, trash vs restore, respuesta perdida postcommit, keys repetidas/distintas, rollback provocado entre cada sentencia y counter drift.
5. Metadata-only no inicia sesión Direct ni reescribe MP3; bloquear spies si lo intenta.

**Verificar:** `node scripts/catalog-check.cjs T07`. **PASS:** 0 pérdida/sobrescritura silenciosa y ledger/counters coherentes tras todos los casos.

## T08 — Cliente de lectura, navegación y feed durable

**Depende de:** T07. **Archivos:** `src/features/catalog/*` de lectura, `webAdapter.ts`, `webLibraryWindow.ts`, `webLibraryNavigation.ts`, `WebLibraryPagination.tsx`, selectores e integración de filtros, `useCloudLibraryEvents.ts`.

1. Resolver context vía Cloud antes de elegir adaptador. Para POSTGRES no construir ni conectar WebGalerCloudTransport al cargar metadata.
2. Sustituir offsets por cursors en ruta nueva; UI anterior/siguiente y filtros del servidor. Eliminar filtrado/orden parcial redundante para páginas de catálogo.
3. Implementar feed C5 y aviso SSE como optimización. Perdida de evento/reconexión invalida o actualiza página visible y detalle; nunca refetch completo de biblioteca.
4. Cuenta/generación/epoch en claves de caches. Respuesta tardía de otra cuenta descartada. CURSOR_STALE conserva filtros y vuelve a inicio con mensaje apropiado.
5. Tests DOM con servidor falso para offline/401/503/empty/no-results, búsqueda fuera de página, cambio de cuenta y evento perdido.

**Verificar:** `node scripts/catalog-check.cjs T08`, `npm run test:typecheck`. **PASS:** biblioteca usable con transporte Telegram falso que arroja al llamarse. Legacy conserva pruebas base.

## T09 — Intenciones, reservas y máquina de estados

**Depende de:** T08. **Archivos:** `*_catalog_operations.sql`, `catalog/operations.js`, endpoints operations/receipt/commit/cancel, pruebas operaciones/cuota.

1. Crear o completar operations/parts/reservations/jobs según C3. Validar transiciones C7 en repositorio, no solo UI.
2. Reserva atomizada por biblioteca, Access real inyectado, expiración/renew y counters. Legacy usa ledger previo; POSTGRES nunca bootstrap desde INDEX.
3. Persistir random_id por parte como string entero firmado de 64 bits, partKey, sender y dispatch antes de efectos. Mismo retry recupera identidad; nueva operación obtiene otra.
4. Implementar estado de recibo candidato independiente de VERIFIED, solicitud de commit y respuesta 202. No simular proveedor real ni activar transferencias todavía.
5. Tests free con una plaza y dos imports, ID tombstoned, cancel/expire/renew races, downgrade, key reusada con otro body, reserva en conflicto y retry después de COMMITTED.

**Verificar:** `node scripts/catalog-check.cjs T09`. **PASS:** reservas y ocupación únicas; recibos de cliente nunca equivalen a prueba de proveedor.

## T10 — Worker con leases y pruebas de caída

**Depende de:** T09. **Archivos:** `catalog/worker.js`, repositorio jobs, runner separado `cloud-server/catalog-worker.js`, pruebas worker/faults.

1. Claim/lease/backoff y límites C8. Entrypoint explícito deshabilitado por defecto; shutdown deja checkpoint y lease, no borra jobs.
2. Dos procesos con workers: solo uno adquiere cada job; vencimiento incrementa generación. Workers retrasados no confirman cambios con token viejo.
3. Pausar fake Telegram 30 s: una operación nueva de metadata en otra conexión/biblioteca sigue completando; instrumentación demuestra que no hay cliente SQL retenido por el efecto remoto.
4. Matar proceso antes/después de claim, dispatch, respuesta, guardado de recibo y commit. Envío incierto → RECONCILE, no retry ciego.
5. Health del worker expone backlog/oldest_age/BLOCKED; Cloud no depende de que todas las bibliotecas se recuperen al arrancar.

**Verificar:** `node scripts/catalog-check.cjs T10`. **PASS:** recuperación determinista con dobles y SQL real aislado; no equivale a G2 real.

## T11 — Resolver el contrato real de Telegram

**Depende de:** T10. **Tipo:** experimento acotado de alta capacidad, con credenciales/cuentas/vaults de prueba expresamente autorizados. No usar bots compartidos de producción.

1. Leer SDK instalado y registrar versiones exactas/lock hashes. Crear harness `scripts/catalog-transport-contract.cjs` y worker Web de prueba. No cambiar SDK para evitar un resultado rojo.
2. Ensayar send aceptado/respuesta perdida; reinicio/reconexión; mismo random_id; respuesta duplicada; búsqueda de receipt por marcador, misma parte con varios matches y archivo distinto con mismo nombre. Repetir por Direct y MASTER PROJECT.
3. Demostrar recuperación de message/document ID y ausencia de duplicación lógica. Registrar qué deduplicación física está probada y en qué ventana; no extrapolarla indefinidamente.
4. Capturar sesión/credenciales de cliente antiguo en entorno de prueba; aplicar procedimiento de corte y comprobar capacidades efectivas descritas en C10, incluidos mensajes propios y bot compartido de laboratorio. Probar auth key ya emitida, no solo nuevo login con token viejo.
5. Preparar adaptador preciso aprobado: parámetros SDK, conversión Long, búsqueda/reconciliación, tabla de errores y condición para reenviar. Si no hay prueba inequívoca, definir BLOCKED y escalar diseño; no dar por resuelta G2 con mocks.

**PASS/G2:** informe con evidencia real y procedimiento reproducible, ninguna credencial en repositorio/log. **STOP-APPROVAL/TRANSPORT:** sin sandbox autorizado o legacy todavía puede destruir medios retenidos. Se puede continuar preparaciones locales independientes si se asignan expresamente; no declarar T11 PASS ni ejecutar T22/T23.

## T12 — Conectar transferencias y PROJECT a operaciones

**Depende de:** T11 PASS, o encargo explícito limitado a mocks sin aprobar G2. **Archivos:** `catalog/transport.js`, Worker/protocol/session/transport Web, `project-upload-authority.js`, `project-upload-route.js`, adaptadores MASTER.

1. Aplicar secuencia C7. Mantener transporte de bytes normal Direct; pasar identidad de parte/randomId durable, comprobar sender/vault y recolectar recibos verificados.
2. PROJECT: intención antes del envío, medir bytes como hoy, separar bloques SQL/remotos, preservar Access y admisión de temporal. No mantener lock durante hash de archivo, búsqueda ni publish/verify.
3. Commit nuevo valida todas las partes, cambia vínculos y retiene anteriores. Guardar evidencia de hash con nivel correcto, no etiquetar como BYTES solo por tamaño/caption.
4. Probar respuesta perdida en reserve, upload, receipt y commit; conflicto de reemplazo; downgrades; archivo reseleccionado distinto; multipart histórico; cancel durante upload; temporal perdido.

**Verificar:** `node scripts/catalog-check.cjs T12`, tests existentes project-upload-route/admission/master-message mediante arnés auditado, typecheck. **PASS:** no cambia transporte/permiso de PROJECT ni la semántica de reserva; G2 verificado para activación real.

## T13 — Cliente de mutaciones sin INDEX

**Depende de:** T12. **Archivos:** `catalogMutations.ts`, integración `webBeatEdit.ts`, `webImportCommit.ts`, `webTrash.ts`, `webGalerCloudTransport.ts` y `webAdapter.ts` sin retirar legacy.

1. Metadata-only → PATCH; import/reemplazo → operaciones/receipt/commit. No cargar INDEX para buscar versión/archivos; usar detalle SQL.
2. Conservar strip ID3 del MASTER en import, preparación ZIP PROJECT y UX de progreso; estas funciones no deben mezclarse con autoridad de catálogo.
3. Trash/restore hacen batch acotado y control de versiones; purge UI muestra pendiente hasta confirmación durable. “Toda papelera” inicia job server-side, no descarga toda la lista al navegador.
4. Persistir referencias de operación por cuenta para consultar resultado al recargar. No persistir tokens, ni dar upload por exitoso por un checkpoint en memoria.
5. Tests DOM de conflicto sin reenvío automático, retry con misma operación, reload, cambio de cuenta, error por cuota y archivos retenidos tras conflicto. Incluir edición masiva desde Drawer: versión y resultado por beat, preservación de valores legacy no editados y ningún éxito global falso ante un conflicto parcial.

**Verificar:** `node scripts/catalog-check.cjs T13`, typecheck. **PASS:** spies get_index/replace_index 0 en todas las mutaciones POSTGRES.

## T14 — Playback, artwork y descargas desde referencias SQL

**Depende de:** T13. **Archivos:** playback routing/cache/startup, `catalogLibrary.ts`, `webDownloads.ts`, cloud routing decorators y loadArtwork.

1. Detalle/lista contienen referencias de versión; rutas iniciales se consultan en SQL para IDs acotados, no desde manifest ni snapshot arbitrario del cliente.
2. Autorizar accesos por fileId/tenant/current beat/Access; mantener transporte y streaming/range existentes. Cache invalidada por versión/epoch, no solo ID de beat.
3. Descargar todos los segmentos de multipart en orden y verificar tamaño/hash disponible; no dejar comportamiento de “primera parte” oculto tras el DTO de referencia.
4. Pruebas de play/seek/replace en reproducción, artwork lazy, descarga multipart, trash/purge acceso denegado, restore acceso recuperado, cross-account y salida/reentrada de sesión.

**Verificar:** `node scripts/catalog-check.cjs T14`, typecheck, suites unit/DOM de playback afectadas auditadas. **PASS:** no regresión de streaming ni INDEX usado como cache autoritativa.

## T15 — Purge durable, retención y limpieza segura

**Depende de:** T14. **Archivos:** `*_catalog_purge.sql`, `catalog/commands.js`, worker y adaptador de borrado/journal, tests purge.

1. Implementar C9; feature apagada para real. “Purge todo” captura límite de selección por revisión y recorre trash en lotes: excluye beats enviados a trash después de esa revisión. Registrar criterio y progreso.
2. Enumerar referencias actuales, anteriores retenidas, metadata, parts, recibos sin vincular y topics; identidad física compartida única. OPAQUE/shared/retention/restore_hold bloquean borrado con motivo explícito.
3. Estados DELETING impiden nuevas referencias, incluso durante llamada externa. SQL no se mantiene abierto durante esa llamada.
4. Journal previo al borrado fuera de DB con doble de storage; si no se confirma persistencia, no hay delete. Confirmación por ausencia autorizada, no regex genérica de error.
5. Tests de caída tras cada parte, 403/404/timeout, lease viejo, purge vs restore/replace/receipt, objeto compartido, topic con otro beat, reserva huérfana, repeated purge y counter decrement único.

**Verificar:** `node scripts/catalog-check.cjs T15`. **PASS:** 0 borrado de objeto referido/retención y recuperación parcial exacta. **STOP-DESIGN:** se pretende liberar cuota antes de confirmar todo o convertir purge en delete directo del cliente.

## T16 — Integrar arranque y cercado exhaustivo

**Depende de:** T15. **Archivos:** `server.js`, `server-core.js`, authority/capabilities, `startup-routing-index.js`, publication/recovery y worker legacy.

1. Arranque de biblioteca POSTGRES no llama ensureAll/recoverAll/migrateLegacyProjects sobre ella. Separar provisionamiento nuevo necesario de recuperación de catálogo. Bibliotecas LEGACY mantienen su flujo hasta migración.
2. Aplicar matriz C10 a middleware real y helpers, incluidas rutas instaladas antes por wrappers Express, account/installation mapping y errores que hoy disparan recover.
3. Entrypoints verifican compatibilidad de esquema y versión puente antes de efectos externos; epoch/state gobiernan nuevas operaciones y las que finalizan tarde.
4. Prueba dos bibliotecas (LEGACY/POSTGRES), worker y Cloud reiniciados, Telegram caído y biblioteca REVIEW: metadata POSTGRES y la biblioteca sana siguen disponibles.
5. Cliente viejo Web/Worker/Desktop simulado recibe incompatibilidad antes de writes; pruebas de proveedor de T11 siguen exigidas para sesiones físicas.

**Verificar:** `node scripts/catalog-check.cjs T16`; rerun consumer-map y clasificar cualquier nueva aparición. **PASS/G3:** barreras completas, ninguna recuperación global impone INDEX a POSTGRES.

## T17 — CLI de sombra, freeze, corte y reversión

**Depende de:** T16. **Archivos:** `cloud-server/scripts/catalog-migration.cjs`, `catalog/migration.js`, tests CLI/restart.

1. CLI con subcomandos `inspect`, `import-shadow`, `compare`, `freeze`, `drain`, `validate-final`, `cutover`, `export-rollback`, `publish-rollback`, `return-legacy`, `resume`. `--dry-run` por defecto; aplicar exige `--apply`, runId, user/vault esperado, epoch y descriptor de entorno aprobados.
2. No aceptar `--all` para real. Cada paso persiste checkpoint y es idempotente; validar hash/epoch/predecesor antes de avanzar. `inspect/compare` no ejecutan reparación Telegram.
3. Implementar secuencia exacta MIGRACION. Freeze y corte serializan con la fila biblioteca; drain comprueba sesiones/capabilities/jobs/reservas/dispatch, no solo una lista vacía local.
4. Reversión escribe export actualizado y lo publica con operación privilegiada específica; no invocar el antiguo `publish` con guard saltada. Actualizar ledger, punteros, hashes, tombstones y routing juntos antes de retornar autoridad.
5. Test fallo entre cada checkpoint, reinicio y segunda ejecución, snapshot distinto, epoch vieja, export > límite, corte sin validación y callback antiguo tardío. Ninguna CLI vacía biblioteca ante error.

**Verificar:** `node scripts/catalog-check.cjs T17`. **PASS:** comandos exactos `--help` documentados por el ejecutor en MIGRACION; dry-run demostrado sin efectos. Hasta entonces los ejemplos de este plan no son comandos listos para real.

## T18 — Ensayo completo de migración y rollback con nuevas escrituras

**Depende de:** T17. **Entorno:** PostgreSQL desechable + Telegram falso; añadir sandbox real autorizado para la parte proveedor.

1. Sombra desde fixtures completas, compare, freeze, drain, snapshot final, corte; comprobar sin mover/copiar medios en import/corte.
2. POSTGRES: crear beat, editar otro, reemplazar archivo, trash/restore, dejar operación incierta y probar que drain bloquea reversión. Resolver por protocolo demostrado.
3. Exportar/publish/return legacy; comprobar cambios posteriores al corte, tombstones, partes, IDs y cuotas en lectura legacy real del código. No usar solamente el exportador como verificador de sí mismo.
4. Simular crash después de publish antes de return-legacy y reanudar sin que recovery legacy reponga el puntero viejo.
5. Forzar export insuficiente/16 MiB y presupuesto; operación que rompe reversibilidad debe rechazarse antes del commit, no descubrirlo al intentar volver.

**Verificar:** `node scripts/catalog-check.cjs T18`. **PASS:** informe independiente por fase, no pérdida de cambios ni reconstrucción desde un snapshot anterior. Marcar claramente qué prueba usó dobles.

## T19 — Backup, restauración y journal de purges

**Depende de:** T18. **Archivos:** `catalog/backup.js`, arnés de backup/restore y manifiestos; runbook completado. No provisionar AWS sin encargo explícito.

1. Implementar snapshot/export verificable y lectura por hash. Integrar backend de backups ya aprobado; local/fake para unit. PITR y credenciales se operan con un descriptor específico del entorno, no con defaults de `.env`.
2. Backup DB en instante A; replace/purge después; restaurar A en instancia aislada. Workers desactivados por defecto, restore_hold activo, nueva época/credenciales de runtime para impedir dispatch antiguo.
3. Cargar journal externo posterior a A, comprobar referencias a objetos eliminados; restaurar bytes desde copia verificada o declarar referencia irrecuperable y bloquear reactivación. Nunca marcar presente por restaurar una fila.
4. Ensayar restore con corrupt/missing backup y con inaccesibilidad Telegram. Medir RPO/RTO, verificar hashes y todas las partes. Si solo hay backup metadata, documentar exactamente esa cobertura.

**Verificar:** `node scripts/catalog-check.cjs T19`. **PASS:** ensayo cumple C12 y evidencia de retención; G4 real pendiente hasta demostrarlo en entorno representativo. **STOP:** se propone desactivar restore_hold sin reconciliación.

## T20 — Capacidad, latencia y contención

**Depende de:** T19. **Archivos:** generador sintético, `scripts/catalog-benchmark.cjs`, reportes; no usar data de usuario como benchmark.

1. Ejecutar perfiles C11 con semilla fija, recursos/versiones registrados y métricas antes/después de cambios. Separar fake Telegram, SQL y Web.
2. Medir page1/deep cursor, filtros frecuentes/raros/cortos, read/edit/trash/restore, import y cola, biblioteca gigante, usuarios simultáneos, frío/caliente y pausas remotas.
3. Contar SQL rows returned/updated, respuestas y memoria; confirmar que no se construye manifest completo en metadata ni en cuota. Contadores/proyección no deben reintroducir COUNT de toda biblioteca por cambio.
4. Si falla, entregar EXPLAIN ANALYZE, estadísticas y distribución; cualquier tuning cambia una cosa y se valida. No añadir Redis/sharding ni relajar SLO para cerrar la tarea.

**Verificar:** `node scripts/catalog-check.cjs perf`. **PASS:** SLO aprobado y requisitos duros en todos los perfiles requeridos. **STOP-PERF:** resultados ausentes o incumplidos.

## T21 — Preparar candidato y revisión de alta capacidad

**Depende de:** T20, G2 real y G3. **Salida:** candidato revisable; no despliegue.

1. `node scripts/catalog-check.cjs all-local`, `npm run test:typecheck`, `npm run build:web`, `git diff --check`. Runner ejecuta suites nuevas y regresiones existentes auditadas que afectan auth/quota/PROJECT/Direct/playback. Prohibido usar `cloud-server npm test`: es un placeholder que falla, no la suite del proyecto.
2. Review de alta capacidad de contrato, mapa de consumidores, esquema, matriz de fallos, aislamiento y rollback. Corregir problemas demostrados y repetir solo checks afectados; una modificación de contrato reabre su puerta.
3. Producir SHA candidato, migraciones exactas, flags default, versiones puente, plan de despliegue, comandos reales de CLI con parámetros de ejemplo sin secretos y procedimiento de contención.
4. Preparar lista de diferencias respecto del SHA desplegado verificado. `main` puede contener otros cambios: no publicar toda la rama automáticamente.

**PASS:** paquete revisable y NO-GO/GO explícito por puerta. **STOP-APPROVAL:** solicitar autorización final solo cuando este paquete esté completo para el entorno concreto.

## T22 — Sombra real autorizada

**Depende de:** T21, autorización de despliegue del puente/expansión y lectura/import de la biblioteca específica. **Procedimiento:** MIGRACION M1–M2.

Desplegar versión compatible con flags apagados; confirmar runtime/DB sin confiar en docs. Capturar snapshot verificado sin llamar recover reparador; importar en generación STAGING; comparar todos los campos/recibos. No cambiar autoridad, pin ni medios. Divergencia → REVIEW de esa biblioteca. Entregar informe con hashes y elegibilidad; G1 real solo para esa biblioteca.

**PASS:** comparación completa y cero modificación de catálogo legacy/medios. **STOP:** clientes/procesos/operaciones no inventariados o snapshot no estable.

## T23 — Piloto autorizado de una biblioteca

**Depende de:** T22, G0–G4, autorización de corte por usuario/vault/epoch y capacidad de contención. **Procedimiento:** MIGRACION M3–M5.

Aplicar freeze, drenar, snapshot final, validar, cercar clientes/procesos, corte SQL atómico y smoke. Mantener cleanup apagado. Probar lectura, metadata, import, replace y trash/restore con medios de prueba aprobados en esa biblioteca. Medir y observar 48 h propuestas, con cero alertas de integridad; incidentes detienen ampliación, no resetean métricas para lograr verde.

**PASS:** evidencia de una sola autoridad, comportamiento completo y capacidad de volver mediante export actual. **STOP:** cualquier requisito MIGRACION incumplido; ejecutar solo contención autorizada, no rollback automático a snapshot viejo.

## T24 — Cohortes y habilitación controlada de limpieza

**Depende de:** T23 y autorización de cada cohorte/cleanup. **Procedimiento:** MIGRACION M6.

Listas explícitas, máximo inicial 5 bibliotecas por cohorte; cada una repite snapshot final y criterios, no hereda validación de otra. Observar ≥24 h por cohorte. REVIEW individual no migra ni se sobrescribe. Cleanup se habilita por biblioteca solo tras backups/retención/journal, prueba G2 y protección demostrada de la ventana reversible; no habilitarlo para hacer pasar un test. T24 puede cerrar con cleanup apagado: T25 no depende de haber borrado archivos.

**PASS:** informe de cada biblioteca, restore y rollback siguen demostrados. **STOP:** regresión de SLO/integridad o falta de capacidad de recuperación.

## T25 — Cerrar reversibilidad y retirar dependencias activas de INDEX

**Depende de:** T24, todas las bibliotecas elegibles migradas o excepciones explícitas, ventana terminada y autorización para retirarla.

1. Verificar 0 rutas de runtime POSTGRES usando INDEX en inventario y telemetría; proteger rutas legacy todavía necesarias para excepciones sin marcarlas migradas.
2. Conservar snapshots, codecs y journals durante la retención acordada. No dropear tablas/proyecciones ni borrar INDEX/medios históricos en esta tarea sin subplan específico de eliminación.
3. Dejar cliente antiguo bloqueado, documentación operacional actualizada, rollback binario solo a versiones compatibles, backup/restore recurrente y ownership de alertas.
4. Solo después retirar cota reversible para biblioteca cuyo cierre esté registrado. La aplicación queda protegida por backups/restore, no por “volver al JSON anterior”.

**PASS final:** todos los requisitos funcionales, de integridad y operación demostrados; ninguna tarea pendiente ocultada. Si existen bibliotecas REVIEW, informar entrega parcial y no declararlas migradas.


## Dependencias transversales para las 26 tareas en LOCAL (2026-11-07)

<!-- BG-PG-LOCAL-BASELINE-20261107 -->
No renumerar, sustituir ni marcar como ejecutadas las 26 tareas existentes. Vincular dentro de las tareas pertinentes: (1) API/DTO desde `WebGalleryWorkspace`/bridge actual, sin importar AppShell viejo; (2) Gallery real con ANY/exclusión, tags, stars y orden; (3) paginación cursor preservando URL `bgPage`; (4) sesión/OTP/logout/cambio cuenta y cachés; (5) Player real, routing de media y Project/Direct; (6) bloqueo del Worker legacy para INDEX tras activar POSTGRES; (7) smoke de Landing pública y Gallery autenticada en cada gate. Documentar IDs de tarea exactos al revisar el archivo original. G0 requiere evidencia real de pruebas de frontend y Postgres descartable antes de T01.

Ver [LOCAL-BASELINE-20261107.md](LOCAL-BASELINE-20261107.md), secciones 3–5.

### Dependencias aclaradas por G0 estático (2026-11-07)

T00 permanece PENDIENTE y **T01 depende de T00 PASS**. La revisión documental no autoriza comenzar T00 como implementación. El descriptor PostgreSQL seguro es una entrada de G0/T00; la creación y limpieza de DBs efímeras con guardas ocurre exclusivamente en T02, posterior a T01. Así se elimina la dependencia circular de exigir el arnés de T02 antes de T01. T01 trabaja sobre código/fixtures, sin PostgreSQL real. El baseline no destructivo y decisiones C12 pertenecen a T00. Ver [G0-AUDITORIA-20261107.md](G0-AUDITORIA-20261107.md).

### Estado de T00 tras autorización (2026-11-07)

Se inició **únicamente T00** con comprobaciones estáticas de GitHub y preparación de pruebas locales sin efectos externos. No se completó: faltan resultados de test del checkout, descriptor PostgreSQL aislado y cierre de C12. Registrar el resultado del runner seguro y detenerse ante cualquier fallo no clasificado. No iniciar T01 hasta T00 PASS registrado y autorizado. Ver [T00-REVISION-20261107.md](T00-REVISION-20261107.md).

### T00 — STOP documentado tras ejecución real del baseline LOCAL

La salida PowerShell de LOCAL confirma los tests del baseline, 3 fallos de aserciones heredadas y un fallo del guard de mutaciones cuya fixture literal no coincide con `server.js`. No relajar los guards, no reinstalar preconnect global, no tocar Cloud para superar asserts de texto. T00 se detiene en **STOP-TEST** y permanecen STOP-ENV/STOP-DESIGN hasta resolver precondiciones. Ver [T00-LOCAL-RESULTADOS-20261107.md](T00-LOCAL-RESULTADOS-20261107.md).

### Baseline de T00 ya PASS en Windows

El usuario comprobó 68/68 pruebas individuales y 25/25 casos de mutación Cloud rechazados en `5b19916`; las siete fases completaron exit 0. En términos de tests del runner whitelist, `STOP-TEST` ya no bloquea, pero aún no se dispone de smoke real ni de PostgreSQL de catálogo aislado. **T00 global NO PASS por STOP-ENV y STOP-DESIGN**; no iniciar T01. Ver [T00-BASELINE-PASS-20261107.md](T00-BASELINE-PASS-20261107.md).

### Preparación concreta de G0 — PostgreSQL GitHub Actions y C12 IDE

El probe aislado de solo entorno (`.github/workflows/catalog-g0-postgres-probe.yml`) se activa por cambios a su YAML en la rama LOCAL; no sustituye el arnés SQL de T02. `STOP-ENV` exige observar run PASS y descriptor concreto, no solo commit. La IDE puede cerrar C12 mediante [G0-C12-IDE-MASTER-PROMPT-20261107.md](G0-C12-IDE-MASTER-PROMPT-20261107.md) sin ejecutar T01 o cambiar el producto. Ver [G0-LAB-POSTGRES-ACTIONS.md](G0-LAB-POSTGRES-ACTIONS.md).

### G0 entorno verificado en CI desechable

G0-ENV descriptor `PASS` según run [42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955): PG16.15, UTF8, colación `en_US.utf8`, `pg_trgm` 1.6, DB/rol/marker del contenedor efímero confirmados. [Evidencia detallada](G0-POSTGRES-VERIFIED-20261107.md). El arnés T02 (roles limitados, rechazo de URL ajena, cleanup/verificación de DB por run, integraciones) **no existe todavía**. Falta cierre C12, luego dictamen formal T00/G0 y autorización antes de T01.

### C12 — trabajo de la IDE pendiente de cierre

Acta nueva [C12-DECISION-RECORD.md](C12-DECISION-RECORD.md) con contratos, evidencia y casos a probar. Falta resolver `STOP-DESIGN-A/B` (Unicode y `bgPage`); la IDE puede cerrar decisiones técnicas usando el [prompt maestro](G0-C12-IDE-MASTER-PROMPT-20261107.md). Sin aceptación de cambios visibles no declarar G0 ni empezar T01.
