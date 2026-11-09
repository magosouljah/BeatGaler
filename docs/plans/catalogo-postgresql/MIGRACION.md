# Migración, reversión y recuperación

**Rediseño nativo (2026-11-08, PROPUESTA pendiente de aprobación):** según [NATIVO-POSTGRES-20261108.md](NATIVO-POSTGRES-20261108.md) §8, M0–M6, R1 y R2 quedan **sin objeto** porque no hay import ni reversión a INDEX. R3 sigue vigente y pasa a T19. El runbook pasa a ser inventario, activación y reset de vaults de prueba, sin borrados (§3–§4). Este documento se conserva como antecedente.

Runbook de destino. Los comandos exactos se generan y ensayan en T17/T21; **no ejecutar estos pasos sobre servicios o datos reales desde el encargo actual**. No usar helpers legacy `recover` para capturar evidencia: pueden cambiar el pin, borrar documentos y migrar proyectos.

## M0. Manifiesto de ejecución

Cada run necesita un manifiesto concreto, revisado antes de `--apply`:

```json
{
  "runId": "identificador-unico",
  "environment": "identificador-del-entorno-autorizado",
  "candidateSha": "sha-completo",
  "bridgeSha": "sha-compatible-con-ambas-autoridades",
  "deployedShaObserved": "sha-observado-no-inferido",
  "postgresVersion": "version-verificada",
  "userId": "propietario-explicito",
  "vaultId": "vault-explicito",
  "expectedAuthority": "LEGACY",
  "expectedEra": "uuid-de-la-era-vigente",
  "expectedEpoch": "1",
  "snapshotSha256": "hash-del-snapshot-final",
  "generationId": "generacion-validada",
  "cleanupEnabled": false,
  "rollbackMaxBytes": 15728640,
  "backupProofRef": "evidencia-de-restore",
  "transportFenceProofRef": "evidencia-T11",
  "approvedScopeRef": "instruccion-o-aprobacion-del-encargo"
}
```

Los valores son placeholders deliberados; la CLI rechaza placeholders, datos incompletos y discrepancias. No contiene passwords/tokens/URLs con credenciales. Para un entorno real, su preparación es parte del trabajo anterior a pedir autorización final, no una elección delegada al ejecutor durante el corte.

## M1. Expansión sin cambio de autoridad

1. Verificar SHA realmente desplegado, instancias/procesos, esquemas y backups. La documentación de beta.2 no basta.
2. Desplegar versión puente compatible con ambas autoridades, guardas C10 y feature apagada. Todas las instancias Cloud y workers deben pertenecer al conjunto de SHAs aprobado. Sacar de servicio instancias viejas antes de admitir el corte.
3. Aplicar expansión aditiva con runner probado. Las bibliotecas siguen LEGACY. No inicializar catálogo vacío ni recuperar INDEX globalmente como efecto de la expansión.
4. Verificar auth, Access, publicación legacy, cuotas, PROJECT, playback y separación de cuentas. Confirmar que el flag apagado no se cambia por ausencia de pin o fallo de DB.
5. El rollback binario a una versión antigua aún es posible **solo antes de cualquier biblioteca POSTGRES**. Después se vuelve únicamente a versión puente que entienda las tablas de autoridad.

## M2. Sombra y selección de biblioteca

1. Elegir una biblioteca explícita con propietario, tamaño bajo cota reversible, clientes compatibles y sin incidencias abiertas. No empezar por la mayor o una cuyo INDEX no se puede validar.
2. Registrar pin, puntero SQL, ledger, tombstones, recibos PROJECT, garbage/operaciones y hash de INDEX. Comparar pin antes/después de descargar; si cambió, snapshot no aceptado.
3. En sombra puede haber escrituras legacy: el snapshot es una fotografía para probar el codec, **no** un candidato final de corte. No perseguir sincronía mediante dual writes.
4. Importar en STAGING y ejecutar compare/export. Validar todas las referencias, no solo beats visibles. No copiar ni borrar medios.
5. Biblioteca ausente: solo se acepta vacía con evidencia de provisionamiento nuevo, `index_bootstrap_pending` coherente y ausencia comprobada de estado anterior; ante duda REVIEW, no fabricar INDEX vacío.
6. Divergencia pin/ledger/tombstone, formato OPAQUE sin resolver, purges incompletos o errores de acceso → REVIEW de esa biblioteca. Las demás pueden seguir en LEGACY y ser evaluadas por separado.

