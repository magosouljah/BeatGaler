# Auditoría G0 — catálogo PostgreSQL en BeatGaler LOCAL

**Fecha:** 7 de noviembre de 2026. **Resultado:** NO APROBADO; T01 BLOQUEADA. Revisión estática y documental, sin tocar código, servicios, credenciales ni datos.

## Identidad y alcance

Repositorio `magosouljah/BeatGaler`, rama `local/landing-gallery-unificada`, HEAD fuente `edabd715664f9564346e95b8553b68b4ac411da9`, base `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`. GitHub confirma un único commit documental de siete archivos y **cero cambios en src, cloud-server, DESIGN, Player, paquetes o infraestructura**. El usuario confirmó en su PC la misma rama/HEAD, con `Claude outputs/` y `beatgaler-console.jpg` sin seguimiento. Se leyeron siete documentos, contratos C1–C12, T00–T25 y gates G0–G4. Los seis tests PASS descritos en E4 son históricos; aquí no se ejecutaron nuevos tests.

## Matriz de G0

| Componente | Resultado | Motivo |
| --- | --- | --- |
| Identidad Git y preservación frontend | PASS estático | Una actualización documental sobre 31861e6; sin merge. |
| Lectura y secuencia del plan | PASS documental | Siete archivos, 26 tareas, cinco gates. |
| Cloud y contratos legacy | PASS estático, no funcional | El código no cambió; necesita baseline real antes de T01. |
| Instancia PostgreSQL descartable | **STOP-ENV** | Falta descriptor verificado de instancia separada, versión, colación, `pg_trgm` y protección contra DB/credenciales reales. |
| Tests frontend, Direct y Cloud | **STOP-TEST** | No reejecutados; PR #151 mostraba Direct persistent FAIL y pruebas antiguas del preconnect global. |
| Semántica C12 y compatibilidad | **STOP-DESIGN** | Orden/Unicode, límites/SLO, `bgPage` offset→cursor y criterios de aceptación no aprobados. |
| Protección de producción | PASS de alcance | Ningún servicio o dato tocado; no prueba que G2/G4 sean seguros. |

## Riesgos técnicos confirmados en 31861e6

1. **INDEX todavía gobierna la Web:** `src/features/library/webLibrary.ts` obtiene, valida y recorre todo el INDEX antes de materializar página de 240 beats. Esto no es paginación en servidor.
2. **Filtros y sort solo de página:** `librarySelectors.ts` aplica búsqueda, inclusión ANY, exclusión, orden manual/name/BPM/rating a los beats ya cargados; catálogo debe consultar el conjunto completo por tenant y después limitar.
3. **Cambios observables de orden:** `manual` conserva posición de entrada, rating empata por orden manual y `name.localeCompare` no equivale necesariamente a `lower(name) COLLATE "C"` de C12. No aprobar normalización silenciosamente.
4. **Paginación `bgPage`:** `webLibraryNavigation.ts` usa offset persistido en URL; C5 propone keyset HMAC. Hace falta traducir con límites y manejo visible de bookmarks incompatibles, sin descargar INDEX ni recorrido ilimitado.
5. **Mutaciones legacy de INDEX:** `webGalerCloudTransport.ts` publica/commitea INDEX en import/edit/trash/restore; `webTransport.worker.ts` conserva replace. Las rutas Cloud/recovery/routing y clientes antiguos requieren cercado real por autoridad/era/epoch.
6. **SQL + red externa:** `library-index-publication.js` espera publish/verify de Telegram mientras mantiene transacción, y `atomic-library-index.js` retiene advisory lock externo. El nuevo catálogo no debe heredar esos patrones.
7. **Ledger ≠ catálogo:** migraciones 0015 y 0018 almacenan identidad, cuota, estados, purge y tombstones, no todos los metadatos, partes y referencias.
8. **Arranque y tests peligrosos:** `postgres-bootstrap.js` aplica migraciones automáticamente al habilitar PG; `postgres-live.integration.cjs` puede hacer `DROP SCHEMA public CASCADE`. Prohibido ejecutar con DATABASE_URL heredada.
9. **Roundtrip multipart/PROJECT:** normalización UI descarta información para catálogo sin pérdida; T01/T04 deben preservar wrappers, desconocidos, partes, ratings 0–255, tombstones SQL-only y campos ausentes/null.
10. **Validación pendiente de Direct:** `WebGalleryWorkspace.tsx` preconecta tras auth; tests antiguos esperan `src/main.tsx`. No reintroducir bootstrap global para forzar PASS.
11. **Codificación mojibake:** texto del anexo y apéndices estaba dañado; se reparó sin sustituir los contratos preexistentes.
12. **Dependencia circular documental:** G0 exigía DB creada antes de T01 aunque T02 crea arnés después de T01. Corrección: G0/T00 validan descriptor/aislamiento; T02 crea las DB efímeras solo después de T01.

## Contrato preservado

Autoridad única por biblioteca `LEGACY`/`POSTGRES`, Telegram para bytes; metadata SQL sin Telegram; `authority_era` y `epoch`; versiones por beat, idempotencia, aislamiento de cuentas, preservación sin pérdida, backups/rollback, fencing de transportes, limpieza apagada y sin cambios productivos. `PG_ACTIVE` de notas históricas pasa al enum contractual `POSTGRES`.

## Condiciones para abrir T01

**NO-GO hasta T00 PASS** con autorización separada. T00 debe fijar SHA e instrucciones aplicables, descriptor seguro PostgreSQL (sin conectar a entornos reales), reproducir baseline no destructivo de Web/Auth/Gallery/Playbar/Cloud/Direct y clasificar el FAIL #151, cerrar explícitamente C12 (orden, filtros, Unicode, compatibilidad `bgPage`, límites/SLO), y registrar comandos/resultados en ESTADO. T01 crea mapa/fixtures tras T00; T02 crea el arnés SQL después de T01. Ni G0 ni estas correcciones autorizan implementación o servicio real.
