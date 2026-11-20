# BeatGaler — estado AWS del catálogo PostgreSQL, 19 noviembre 2026

Registro de acciones **ejecutadas y verificadas** en la cuenta AWS aprobada por el propietario. No sustituye los gates ni autoriza fingir evidencias.

> **AVISO DE VIGENCIA:** este documento preserva el estado histórico desde el 19 nov y las reparaciones del 20 nov. El estado final posterior a las **2 subidas confirmadas**, activación del **worker permanente** y backup S3 con 2 beats está en [CIERRE-LIVE-2026-11-20.md](CIERRE-LIVE-2026-11-20.md). La deuda técnica y de producto se controla en [PENDIENTES-POST-LIVE-2026-11-20.md](PENDIENTES-POST-LIVE-2026-11-20.md). Las frases antiguas «catálogo no activado» o «Web antigua» son fotos cronológicas, **no el estado presente**.

## Infraestructura de respaldo (G4 PostgreSQL)

- AWS: `us-east-2`; RDS PostgreSQL 18, instancia `galer-cloud-prod`.
- Snapshot previo al corte: `beatgaler-pre-native-20261119` = **available**.
- CloudFormation `beatgaler-catalog-backups` = **CREATE_COMPLETE**. S3 privado, SSE-KMS y Object Lock GOVERNANCE.
- Backup externo probado: `bk-20261119T222957-23743` = 3 objetos y restauración aislada **PASS** (5 users, 5 vaults, 28 legacy_beats, 25 migraciones, 42 tablas). Nunca se abrió la base restaurada al tráfico.
- Servicio `beatgaler-pg-backup.service` y timer diario 03:15 UTC en EC2, **enabled/active**. Segundo backup previo a la migración confirmado.
- Se corrigieron y desplegaron `pg-backup-s3-kms.sh` y `pg-restore-s3-kms.sh`: el manifiesto incluye contadores nativos del **mismo snapshot MVCC** y restore los valida.
- Backup posterior a migrar el esquema: `bk-20261120T015358-28878` = **UPLOADED**; manifiesto descargado y leído desde S3: **41 migraciones, 90 tablas, catalog_libraries=0 y catalog_beats=0**.
- El rol EC2 dispone de permisos de escritura S3, **no lectura**. Se retiró la política de lectura temporal usada en el primer simulacro.
- El backup S3 cubre PostgreSQL, **NO bytes de Telegram**. Propietario aceptó expresamente riesgo de copia única de medios.

## Cloud, Web y SQL

- GitHub rama de laboratorio: `local/landing-gallery-unificada`; paquete Cloud/Web preparado en EC2, commit `1ceb9c39`.
- Cloud **desplegado en producción** a `/home/ec2-user/BeatGaler-releases/native-1ceb9c39`; el servicio recuperó **HTTP 200 /readyz**.
- Cloud anterior queda disponible en `/home/ec2-user/BeatGaler-releases/a8418223527f88e9d34db8e05abb10216942013c`. El script de arranque tiene copia `/usr/local/bin/beatgaler-cloud-start.pre-native-20261119`.
- El nuevo Cloud aplicó mediante bootstrap las migraciones PostgreSQL **hasta 0041**. El manifiesto S3 posterior confirma 41 versiones.
- **CATÁLOGO NATIVO NO ACTIVADO**: log Cloud `[catalog] native=flag-off ... gateway=none`; las filas `catalog_native_activation` y `catalog_libraries` no están activadas/creadas en el entorno.
- Web con `VITE_CATALOG_API_ENABLED=true`: build **PASS**; artefactos preparados en `/var/www/beatgaler-web/releases/native-1ceb9c39`. **No publicada**. Symlink público sigue `/var/www/beatgaler-web/releases/20261027T024107Z-a8418223527f`.
- 5 usuarios, 5 vaults y 28 beats legacy de pruebas: propietario autorizó descarte, pero **no se eliminaron** ni se alteraron medios de Telegram.
- La nueva versión de Cloud usa los cinco archivos de estado JSON persistentes copiados al directorio de release; evitar sobreescritura o divergencia entre SQL y JSON-compat.