## M3. Congelar y drenar

1. Transacción breve sobre biblioteca: CAS de autoridad LEGACY/epoch esperada, `migration_state=FREEZING`, revocar admisión de nuevas mutaciones/capabilities y registrar run. Lectura legacy puede continuar mientras sea consistente; UI muestra mantenimiento para escrituras.
2. La versión puente debe haber registrado todas las operaciones legacy mutantes activas, incluidos publish/purge/recover/upload/topic/routing, desde antes de abrir esta fase. Esperar sus resultados durables. Un proceso anterior que no se pueda inventariar obliga a STOP, no se considera terminado por no aparecer en la tabla nueva.
3. Drenar publicaciones, purges, copias de PROJECT, subidas, limpieza, sesiones con comandos mutantes y cualquier RPC despachado. No mantener transacción abierta durante la espera. Reservas pendientes se resuelven/cancelan solo cuando se sabe si produjeron medios.
4. RPC incierta, lease vencido sin resultado o cliente desconectado después de enviar → RECONCILE. El simple vencimiento no habilita corte. No iniciar el mismo efecto con otro worker para “terminar el drain”.
5. Aplicar y comprobar procedimiento de cercado físico T11 a sesiones/credenciales antiguas, teniendo en cuenta bots compartidos. Si no está demostrado, STOP-TRANSPORT. No rotar credenciales compartidas como improvisación.
6. Con todas las operaciones mutantes resueltas, registrar FROZEN e incrementar epoch para invalidar callbacks/clientes anteriores. Bibliotecas con trabajo externo no resuelto permanecen congeladas/review según estado conocido.

Si el drain supera el presupuesto operativo aprobado (propuesta inicial 15 minutos), detener el run y escalar. No incrementar timeout ni asumir que el efecto remoto terminó. Volver a LEGACY escribible antes del corte requiere comprobar otra vez que no hay dispatch incierto y registrar una nueva epoch; la CLI `resume` aplica estas precondiciones.

## M4. Snapshot final y cambio de autoridad

1. Capturar snapshot final en FROZEN, con el mismo inventario de M2 y sin efectos reparadores. Comprobar pin estable, ledger y evidencia de fencing. Esta captura reemplaza la sombra anterior como candidata.
2. Importar en generación nueva; validar roundtrip, referencias, cuotas, bytes reversibles y tombstones. Guardar snapshot en almacenamiento de backup y verificar hash de lectura. Conservar INDEX actual y todos los archivos.
3. Pre-corte: G0–G4 PASS, backup/restore vigente, versión puente en todas las instancias, ninguna operación/RPC incierta, limpieza apagada, tamaños bajo cota y run/epoch coincidentes. Cualquier falla → sin corte.
4. Transacción SQL corta: lock biblioteca → repetir precondiciones → activar generación VALIDATED → authority POSTGRES, state IDLE, epoch+1, revision inicial, contadores exactos y proyección legacy conciliada → evento de corte + checkpoint → COMMIT. No Telegram en esa transacción.
5. Si se pierde respuesta del corte, inspeccionar SQL por run/epoch; no repetir importación ni inferir autoridad del pin. POSTGRES confirmado → seguir M5; LEGACY/FROZEN → reanudar desde checkpoint.

## M5. Smoke y observación

Verificar en cliente nuevo: listar/buscar más allá de primera página, detalle, PATCH, import/retry, reemplazo, trash/restore, artwork/play/seek/download y logout/cambio de cuenta. Usar archivos de prueba explícitamente autorizados. Metadata debe funcionar con Telegram deliberadamente inaccesible en un ensayo controlado; no interrumpir globalmente producción para probarlo.

Verificar también cliente antiguo, helper recovery, arranque de Cloud/worker y capacidades anteriores: no pueden imponer INDEX. No intentar borrados destructivos de archivos reales para “probar fencing”; esa evidencia viene del sandbox.

