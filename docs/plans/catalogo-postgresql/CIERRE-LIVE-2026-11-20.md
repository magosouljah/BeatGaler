# BeatGaler — cierre de la migración PostgreSQL en producción

**Fecha del corte:** 20 de noviembre de 2026 (UTC). **Estado confirmado:** **LIVE / CIERRE OPERATIVO PASS**.

**Alcance del cierre:** la **Web pública** y el **Cloud** usan PostgreSQL como autoridad nativa de los metadatos de Gallery; los medios permanecen en Telegram y el trabajador durable confirma las transferencias. Se ha demostrado el caso real de **2 subidas** hasta `COMMITTED` / `ACTIVE`.

**Importante:** esto **NO** significa «todos los gates aprobados» ni «T25 concluida». Hay riesgos aceptados y retirada de código legacy pendiente. El cierre es del **despliegue y funcionamiento del catálogo nativo en producción**, no de cada actividad de limpieza del proyecto. Ver [pendientes post-live](PENDIENTES-POST-LIVE-2026-11-20.md) y el [registro cronológico](ESTADO-PRODUCCION-2026-11-19.md).

## 1. Dictamen y alcance

| Aspecto | Estado y evidencia |
| --- | --- |
| Lanzamiento Web + Cloud nativo | **OPERATIVO**, `https://beatgaler.com/` HTTP 200 y `/readyz` HTTP 200 (verificado 20 nov 07:51 UTC) |
| Autoridad del catálogo | **PostgreSQL nativo**, fila de activación `beatgaler-prod` / `REUSED_UNROTATED`; 42 migraciones SQL |
| Entrega real de medios | **2 subidas realizadas por el propietario**; Telegram recibió los archivos; SQL confirmó 2 operaciones `COMMITTED`, 4 partes `VERIFIED`, 2 beats `ACTIVE` |
| Worker y cola | **OPERATIVO**: `beatgaler-catalog-worker.service` habilitado y activo, 0 jobs en cola, 0 leases, 0 bloqueados |
| Bot pool | **Bot01, Bot02, Bot03**, sin cuarentena ni rotación pendiente; 2 vaults con membresía `ready`, usando Bot01 y Bot02 |
| Respaldo actualizado | **PASS subida y lectura del manifiesto S3**: `bk-20261120T075417-26296` con 2 beats y 4 objetos de medios *referenciados* por SQL |
| Reproducción/descarga real tras corte | **NO PROBADO** por este cierre; no inferir PASS a partir de la subida |
| G2/T11 — prueba formal de cercado Telegram | **NOT_PROVEN**; el propietario aceptó reutilizar tokens sin rotarlos, y E8 persiste |
| T25 — limpieza final de legacy | **PENDIENTE**: las rutas antiguas de bytes no forman parte del flujo nativo publicado, pero aún existen en el repositorio |
| G3 — V09 manual / accesibilidad | **SIN DICTAMEN FORMAL**; no declarar PASS |
| G4 — recuperación | Copia cifrada S3 y restore **aislado anterior PASS**; **no** se ensayó restaurar el backup nuevo de 2 beats ni existe copia de sus bytes de Telegram |
| Capacidad inicial | **500 beats por biblioteca** es el alcance aceptado. Prueba de 1 millón no es requisito del lanzamiento y conserva limitaciones conocidas |

La afirmación «migración LIVE terminada» se refiere al **paso de autoridad y a las operaciones de carga/confirmación en producción**. La retirada total de legacy requiere una tarea posterior explícita.

## 2. Foto verificada de producción (20 nov 2026, ~07:51–07:54 UTC)

