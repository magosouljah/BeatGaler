# G0 — Descriptor PostgreSQL aislado verificado

**Fecha:** 2026-11-07. **Estado: PASS para el reconocimiento de entorno G0, NO para migración/catálogo funcional.**

## Identidad de la ejecución

- GitHub Actions: [run 42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955), estado **completed/success**, job `postgres-g0-probe` con todos los pasos PASS.
- Rama exclusiva `local/landing-gallery-unificada`, SHA exacto probado `758669a4ca0df1f0b3f5cce6abef703e3ab10047`.
- Workflow `.github/workflows/catalog-g0-postgres-probe.yml`, activado por `push` a LOCAL al cambiar el propio YAML. Restricción adicional de repo/ref en el job.
- Runner GitHub Actions `ubuntu-24.04`; contenedor cliente y service PostgreSQL `postgres:16@sha256:c1b3783309b6499c795eed7c20135a1a4d25cae1b575c3d52c6f536129a1b109`.
- Sin `actions/checkout`, credenciales AWS/Telegram, `DATABASE_URL`, servicios de producción, despliegue ni tráfico hacia una base real. Servicio sin puertos publicados en el host; red aislada del job.

## Descriptor observado (log SQL, no estimación)

| Campo | Valor |
| --- | --- |
| `server_version` | `16.15 (Debian 16.15-1.pgdg13+2)` |
| `server_encoding` | `UTF8` |
| `pg_database.datcollate` | `en_US.utf8` |
| `pg_database.datctype` | `en_US.utf8` |
| `pg_trgm` default/instalada | `1.6 / 1.6` |
| Base de datos | `beatgaler_catalog_g0_probe` |
| Rol | `catalog_g0_probe` |
| Marcador SQL | `42416790955` con HEAD `758669a4ca0df1f0b3f5cce6abef703e3ab10047`, verificado por segunda consulta exacta |

Se crearon exclusivamente `catalog_g0_probe.run_marker` y extensión `pg_trgm` en la base descartable. El marcador de ejecución y SHA se verificó; los contenedores y la red se retiraron al terminar. No hay base persistente disponible para conectar después. El runtime SQL del catálogo futuro se preparará en T02, con un arnés dedicado que deberá repetir guardas de base/rol/marcador, privilegios y cleanup aislado.

## Diagnóstico del primer intento

[Run 42416620409](https://github.com/magosouljah/BeatGaler/actions/runs/42416620409) terminó FAIL solo porque `lc_collate` se consultó con `current_setting` (no disponible como GUC de PostgreSQL 16). Se cambió por `pg_database.datcollate/datctype` y el run siguiente pasó. No se alteraron esquemas legacy ni datos reales.

## Estado y límites

- **STOP-TEST del baseline T00:** resuelto (68/68 pruebas, 25/25 mutaciones), con aviso React `act` pendiente de limpieza de fixture.
- **STOP-ENV del descriptor de laboratorio G0:** **RESUELTO** para versión, collation, encoding, extensión, identidad y aislamiento de servicio desechable. Esto **no** prueba restore/backup, RPO/RTO, performance ni integración PostgreSQL de catálogo.
- **STOP-DESIGN C12:** **pendiente** de cierre documentado por IDE inteligente. Ver `G0-C12-IDE-MASTER-PROMPT-20261107.md`.
- **T00 global:** NO PASS hasta cerrar C12 y registrar gate formal; **G0: NO APROBADO** aún, **T01: BLOQUEADA**.
- **T02:** no iniciado; no usar tests históricos destructivos fuera del arnés. Antes de publicar catálogo deben verificarse backup real, límites de capacidad y seguridad tenant.

**No se ha modificado** producción, AWS, Telegram, MASTER, transport bots, Landing, Gallery, Playbar ni base de usuario.