Observar métricas C11 durante 48 h propuestas. Conservar backup de corte y generación anterior. Cleanup continúa apagado. No abrir siguiente cohorte si hay errores de integridad, drift de counters, operación incierta sin diagnóstico, regresión de SLO o errores de proveedor que afecten la seguridad de referencias.

## M6. Ampliar y habilitar eliminación física

Cada biblioteca repite M2–M5. Cohortes iniciales de hasta 5, con lista y autorización concretas; al menos 24 h de observación por cohorte. No migrar en lote las que quedaron REVIEW.

`cleanup_enabled=true` requiere por biblioteca: proveedor/revocación probados, retención cumplida, restore_hold=false tras ensayo, journal externo disponible, backups vigentes, ausencia de referencias OPAQUE y tarea de operación autorizada. No borrar INDEX predecessor como “limpieza habitual” mientras la ventana reversible siga abierta.

Cerrar ventana reversible es una acción distinta, aprobada y registrada. No se deduce de haber transcurrido 30 días. Al cerrarla se puede retirar la cota export de esa biblioteca; conservar codecs/snapshots por la retención aprobada.

## R1. Revertir antes de aceptar escrituras POSTGRES

Congelar, comprobar que no hay operaciones ni eventos POSTGRES de usuario desde el corte y que INDEX/ledger/medios originales siguen válidos. Registrar nueva época y retornar LEGACY mediante CLI probada. Si no se puede demostrar que no hubo cambios, usar R2. No restaurar una DB completa para revertir una sola biblioteca.

## R2. Revertir después de escrituras POSTGRES

1. Freeze de POSTGRES y bloqueo de nuevas mutaciones/cleanup; drenar hasta no tener efecto externo incierto. Mantener lecturas de SQL si su integridad está demostrada.
2. Exportar catálogo **actual** con todas las nuevas altas, cambios, reemplazos, trash, tombstones y purges confirmados. Un PURGING parcial bloquea retorno legacy hasta resolverse: el código antiguo no conoce ese estado.
3. Verificar roundtrip con lector legacy independiente, tamaño real ≤16 MiB y cota vigente, formatos PROJECT admitidos, cuotas y existencia de medios requeridos. Mantener snapshots de cada etapa. Si falla, permanecer congelado y escalar; no usar un export anterior que sí quepa.
4. Publicar export con operación privilegiada durable `ROLLBACK_PUBLISH`, fuera de SQL. El estado sigue POSTGRES/ROLLBACK y los lectores legacy permanecen cercados; recovery legacy no corre aunque el pin ya sea el nuevo.
5. Verificar mensaje/pin/hash y capacidad de leerlo por ruta legacy autorizada. Respuesta perdida → reconciliar el mismo publish, no mandar a ciegas otro INDEX.
6. Transacción corta: comprobar run/epoch/estado sin cambios → reconstruir proyección `library_beats`, `library_quota_state`, `vault_index_pointers`, tombstones `library_trash_purges`, recibos PROJECT compatibles y startup routing desde el export validado → authority LEGACY, epoch+1, state IDLE → COMMIT.
7. Legacy solo se abre después de ese commit. La generación SQL se conserva RETIRED para auditoría. Deshabilitar jobs de la época POSTGRES anterior, verificar que no quedan deletes tardíos. Smoke legacy y nueva observación.

No equivale a “apagar feature flag”. No devolver tráfico a un backend que ignora la autoridad antes de completar R2. Si el backend antiguo no puede representar una escritura nueva, esa escritura debía estar bloqueada durante la ventana reversible; si se descubre después, STOP-INTEGRITY y plan de alta capacidad.

## R3. Restaurar DB sin resucitar referencias rotas

1. Restaurar en instancia aislada sin procesos con credenciales Telegram ni workers habilitados. Un restore copia flags viejos: forzar `restore_hold=true` por política de arranque del entorno de restore, no confiar en el valor restaurado.
2. Verificar backup base/WAL, esquema, hashes, conteos, FK y punto temporal. Emitir identificador nuevo de instancia/era operativa; ninguna lease/copied session anterior puede habilitar efectos remotos.
3. Recuperar journal externo de purges posteriores al punto restaurado y examinar los objetos ahora referidos. Restaurar desde copia de bytes verificada si existe; actualizar ubicaciones con nueva verificación y mantener evidencia de los IDs originales.
4. Si no existe el archivo ni backup verificado, registrar daño explícito y bloquear acceso/cleanup afectados; no presentar “restaurado sin pérdida”. Una inteligencia de alta capacidad decide reparación, alcance y comunicación.
5. Invalidar capabilities/client epochs/restored leases de forma coordinada antes de reconectar clientes. No basta incrementar un contador restaurado: debe superar/invalidar también épocas emitidas después del backup, usando journal externo/era nueva.
6. Ensayar lecturas y descargas antes de abrir escrituras. Habilitar workers y retirar restore_hold solo tras reconcile completo y autorización. Mantener la limpieza detenida ante cualquier discrepancia.

