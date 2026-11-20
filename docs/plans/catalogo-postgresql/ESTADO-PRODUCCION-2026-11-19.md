# BeatGaler — estado AWS del catálogo PostgreSQL, 19 noviembre 2026

Registro de acciones **ejecutadas y verificadas** en la cuenta AWS aprobada por el propietario. No sustituye los gates ni autoriza fingir evidencias.

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

## Bloqueos antes de activar Gallery en producción (T23)

1. Obtener acceso SQL de migración **autorizado**, sin extraer credenciales en chat. Los controles de seguridad de la conexión bloquearon los intentos de operar directamente con credenciales de proceso. **No eludir el bloqueo**.
2. Ejecutar la secuencia T17-N según `MIGRACION.md`: inventario, cerco de credenciales, política de tokens de Telegram con evidencia real, `activate`, rebind/reset o descarte permitido de las 5 cuentas. No falsificar `ROTATED`/`FRESH_BOTS`, PASS G2 ni manifest hash. La autorización de descarte no equivale a ejecución de borrado.
3. Sólo después de activación y transporte funcional, activar `BEATGALER_CATALOG_NATIVE_ENABLED` y los flags de transporte aprobados y publicar Web nativa. **No** encender solo la Web: devolvería catálogo no disponible.
4. Confirmar subida/lectura y salud Cloud; conservar ruta de reversión de arranque y snapshot. Las pruebas de piloto manual fueron dispensadas por el propietario; esto no sustituye los controles de integridad necesarios.

**Resumen:** G4 externo del PostgreSQL realizado; esquema y Cloud nuevos en producción, Web preparada; **T23 activación nativa de producto pendiente**, por credenciales/cerco y transporte Telegram.