## Rol PostgreSQL y seguridad de credenciales (continuación)

- El propietario creó el rol `beatgaler_catalog_rt`, concedió permisos sobre tablas, secuencias, y CREATE en schema public. La prueba `startPostgresControlPlane` con ese rol confirmó 0 migraciones pendientes.
- **Cloud cambió a `beatgaler_catalog_rt` y está activo con HTTP 200**. Credenciales root-only en `/etc/beatgaler/catalog-runtime-db.env`, entregadas mediante systemd `LoadCredential` y sobreescritas inmediatamente antes de ejecutar Node. Script anterior respaldado en `/usr/local/bin/beatgaler-cloud-start.pre-catalog-role`; drop-in `/etc/systemd/system/beatgaler-cloud.service.d/catalog-runtime-db.conf`.
- **Backup S3 post-cambio del rol PASS**: `bk-20261120T040436-30319` (dump 445719 bytes, manifest y SHA-256), tres objetos verificados en S3.
- **Cerco T17-N todavía pendiente**: `galer_admin` es rol administrador master RDS y NO se desactivó; `activate` exige un *old_db_role* con NOLOGIN/0 backends y evidencia de fencing de tokens. No falsificar el rol ni desactivar el administrador RDS. Se necesita resolver la protección del rol administrador antes de declarar T17 PASS.
- Los bots registrados (3) aún no tienen demostrada condición `ROTATED`/`FRESH_BOTS`; no se activó el gateway. Las cuentas de prueba siguen existentes.

## Decisión del propietario: no ejecutar T17 (posterior)

El propietario decidió **ignorar el procedimiento T17** y **reutilizar Bot01/Bot02/Bot03 sin rotar sus tokens**. Bot20 permanece intacto. Esta decisión elimina el procedimiento T17 como requisito de producto, pero **no constituye evidencia de que el catálogo esté activado ni de que G2 esté aprobado**.

La implementación actual **no permite activar sin T17**: `catalog_native_activation` es obligatoria; la migración 0027 restringe `direct_token_exposure` a `ROTATED` o `FRESH_BOTS`, y el CLI `activate` exige rol legacy NOLOGIN, inventario y pruebas de cerco. **Prohibido afirmar que hubo rotación o usar `ROTATED` para tokens no rotados.**

Acción técnica nueva: diseñar/aplicar una **vía de activación simplificada real** con clasificación explícita de credenciales reutilizadas y riesgo aceptado, dejando capas de integridad (guardas SQL, no mezclar chats nuevos con INDEX, no borrar Telegram, no habilitar gateway sin validar subida/lectura). Es un cambio de código y esquema que aún no se ha implementado. El arranque actual mantiene `native=flag-off` y la Web antigua.

## Bloqueos antes de activar Gallery en producción (T23)

1. Obtener acceso SQL de migración **autorizado**, sin extraer credenciales en chat. Los controles de seguridad de la conexión bloquearon los intentos de operar directamente con credenciales de proceso. **No eludir el bloqueo**.
2. Ejecutar la secuencia T17-N según `MIGRACION.md`: inventario, cerco de credenciales, política de tokens de Telegram con evidencia real, `activate`, rebind/reset o descarte permitido de las 5 cuentas. No falsificar `ROTATED`/`FRESH_BOTS`, PASS G2 ni manifest hash. La autorización de descarte no equivale a ejecución de borrado.
3. Sólo después de activación y transporte funcional, activar `BEATGALER_CATALOG_NATIVE_ENABLED` y los flags de transporte aprobados y publicar Web nativa. **No** encender solo la Web: devolvería catálogo no disponible.
4. Confirmar subida/lectura y salud Cloud; conservar ruta de reversión de arranque y snapshot. Las pruebas de piloto manual fueron dispensadas por el propietario; esto no sustituye los controles de integridad necesarios.