## Matriz mínima de fallos y evidencia

Cada fila tiene test con nombre estable en el manifiesto del runner y salida con datos esperados/observados. T18/T19/T21 entregan la correspondencia test→requisito. Tests de PostgreSQL usan dos conexiones/procesos donde se indique; tests de UI no sustituyen pruebas SQL.

| Caso | Resultado obligatorio |
| --- | --- |
| Dos PATCH mismo beat/version | Un éxito, un conflicto; ninguna mezcla silenciosa. |
| PATCH de beats distintos | Ambos persisten; ninguna reconstrucción global ni pérdida. |
| Reserva de última plaza concurrente | Solo una ocupa la plaza; trash cuenta, replay no duplica. |
| Proveedor lento durante envío/verificación | Cero clientes SQL retenidos por esa operación; metadata disponible. |
| Caída antes de dispatch | Operación preparada recuperable; ningún archivo supuesto enviado. |
| Envío aceptado, respuesta perdida | RECONCILE; recibo recuperado o BLOCKED, nunca retry ciego. |
| Recibo ajeno/manipulado | Rechazo sin vincular el medio. |
| Hash/tamaño/parte no coinciden | No READY/commit; conserva evidencia. |
| Todas las partes verificadas, crash precommit | Ningún beat parcialmente publicado; retry confirma una vez. |
| Commit aceptado, respuesta perdida | Mismo resultado/version por idempotency key. |
| Reemplazo contra versión vieja | Vínculo ganador intacto; nuevo objeto retenido pendiente. |
| Purge vs restore/edit/upload | Version/state guard impide carrera; PURGING no restaurable. |
| Fallo al borrar una parte | PURGING con progreso durable; cuota no liberada. |
| Error permisos/chat inexistente al comprobar delete | No confundir con ausencia autorizada. |
| Archivo/topic compartido | No eliminar medio de otro beat; item BLOCKED. |
| Worker lease viejo vuelve tras otro claim | Sin confirmación con token viejo; no nuevo efecto incierto. |
| Evento SSE perdido | Feed/revisión actualiza página sin leer INDEX. |
| Cursor de otra cuenta/filtros/revisión | Rechazo o reset explícito; sin fuga ni página engañosa. |
| Cliente/Cloud/Worker antiguo después de corte | Sin imponer INDEX ni destruir medios retenidos según T11. |
| Restart de server con POSTGRES | No repin/recover desde INDEX ni cola global antes de metadata. |
| Pin ausente/divergente | REVIEW; jamás importar vacío implícito. |
| Crash en cada checkpoint de corte | Inspección determina autoridad exacta; reanudar no duplica. |
| Rollback tras altas/edits/reemplazos/trash | Export actual legible; ningún cambio perdido. |
| Export excedería límite | Cambio rechazado antes de commit durante ventana reversible. |
| Restore anterior a purge físico | Journal/backup detecta/restaura o bloquea; no resurrección falsa. |
| Campo/parte legacy desconocido | Preservación y bloqueo explícito de interpretación/destrucción. |
| Logout/cambio de cuenta con respuesta en vuelo | Cache/datos de cuenta anterior no aparecen. |

## Informe de puerta de lanzamiento

Un GO exige: SHA candidato y desplegado observados, versión DB, todos los tests requeridos PASS sin skips, fixtures/roundtrip completos, T11 real, mapa de rutas sin huecos, métricas del perfil aprobado, restore/rollback recientes, backup coverage por catálogo/bytes y autorización del run específico.

Si falta cualquier dato: NO-GO con código STOP. No sustituir una prueba ausente por la recomendación de “monitorizar después”.


