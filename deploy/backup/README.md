# Backups del catálogo PostgreSQL de BeatGaler (G4)

> **Estado AWS verificado (2026-11-19):** bucket S3 cifrado y protegido desplegado; timer diario activo en EC2; backup real y restauración aislada desde S3 **PASS**; PostgreSQL ahora tiene 41 migraciones. Los medios Telegram siguen sin segundo respaldo (riesgo aceptado). **El catálogo nativo de la aplicación todavía NO está activado**. Véase [registro de despliegue](../docs/plans/catalogo-postgresql/ESTADO-PRODUCCION-2026-11-19.md).

## Qué respalda y qué NO respalda

| Dato | Dónde vive | ¿Lo cubre este backup? |
| --- | --- | --- |
| Catálogo: beats, nombres, tags, BPM/key, versiones, referencias a archivos (ids de mensaje/hashes), papelera, operaciones, journal de purga, cuentas y bibliotecas | **PostgreSQL** | **Sí** (`pg_dump`, cifrado, en S3) |
| **Bytes de audio, portadas, WAV y PROJECT** | **Telegram** (chat del vault) | **No.** S3 **no** respalda los audios. Si Telegram pierde un mensaje, el catálogo conserva el registro y su hash, pero los bytes solo se recuperan de otra copia propia (descarga periódica o segundo destino). Esa copia de medios es una decisión/estrategia aparte **no resuelta aquí**. |
| Journal externo de purga/transferencias | Almacén de journal (`BEATGALER_CATALOG_JOURNAL_DIR`) | Debe respaldarse junto con la base (se usa en la reconciliación tras un restore). |
| Frase de cifrado | Custodia del propietario (fuera del bucket) | Sin ella el backup no se puede abrir. Guardar copia aparte. |

**Restore ≠ medios:** `pg-restore.sh` recupera el catálogo; después `adopt-restored.cjs` lo deja en postura **HELD** (época+1, `restore_hold`, capacidades y concesiones revocadas, jobs a cola) y hay que **reconciliar** contra el journal externo y el proveedor (`reconcileRestore`/`verifyBytes`, T19-N) antes de abrirlo al tráfico. No existe rollback a INDEX.

## Piezas

- `scripts/backup/pg-backup.sh` — `pg_dump -Fc`, SHA-256, manifiesto (versión, migraciones, recuentos, checksum de filas), cifrado AES-256-CBC (PBKDF2 600 000) con frase de archivo, subida (`file://` o `s3://` con SSE-KMS), retención local.
- `scripts/backup/pg-restore.sh` — descarga, verifica hash del cifrado/manifiesto/volcado, descifra, `pg_restore --list`, crea una base **nueva** (el nombre debe contener `restore`; nunca sobrescribe), restaura, verifica contra el manifiesto y aplica `ANALYZE`.
- `scripts/backup/adopt-restored.cjs` — postura HELD sobre la base restaurada (`backup.js › adoptRestoredDatabase`).
- `scripts/backup/pg-drill.sh` — simulacro completo en el LAB (incluye corrupción, frase errónea, destino existente, retención).
- `deploy/backup/backup-bucket.cfn.json` — bucket S3 (versionado, Object Lock GOVERNANCE, SSE-KMS con rotación, bloqueo de acceso público, solo TLS, lifecycle de retención), clave KMS y dos políticas IAM mínimas: **escritor** (solo `PutObject`, sin leer ni borrar) y **lector** (solo `Get`/`List`).

## Programación (ejemplo, sin activar)

```cron
# diario 03:15 UTC; la frase y el destino vienen del entorno del servicio, no del crontab
15 3 * * * BACKUP_DB=beatgaler BACKUP_TARGET=s3://BUCKET/ BACKUP_PASSPHRASE_FILE=/etc/beatgaler/backup.pass S3_SSE_KMS_KEY_ID=… /opt/beatgaler/scripts/backup/pg-backup.sh >> /var/log/beatgaler-backup.log 2>&1
```

Objetivos propuestos (a validar por el propietario): **RPO ≤ 24 h** (backup diario; reducible con más frecuencia), **RTO** medido en el simulacro: ~6 s de restore para 500 beats (≈ 0,8 MB cifrados); extrapolar y re-medir con la base real. Retención: 35 días actuales + 90 días de versiones, Object Lock 14 días.

## Pasos para activarlo (requieren al propietario)

1. Crear cuenta/rol de despliegue con permisos acotados y elegir región y nombre de bucket.
2. `aws cloudformation deploy --template-file deploy/backup/backup-bucket.cfn.json --stack-name beatgaler-backups --parameter-overrides BucketName=…` (**no ejecutar sin autorización**).
3. Adjuntar `WriterPolicyArn` al rol del servidor de backups y `ReaderPolicyArn` al rol de restauración (otra credencial).
4. Generar la frase (`head -c 48 /dev/urandom | base64 > backup.pass; chmod 600`) y guardar una copia fuera del servidor.
5. Programar el cron/timer, ejecutar un primer backup y un **simulacro de restore en una base aislada** contra S3 (`BACKUP_SOURCE=s3://…`).
6. Alertar si no aparece un manifiesto nuevo en 26 h.