**Resumen:** G4 externo del PostgreSQL realizado; esquema y Cloud nuevos en producción, Web preparada; **T23 activación nativa de producto pendiente**, por credenciales/cerco y transporte Telegram.

## Estado comprobado tras aplicar 0042 (continuación, 20 nov UTC)

- El propietario ejecutó manualmente la migración adicional **0042_catalog_reused_bots.sql** en RDS: `MIGRATION_0042_APPLIED`. La deprecación de `pg` provino de consultas concurrentes en un solo `Client`; se corrigió el helper (consultas secuenciales).
- Se desplegó el Cloud candidato commit `541212df` en `/home/ec2-user/BeatGaler-releases/native-541212df`, con reversión automática en caso de fallo de salud. Estado verificado: servicio `active`, endpoint `/readyz` HTTP 200.
- Se preparó versión Cloud anterior `native-1ceb9c39` para reconocer esquema 0042 en caso de reversión: migración 0042 copiada al directorio de migraciones. El script de arranque activo apunta a `native-541212df`; su copia anterior es `/usr/local/bin/beatgaler-cloud-start.pre-541212df`.
- Backup S3 adicional comprobado: `bk-20261120T053050-29892` (dump + manifest + sha256), con manifiesto leído desde S3: **42 migraciones; 5 users, 5 vaults, 28 legacy_beats, 0 native catalog libraries y 0 native catalog beats**.
- La Web pública sigue en release `20261027T024107Z-a8418223527f`; no publicar Web nativa hasta tener activación + transporte funcional. `BEATGALER_CATALOG_NATIVE_ENABLED` continúa apagado.
- La vía `REUSED_UNROTATED` (reutilización del token sin alegar rotación) pasó las **6 pruebas unitarias del CLI**; en esa vía exige rol SQL dedicado, 0 backends viejos, decisión explícita del propietario e informa los riesgos residuales. **No es un PASS de G2**, no prueba Telegram, no migra chats ni reinicia automáticamente las 5 bibliotecas legacy.
- Falta el corte final: activación real con inventario y compatibilidad JSON/SQL, gestión coherente de las 5 cuentas descartables, transporte comprobado y Web nueva. No declarar terminada la migración ni borrar datos hasta resolver ese flujo.


## Preparación del corte final con bots existentes — 20 nov 2026 UTC

- Dueño insiste en **reutilizar Bot01, Bot02, Bot03 sin rotación**. Bot20 sigue intacto. `REUSED_UNROTATED` y `BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED` son una **excepción de lanzamiento identificada como riesgo del propietario**, **no G2 PASS**. Cloud valida primero que la fila nativa SQL tenga modo `REUSED_UNROTATED` antes de montar gateway/Direct en ese modo; por defecto ambos siguen cerrados.
- **Identidad real Telegram PASS 3/3**, Bot01/Bot02/Bot03 mediante GramJS `getMe` en AWS, comando SSM terminado `Success` (2026-11-20T06:03Z aproximado). No se envió, descargó ni borró ningún medio; **G2 media smoke NO PROVEN**, E8 permanece como riesgo.
- **25/25 pruebas unitarias PASS** de CLI, gateway, fences y bootstrap nativo; incluye prueba de borrado SQL atómico de 5 cuentas de prueba junto con `activate`. La transacción no afecta Telegram y se revierte íntegra si la activación falla.
- Se corrigieron dos rutas que podían iniciar un INDEX entre alta de usuario y provisión: `catalog/legacy-fence.js` bloquea el vault `catalog_native_eligible` y `library-index-publication.js` excluye esos vaults de recuperación legacy.
- El operador `cloud-server/scripts/catalog-production-go-live.cjs` prepara un **corte único**, valida backup S3 `bk-20261120T053050-29892` (42 migraciones, 5 usuarios, 5 vaults, 28 beats legacy), valida conteos, roles/bots, `JSON-compat` SQL, hash del inventario, detiene el Cloud anterior, hace **DELETE de los 5 usuarios SQL de prueba + fila de activación en la misma transacción**, despliega Cloud, cambia Web al final, y verifica salud. Sin borrar medios de Telegram; acciones de cleanup siguen apagadas. Contiene `--dry-run` y `--apply`; usa URL de runtime root-only y no imprime secretos.
- **NO EJECUTADO TODAVÍA en producción** el corte destructivo/activación. El acceso AWS conectado bloqueó la operación SQL administrativa anterior; no se debe burlar ese control. El usuario sí puede ejecutar localmente en su sesión autorizada el operador, que no activa si alguna precondición difiere.
- Confirmación final antes del siguiente paso: Cloud productivo `native-541212df` sigue **HTTP 200**, Web productiva sigue release `20261027T024107Z-a8418223527f`, `catalog_native_activation=0` al último backup. No declarar cerrado hasta verificar `--apply`, nueva Gallery y carga/lectura real de beats.

