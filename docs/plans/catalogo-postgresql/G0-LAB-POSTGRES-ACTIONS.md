# G0 — Laboratorio PostgreSQL desechable en GitHub Actions

## Propósito y alcance

Preparar **exclusivamente el descriptor de entorno** de catálogo antes de T01/T02. Workflow `/.github/workflows/catalog-g0-postgres-probe.yml`, agregado a la rama `local/landing-gallery-unificada`; sin desplegar, no checkout de código, sin AWS, Telegram, bases reales, migraciones, ni `DROP`.

## Disparador y aislamiento

- Único disparador que puede trabajar en esta rama nueva: `push` a `local/landing-gallery-unificada` **con cambio en el propio archivo de workflow**; el primer commit intentará iniciar una sola prueba. `workflow_dispatch` figura para reutilización futura, pero **GitHub exige que el workflow exista en `main`** para habilitar el arranque manual. No añadirlo a `main` solo para activar ese botón.
- `if` de defensa por repo/ref. Job en `ubuntu-24.04`, contenedor cliente `postgres:16@sha256:c1b3783309b6499c795eed7c20135a1a4d25cae1b575c3d52c6f536129a1b109` y service PostgreSQL **con ese mismo digest**. Referencia anclada al workflow existente de Direct; la versión puntual se determina al ejecutar.
- Servicio sin publicación de puertos al host del runner; conexión exclusivamente por hostname `postgres` en red del job. Base `beatgaler_catalog_g0_probe`, rol `catalog_g0_probe`, contraseña pública ficticia **solo de contenedor efímero**; sin `DATABASE_URL`, secrets, OIDC ni permisos de escritura GitHub.
- Verificar repo/ref/host/puerto/nombre DB/rol antes de conectar. SQL fail-closed de versión principal PostgreSQL 16, UTF8 y conexión TCP al service. Crear únicamente `catalog_g0_probe.run_marker` y `pg_trgm` en esa base desechable, imprimir descriptor seguro y resumen en Actions.
- Este es **un probe G0**. No es el arnés de T02, no tiene marker resistente ante URL externa, usuario SQL mínimo ni limpieza selectiva; el runner destruye el servicio al terminar. El flujo T02 debe implementar garantías de ownership, idempotencia, no borrado ajeno y tests real PostgreSQL.
- El workflow no usa `actions/checkout` ni ejecuta ninguna ruta del repositorio. No prueba compatibilidad funcional de catálogo ni performance.

## Lectura del resultado

Verificar Actions → “Catalog G0 - Disposable PostgreSQL 16 Probe (LOCAL)” → run del commit que lo introdujo → job summary. Registrar fecha, SHA, run URL/ID, server_version, server_encoding, lc_collate, lc_ctype, pg_trgm instalado, DB/rol y run marker. **Sin una ejecución completada PASS, `STOP-ENV` sigue abierto.**

## Estado

Workflow **preparado**, ejecución real e identidad de DB **a confirmar** leyendo el run. El baseline T00 pasó; C12 se delega por el documento [G0-C12-IDE-MASTER-PROMPT-20261107.md](G0-C12-IDE-MASTER-PROMPT-20261107.md). No autoriza T01.