- Repositorio: `magosouljah/BeatGaler`; rama de desarrollo `local/landing-gallery-unificada`. **`main` no se modifica por este registro**.
- Región AWS: `us-east-2`; EC2 `i-0053e156e4646e799`; RDS PostgreSQL (host/credenciales no reproducidos). Instancia y SSM operativos en las comprobaciones previas.
- **Cloud**: `/home/ec2-user/BeatGaler-releases/native-0e86aa42`, servicio `beatgaler-cloud.service` activo. Incluye la corrección de asignación automática de bot a vault. El código de OAuth para las vinculaciones huérfanas también está desplegado en este release a partir de una corrección quirúrgica de archivo.
- **Web**: `/var/www/beatgaler-web/releases/native-1ceb9c39` como symlink público; `https://beatgaler.com/` HTTP 200. Este build tiene el catálogo nativo habilitado, **pero no** las adiciones posteriores de botones de proveedor en la pantalla «Crear cuenta».
- **Worker**: `beatgaler-catalog-worker.service` `enabled` + `active`; wrapper `/usr/local/bin/beatgaler-catalog-worker-start`; arranque independiente de Cloud y reinicio `on-failure`. Tiene gateway de bots de Telegram y PostgreSQL activos.
- Flags productivos comprobados: `BEATGALER_CATALOG_NATIVE_ENABLED=true`, `BEATGALER_CATALOG_GATEWAY_ENABLED=true`, `BEATGALER_CATALOG_DIRECT_ENABLED=true`, `BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED=true`. El worker utiliza además `BEATGALER_CATALOG_WORKER_ENABLED=true`. **No marcar `BEATGALER_CATALOG_G2_APPROVED` como verdadero**.
- Tablas SQL: `schema_migrations=42`; `users=2`, `vaults=2`, `catalog_libraries=2`; suma de `active_count=2`, `pending_count=0`, `trash_count=0`.
- `catalog_beats`: **2 ACTIVE**. `catalog_transfer_operations`: **2 COMMITTED**. `catalog_operation_parts`: **4 VERIFIED**. `catalog_jobs`: **4 TRANSFER_VERIFY DONE + 2 TRANSFER_COMMIT DONE**, ningún otro estado presente en la consulta.
- Heartbeat del worker: `running=0`, `backlog=0`, `leased=0`, `blocked=0`, `expiredLeases=0`. Los 3 reintentos registrados al arrancar fueron transitorios (`LIBRARY_BUSY` / `NOT_READY`); **no** son jobs pendientes ni bloques actuales.
- `transport_bots`: Bot01/02/03 con `quarantined=false` y `rotation_pending=false`. **2 membresías listas** en vaults nativos.

**No incluir en GitHub** tokens, ID de chats, sesión MASTER, correos, contraseñas, connection strings, JSON de usuarios ni nombres de archivos personales.

## 3. Secuencia comprobada y por qué dos archivos se quedaban cargando

1. **Pre-corte:** PostgreSQL preparado con respaldo en S3 privado, cifrado SSE-KMS, Object Lock; el respaldo de los **5 usuarios/5 vaults/28 beats legacy de prueba** se conservó para recuperación de SQL. La versión del esquema pasó de 0041 a **0042** (`REUSED_UNROTATED`). El propietario autorizó usar los bots existentes sin rotar.
2. **Activación atómica:** se detuvo el Cloud legacy y se ejecutó en una transacción la eliminación de **esos 5 usuarios de prueba** junto a `catalog_native_activation`. La comprobación posterior mostró cero usuarios anteriores y activación nativa única. No se borraron archivos de Telegram. SSM del corte: `359fa7a1-ea32-4c02-b89a-870cf0f355d8`.
3. **Publicación:** nueva Web y Cloud nativos desplegados, con HTTPS y `/readyz` HTTP 200; respaldo inmediatamente posterior `bk-20261120T063559-17251` (esquema 42; aún sin cuentas nuevas). **No** hubo reversión a INDEX.
4. **Inicio con X:** el reinicio de cuentas de prueba dejó asociaciones de instalaciones obsoletas; el endpoint bloqueaba OAuth con 403. Se corrigió el filtro de instalaciones sin dueño vigente. La ruta OAuth pública pasó a 200 en una instalación previamente bloqueada; el propietario confirmó que podía iniciar sesión.
5. **Primer fallo de subida:** las 2 bibliotecas nuevas tenían chat Telegram y registro PostgreSQL, pero `transport_bot_id=NULL`. Se añadieron asignación persistente, lock por vault, alta/promoción de membresía real en Telegram y prueba por bot; en producción **2/2 READY** (Bot01 y Bot02). Cloud actualizado a `native-0e86aa42`; bloque de pruebas 26/26 PASS.
6. **Segundo fallo de subida:** el propietario envió **dos beats**, visibles en Telegram, pero la Web seguía mostrando progreso. La inspección encontró **2 IMPORT VERIFYING**, **4 partes RECEIPT**, **4 TRANSFER_VERIFY + 2 TRANSFER_COMMIT QUEUED**, con **0 intentos**: el worker SQL nunca se había iniciado. **No se reenviaron los archivos**.
7. **Corrección definitiva:** se instaló y habilitó `beatgaler-catalog-worker.service` con gateway de medios de los bots existentes. El worker verificó las cuatro partes de Telegram y confirmó las dos operaciones. SQL pasó a **2 ACTIVE, 0 PENDING**, con **6/6 jobs DONE** y 0 bloqueados. SSM de activación del worker: `7e2eef2c-8a11-4b9d-8fe5-4338a2907dcd`. El propietario confirmó que el resultado ya funcionaba.
8. **Respaldo final con datos nuevos:** ver sección 4. El trabajo administrativo se realizó **sin rotar bots, sin eliminar medios y sin declarar falsamente PASS de G2**.