## Salvaguardas del piloto LOCAL (2026-11-07)

<!-- BG-PG-LOCAL-BASELINE-20261107 -->
La migración inicia en **LOCAL con PostgreSQL descartable de pruebas** y Telegram falso, nunca la base/credenciales/Master/Vaults de producción. Conservar gates G0–G4 y su evidencia. No ejecutar migración destructiva automática al arrancar. El corte por biblioteca conserva `authority_epoch`, fencing de escritores legacy, snapshots, comparación íntegra, export actual para rollback y prohibición de reescribir INDEX desde clientes viejos. Añadir pruebas de rutas `/`, `/login`, `/signup`, `/gallery`, Playbar, filtros/paginación y cuentas por gate; no reemplazar frontend real por el antiguo `main`. Si falla Direct o CI, bloquear promoción hasta clasificar el fallo.

Ver [LOCAL-BASELINE-20261107.md](LOCAL-BASELINE-20261107.md), secciones 4–5.

### Límite de pruebas en G0 (2026-11-07)

G0/T00 requieren identificar y aprobar un descriptor seguro de PostgreSQL aislado y reproducir tests base no destructivos. T02 implementará las guardas y solo entonces creará DBs efímeras para pruebas SQL. La frase «establecer DB» en el anexo no habilita acceso a `DATABASE_URL` heredada ni ejecución de `postgres-live.integration.cjs`. G2/G4 y autorizaciones productivas siguen sin aprobación. Ver [G0-AUDITORIA-20261107.md](G0-AUDITORIA-20261107.md).

## T17-N. CLI nativa: `inspect`, `activate`, `rebind-chat`, `reset` (2026-11-09, con fakes; sin entorno real)

Runbook vigente de NATIVO r2.1 §3.1 y §4 en lugar de M0–M6/R1–R2. Entrada: `cloud-server/scripts/catalog-native.cjs` (módulo `cloud-server/catalog/native-cli.js`). La URL de PostgreSQL se pasa siempre con `--database-url`; `DATABASE_URL` heredada se ignora. Todos los comandos salvo `inspect` son dry-run por defecto; `--apply` exige un manifiesto revisado sin placeholders ni secretos. **Ningún comando borra filas legacy, medios ni INDEX; `reset` nunca vacía una biblioteca nativa.** Secuencia: `inspect` → el propietario marca descartables → `rebind-chat --apply` → `inspect` (hash posterior) → `reset --apply`. `activate` solo tras el cerco §5.0 verificable en SQL (rol antiguo NOLOGIN con 0 backends, bots listos, instancias paradas) y con `--auth-json` del estado JSON-compat. **No ejecutar sobre servicios o datos reales sin autorización específica (T23–T25).**

Salida exacta de `node cloud-server/scripts/catalog-native.cjs --help` (copiada del binario; prueba `t17-catalog-native-cli`):

