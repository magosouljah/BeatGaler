# Preparación de programación G4 (sin despliegue)

Estos archivos son **plantillas** para un servidor Linux con systemd. No se ejecutan ni activan al quedar en Git. El destino S3 todavía necesita una autorización específica de AWS. No inspeccionar ni modificar producción sin permiso.

1. Revisar el **entorno real** y la versión final de `pg-backup.sh`. Corregir/comprobar que los recuentos del manifiesto correspondan exactamente al snapshot de `pg_dump` durante escrituras concurrentes; una ejecución sin escrituras no prueba este caso.
2. Desplegar el bucket/clave KMS desde `deploy/backup/backup-bucket.cfn.json` en la cuenta y región **aprobadas**, de preferencia con identidades IAM separadas (escritura sin lectura/borrado, restauración con lectura).
3. En el host aprobado: crear el usuario/grupo sin privilegios `beatgaler-backup`, instalar PostgreSQL client, AWS CLI, OpenSSL, y copiar código a `/opt/beatgaler`. Configurar credenciales RDS de solo lectura suficientes para `pg_dump`, el rol IAM de escritura y los tres archivos privados `/etc/beatgaler/catalog-backup.env`, `.pgpass` y `.pass`, con permisos adecuados. Guardar otra copia de la frase fuera del servidor.
4. Copiar `beatgaler-pg-backup.service` y `beatgaler-pg-backup.timer` a `/etc/systemd/system/`. **Antes de habilitar el timer** ejecutar un backup manual; comprobar los tres objetos `bk-*.dump.enc`, `bk-*.manifest.json`, `bk-*.manifest.json.sha256` en S3.
5. Desde un entorno **aislado** con credenciales de lectura, ejecutar `BACKUP_SOURCE=s3://BUCKET/catalog/ bash scripts/backup/pg-restore.sh BACKUP_ID base_restore_test`, con `PGHOST/PGUSER` dirigidos a una instancia desechable y `BACKUP_PASSPHRASE_FILE` disponible. Verificar hash, recuentos y que se aplique `adopt-restored.cjs` (estado HELD). Nunca dar acceso de escritura a la base restaurada sin reconciliar journal externo y referencias de Telegram.
6. Tras evidencia PASS y permiso de activación del timer: `sudo systemctl daemon-reload && sudo systemctl enable --now beatgaler-pg-backup.timer`. Verificar `systemctl list-timers`, última ejecución y alarma si no existe backup completo nuevo antes de 26 horas.

No habilitar cleanup físico de Telegram como parte de estos pasos. La aprobación del propietario de mantener una sola copia de bytes en Telegram **no** constituye una prueba de respaldo de esos bytes.