El catálogo **no depende de INDEX para listar o modificar beats nuevos**. El worker requiere estar en servicio para cerrar los recibos y convertir una transferencia en beat `ACTIVE`; Cloud saludable por sí solo no garantiza esa finalización.

## 4. Recuperación y respaldos conservados

| Respaldo | Contenido observado en su manifiesto | Uso |
| --- | --- | --- |
| `bk-20261120T053050-29892` | 42 migraciones; 5 usuarios, 5 vaults, 28 beats legacy | **Antes** de descartar usuarios de prueba / corte irreversible |
| `bk-20261120T063559-17251` | 42 migraciones; 0 usuarios, 0 vaults, 0 beats | Inmediatamente **después** de activar PostgreSQL |
| **`bk-20261120T075417-26296`** | **42 migraciones; 2 usuarios, 2 vaults; 2 beats ACTIVE, 4 versiones de archivo, 4 media objects** | **Backup post-live actualizado**, tras comprobar ambas subidas |

**Respaldo final S3**: bucket privado `beatgaler-catalog-backups-403659231201-us-east-2`, prefijo `bk-20261120T075417-26296`. Tres objetos comprobados: `.dump` (448.708 bytes), `.manifest.json` (685 bytes), `.manifest.json.sha256` (105 bytes). Unidad de backup ejecutada con `Result=success`, `ExecMainStatus=0` y `BACKUP_UPLOADED` (SHA-256 de dump según log de backup: `5e5791c35cb35747089f49f29ac475e1c755db9eda28e63ee6b3a8bb39c55b51`).

- Timer `beatgaler-pg-backup.timer`: **enabled/active**, programación diaria 03:15 UTC. El dump y el manifiesto se almacenan en S3 con cifrado. El respaldo **contiene metadatos y referencias**: los **bytes de audio/portadas/PROJECT siguen en Telegram**, no se copian a S3.
- Los backups anteriores se conservan; **no hay restauración automática hacia INDEX**. Ante incidente de archivos, evitar borrados o reenvíos a ciegas.
- Se ensayó previamente una restauración PostgreSQL en destino aislado y se informó PASS en [estado de producción previo](ESTADO-PRODUCCION-2026-11-19.md). **No se repitió el restore del dump final de 2 beats** en este cierre.

## 5. Operación y comprobaciones rápidas

```bash
# Salud sin usar contraseñas ni leer sesiones
systemctl is-active beatgaler-cloud.service
systemctl is-enabled beatgaler-catalog-worker.service
systemctl is-active beatgaler-catalog-worker.service
curl -f -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/readyz
curl -f -o /dev/null -w '%{http_code}\n' https://beatgaler.com/
systemctl is-active beatgaler-pg-backup.timer
journalctl -u beatgaler-catalog-worker.service --no-pager -n 50
```