## Cierre del corte PostgreSQL nativo — 20 de noviembre de 2026 (UTC)

**Estado vigente (reemplaza los apartados «no ejecutado todavía» anteriores): CORTE NATIVO APLICADO; G2 MEDIOS NO PROBADO.**

- Se corrigió el `403 HeadObject` al intentar leer el respaldo SSE-KMS de S3. El rol `galer-cloud-app-role` solo tenía `s3:PutObject`, `kms:GenerateDataKey` y `kms:Encrypt`. Permiso añadido para **solo tres objetos del respaldo** `bk-20261120T053050-29892` y `kms:Decrypt` solo vía S3. AWS desde EC2 confirmó lectura de manifiesto (686 bytes) y HEAD de dump (445.882 bytes).
- El `--dry-run` de lanzamiento reveló discrepancia de **un ID de vault legacy**, mientras los 5 usuarios y los 5 chat IDs coincidían entre JSON y SQL. Se agregó excepción **estricta** para un solo ID divergente exclusivamente si se eliminan las cinco cuentas descartables en la misma transacción. 26/26 pruebas del bloque PASS. Un mismatch de chat o dos IDs se rechaza. `--dry-run` final PASS.
- El primer intento de `--apply` se detuvo antes de escrituras en `STOP_OLD_CLOUD_STILL_RUNNING`; el Cloud anterior se recuperó. Se verificó que `systemctl stop` termina el proceso con SIGKILL y deja el unit en estado `failed` con `MainPID=0`. Se corrigió el criterio a `inactive|failed` + `MainPID=0`; no se salta la exigencia de que no quede proceso.
- **Segundo intento SSM `359fa7a1-ea32-4c02-b89a-870cf0f355d8`: SUCCESS.** Salida: `ATOMIC_RESET_ACTIVATION_DRY_RUN_PASS`, `NATIVE_ACTIVATION_AND_FIVE_SQL_TEST_RESET_COMMITTED`, `NATIVE_CLOUD_GATEWAY_HTTP_200`, `NATIVE_WEB_PUBLISHED`, `POST_CUTOVER_BACKUP_PASS`. SQL verificado después en lectura: `catalog_native_activation=1`, `environment_id=beatgaler-prod`, `direct_token_exposure=REUSED_UNROTATED`, `users=0`, `vaults=0`, `catalog_libraries=0`.
- **Producción actual:** Cloud `/home/ec2-user/BeatGaler-releases/native-645b67f0`, `/readyz` HTTP 200; flags `NATIVE`, `GATEWAY`, `DIRECT` y `OWNER_G2_RISK_ACCEPTED` activos. Registro Cloud: `native=enabled ... gateway=bot-router(lazy) journal=none`. Web `/var/www/beatgaler-web/releases/native-1ceb9c39`; sitio `https://beatgaler.com/` y `https://www.beatgaler.com/` HTTP 200.
- **Backup posterior:** `bk-20261120T063559-17251` con `.dump`, manifiesto y SHA-256 en S3; conteos 42 migraciones, 0 usuarios, 0 vaults, 0 beats. Backup de 5 usuarios/28 beats anterior sigue en S3. **Ningún bot fue rotado, ningún bot fue creado y el script no tocó archivos de Telegram.** Bot01/02/03 autenticaron en Telegram real (3/3) antes del corte.
- **Pendiente no bloqueante aceptado por el propietario para publicar:** prueba con cuenta nueva, subida y lectura/reproducción de medio real Telegram (G2 medios `NOT_PROVEN`), sin declarar `PASS` a un gate que no se ejecutó. No se ha ejecutado esa prueba en el corte. Los usuarios de prueba SQL fueron eliminados deliberadamente; deberán registrar cuentas nuevas si necesitan volver a usarlas.