```text
catalog-native — CLI nativa del catálogo PostgreSQL (T17-N (NATIVO r2.1))

Uso:
  node cloud-server/scripts/catalog-native.cjs --database-url <url> <comando> [opciones]
  node cloud-server/scripts/catalog-native.cjs --help

La URL de PostgreSQL se pasa SIEMPRE de forma explícita con --database-url; DATABASE_URL y el resto del entorno se ignoran.
Todos los comandos salvo inspect son dry-run por defecto: solo leen y muestran el plan. Aplicar exige --apply y un manifiesto
JSON revisado sin placeholders ni secretos (bot_token, api_hash, password, URLs con credenciales se rechazan).
Salida: JSON en stdout. Códigos: 0 ok/no-op, 2 uso, 3 STOP-* (detalle en stderr), 4 error SQL.

Comandos:
  inspect --environment <id> [--user <id>] [--auth-json <accounts-data.json>] [--out <manifiesto.json>] [--allow-write-role]
      Solo lectura (BEGIN READ ONLY) con un rol sin permiso de escritura; --allow-write-role solo en un laboratorio desechable.
      Por vault: puntero/pin, library_beats, cuota, purges, operaciones Direct/PROJECT en vuelo, capacidades vivas, chat, bot,
      fila de catálogo y divergencia vaults.id/chat JSON↔SQL (R12) si se pasa --auth-json. Telegram no se consulta
      (telegram: "NOT_QUERIED"). Devuelve un manifiesto con inventory_sha256 por vault y global; el propietario rellena
      "discardable" fuera de la CLI. Sin inventario marcado no hay reset.
  activate --manifest <activate.json> --auth-json <accounts-data.json> [--apply]
      Inserta la única fila de catalog_native_activation (§3.1). Precondiciones en la misma transacción: ninguna activación
      previa (misma environment_id + mismo manifiesto → no-op ALREADY_ACTIVATED; otra → STOP), control-plane postgres
      (cutover READY), JSON-compat = SQL en número y hash de users y vaults, 0 usuarios en cuarentena, inventario igual al
      del inspect aprobado (inspect.inventory_sha256), sin divergencias R12, catalog_libraries vacía salvo staging LEGACY
      listado, cerco §5.0 verificado en SQL (rol antiguo NOLOGIN con 0 backends, bots conocidos sin rotación pendiente,
      inventario de instancias todas paradas, direct_token_exposure ROTATED|FRESH_BOTS; WAIVED_TEST_ONLY no existe).
      Manifiesto: { environment_id, run_id, transport_bot_ids[], direct_token_exposure, instance_inventory[{id, stopped}],
        inspect{inventory_sha256, approval_ref}, credential_fence{old_db_role, token_rotation_proof_ref,
        transport_fence_proof_ref}, staging_libraries[]? }
  rebind-chat --manifest <rebind.json> [--auth-json <accounts-data.json>] [--apply]
      Única vía para cambiar vaults.telegram_chat_id de un vault con catálogo o en reset (§4.3). Con biblioteca: abre
      catalog_chat_rebinds (OPEN → APPLIED en la misma transacción), el chat anterior pasa a RETIRED (solo lectura) y el nuevo
      a CURRENT, época +1. Siempre deja una fila append-only en catalog_vault_rebind_audit y resuelve la cuarentena del flush
      del usuario (resolution REBIND). Con --auth-json actualiza storageChatId del JSON-compat antes del COMMIT.
      Rechaza: vault_id distinto (R12), from_chat distinto, chat destino ya usado (biblioteca, otro vault o abandonado),
      operaciones en vuelo. Manifiesto: { environment_id, user_id, vault_id, from_chat_id, to_chat_id, approval_ref, rebind_id? }
  reset --manifest <reset.json> [--apply]
      Reinicio nativo de un vault de prueba descartable (§4.2), en una transacción con el vault bloqueado: recalcula el hash
      del inventario (distinto → STOP-DATA), exige 0 operaciones legacy en vuelo, biblioteca POSTGRES existente → no-op
      ALREADY_APPLIED solo con el mismo manifiesto (si no, LIBRARY_ALREADY_NATIVE: un reset nunca vacía una biblioteca
      nativa), exige que el vault ya apunte al chat nuevo puesto por rebind-chat (auditoría) y no registrado; generaciones
      LEGACY → RETIRED sin DELETE; generación reset-<uuid> origin RESET con descriptor de lo abandonado; biblioteca POSTGRES
      con era nueva y época +1; chat nuevo CURRENT y chat legacy LEGACY_ABANDONED; capacidades Direct revocadas;
      index_bootstrap_pending=false. No borra filas legacy, medios ni INDEX (eso es T24-N, con autorización propia).
      Secuencia: inspect → marcar descartable → rebind-chat --apply → inspect (hash posterior al rebind) → reset --apply.
      Manifiesto: { environment_id, run_id, user_id, vault_id, inventory_sha256, legacy_chat_id, new_chat_id,
        approval{marked_discardable: true, ref} }

STOP: STOP-ENV (entorno/activación/rol/bots), STOP-DATA (inventario, divergencias, chats, operaciones en vuelo),
STOP-CONTRACT (manifiesto inválido o incompatible), STOP-APPROVAL (vault no marcado como descartable).
```

Evidencia: [E35](EVIDENCIA.md), [T17-CLI-NATIVA-20261109.md](T17-CLI-NATIVA-20261109.md). Pendiente real: ejecución con rol de solo lectura y entorno autorizado (R1), prueba de proveedor (T11 fase B) y G4 (T19) antes de activar.