En un fallo de subida, **primero** revisar `catalog_transfer_operations.status`, `catalog_operation_parts.dispatch_state` y `catalog_jobs.state/attempts/last_error`; después comprobar la salud del worker y de su bot asignado. **No subir el mismo archivo otra vez ni reenviar mensajes inciertos** antes de entender los recibos. En `RECONCILE`, la adopción sin unicidad demostrada continúa bloqueada (E5). Evitar reversión de Cloud/Web sin cotejar esquema, versión y datos nuevos: **no existe rollback automático seguro del catálogo a INDEX**.

## 6. Gates, riesgo aceptado y límites del cierre

- **G0 / T05-N:** PASS históricos en sus contextos de laboratorio/CI.
- **G2 / T11:** E2, E3, E4 y E6 PASS en el sandbox correspondiente; E5 mitigado mediante bloqueo de adopción sin prueba de unicidad; E8 riesgo confirmado; E7 omitido por decisión del propietario (**no rotar tokens / no Bot20**). Resultado formal de G2 **NOT_PROVEN**, aunque las 2 subidas reales a Telegram se hayan confirmado.
- **G3 / T16:** implementación y pruebas automatizadas previas, pero falta dictamen final de las pruebas manuales V09 y accesibilidad.
- **G4 / T19:** copia SQL cifrada y restore aislado previos demostrados; S3 y timer funcionando con backup actual. No se demuestra backup de bytes Telegram ni restore del último dump.
- **T17:** proceso formal original omitido por decisión del propietario; se usó la ruta operativa `REUSED_UNROTATED` y activación comprobada, **sin convertir la omisión en PASS**.
- **T20:** 500 beats/biblioteca aceptados como alcance de lanzamiento; 1M permanece limitación de rendimiento conocida.
- **T23 (corte):** **EJECUTADO / LIVE**.
- **T24–T25 (operación progresiva y limpieza legacy):** no declarados completos. Se mantiene desactivada la eliminación física automática de medios; retirar rutas antiguas de bytes es obligación técnica pendiente y requiere revisión dedicada.

**Conclusión formal:** **MIGRACIÓN A PRODUCCIÓN LIVE CONFIRMADA. CIERRE OPERATIVO PASS. CIERRE TOTAL DE DEUDA LEGACY/GATES PENDIENTE.** No reabrir el proyecto de migración desde cero para resolver el backlog posterior; hacerlo mediante tareas pequeñas separadas y con evidencias propias.

## 7. Evidencia y archivos de referencia

- [Registro detallado de AWS, pasos y reparaciones](ESTADO-PRODUCCION-2026-11-19.md).
- [Pendientes post-live y criterios de aceptación](PENDIENTES-POST-LIVE-2026-11-20.md).
- [Arquitectura de módulos](ARQUITECTURA.md); [runbook histórico](MIGRACION.md).
- [Evidencia histórica E01–E86](EVIDENCIA.md); [tareas y gates](TAREAS.md).
- Rutas runtime: `cloud-server/catalog/authority.js`, `operations.js`, `worker.js`, `transport-gateway.js`, `native-transport-provisioning.js`, `cloud-server/catalog-worker.js`, `cloud-server/direct-transport-control.js` y `cloud-server/catalog-gateway-runtime.js`.
- Evidencia AWS no secreta: SSM `359fa7a1-ea32-4c02-b89a-870cf0f355d8` (corte), `7e2eef2c-8a11-4b9d-8fe5-4338a2907dcd` (worker), manifiestos cifrados en S3 arriba indicados, queries de conteo SQL 20 nov ~07:51 UTC, health del worker y HTTP público 200.

**Alcance de este commit:** solo documentación en `local/landing-gallery-unificada`. No cambia AWS, DB, Telegram, Web, Cloud, worker, flags ni `main`.