## Incidencia posterior: subida de beats sin bot asignado — 20 nov 2026 UTC

- Después del corte nativo, las 2 cuentas nuevas tenían sus bibliotecas PostgreSQL y chats `CURRENT`, pero ambas filas `vaults.transport_bot_id` estaban NULL. La API `POST /catalog/v1/operations` devolvía 503 `CATALOG_UNAVAILABLE`, con motivo `NO_SENDER`; `/catalog/v1/direct/session` igualmente no podía iniciarse.
- Se añadió `catalog/native-transport-provisioning.js`: asignación duradera mediante `DirectVaultAssignmentStore`, lock por chat, comprobación de `catalog_native_activation` y bot elegible, invitación/promoción con MASTER y comprobación real del bot antes de marcar membresía `ready`. Se ejecuta en `POST /catalog/v1/library/provision`, `POST /catalog/v1/operations` para import/replace y `POST /catalog/v1/direct/session`. No crea bots, no rota tokens ni borra medios.
- **Reparación real en AWS PASS 2/2** mediante `catalog-repair-live-transports.cjs --apply`: Biblioteca 1 → Bot01, biblioteca 2 → Bot02. MASTER y Bot API confirmaron membresías reales; SQL confirmó `transport_membership_state='ready'` en ambas. Pruebas automatizadas del bloque de transportes/CLI/gateway: **26/26 PASS**. Se desplegó Cloud `native-0e86aa42` (salud HTTP 200); Web sigue `native-1ceb9c39`.
- **No se ha ejecutado una subida completa del navegador ni reproducción del beat**; falta comprobación del usuario para confirmar el problema desde la interfaz. Tampoco se probó operación de reintento/commit de archivo real.
- Planes: `GET /beatgaler-api/plans/catalog` devolvió HTTP 200 con planes; el anterior 502 coincidió con reinicios de Cloud. `GET /plans/me` sin sesión da 401 esperado; la visualización autenticada aún no está verificada.
- Recuperación: `POST /auth/password/reset/request` con dirección de dominio reservado inexistente devolvió HTTP 202, `delivery_configured=true`; no se ha verificado recepción ni consumo de un token real.
- Registro Google/X: botones añadidos al código de `AuthExperienceGate.tsx` y `AccountGate.tsx`, **NO desplegados** porque `vite build --mode web` se quedó sin memoria en la EC2 de 913 MiB; proceso de compilación cancelado y memoria recuperada, producción estable. Compilación TS llegó a Vite. Proponer construir fuera de la EC2 o con recursos aislados.
- Perfil X: tanto SQL como el archivo runtime tienen `username` y proveedor X, pero la UI puede estar desincronizada; pendiente confirmar respuesta autenticada del cliente. Landing con portadas reales y ampliación de bots por encima de Bot01–03 siguen pendientes.
