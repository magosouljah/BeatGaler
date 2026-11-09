# T16 — Integrar arranque y cercado exhaustivo (2026-11-09, encargo con fakes; V08 simplificada; V09 pendiente)

**Alcance:** T16 según [TAREAS](TAREAS.md) §T16, [MATRIZ-T](MATRIZ-T-NIVELES-20261107.md) §T16, [MATRIZ-V](MATRIZ-V-NIVELES-20261107.md) V08 (simplificada por [NATIVO r2.1](NATIVO-POSTGRES-20261108.md) §10 T16) y V09, [CONTRATO](CONTRATO.md) C10 y NATIVO §5.1 (capas 0/1/2), §11 (guarda hacia delante) y §12. Base: `0c3cab2` (T15 CI PASS aislado). **Encargo explícito de Sol con fakes:** sin despliegue, sin gateway real, flags apagados por defecto; T11 NO PASS; G2/G3/G4 NO demostrados. **V09 (navegador real + lector) no es ejecutable en este entorno: queda PENDIENTE con manifiesto [V09-MANIFIESTO-20261109.md](V09-MANIFIESTO-20261109.md); por tanto T16 no es PASS.**

## 1. Entregado

| Pieza | Archivo | Resumen |
| --- | --- | --- |
| Capa 2 de sesión | `cloud-server/catalog/session-guard.js`, `server-core.js` (`/transport/session/start`) | Con el flag nativo encendido, un dueño con fila de catálogo debe declarar `protocol: catalog-v1`; otro protocolo o ninguno → **410 `LEGACY_CLIENT_UNSUPPORTED` antes de `migrateLegacyProjects`/Direct/Telegram**. La respuesta `catalog-v1` lleva `catalog{protocol, authority_era, authority_epoch}` y sin credenciales (T05-N §8.5). Flag apagado → la capa 2 no actúa (interruptor no destructivo); capa 1 y capa 0 siguen. |
| Guarda hacia delante | `postgres-migrations.js` (`assertKnownMigrations`), `postgres-bootstrap.js` | Tras aplicar las migraciones conocidas, si `schema_migrations` contiene versiones que este binario no conoce → `CATALOG_SCHEMA_AHEAD` y el arranque se niega (pool cerrado, `onMigrationError`). Solo lee. |
| Montaje | `server.js`, `server-core.js`, `catalog-worker.js`; singletons `configure/current` en `media.js`, `purge.js`, `transport.js` | `/catalog/v1` monta operations, transport, playback, media y purge. **Gateway nulo** (fail-closed): capacidades/medios → 503 `TRANSFER_UNAVAILABLE`; jobs de verificación/purge en reintento visible, nunca éxito. `BEATGALER_CATALOG_GATEWAY_ENABLED=true` sin adaptador real → STOP-ENV al arrancar. Journal en disco solo con `BEATGALER_CATALOG_JOURNAL_DIR`. El worker separado inyecta purge sin gateway. |
| Startup por autoridad | `library-index-publication.recoverAll`, `direct-index-pin-authority.ensureAll`, `migrateLegacyProjects` | Ya saltan los vaults con catálogo (T05-N, capa 2 anticipada); verificado y cubierto por la prueba de dos bibliotecas. `startup-routing-index` sigue siendo LEGACY-only (no se consulta en la rama POSTGRES). |
| C10 | `legacy-fence.js` (T05) + capa 2 | Cobertura por entradas: `index/publish|commit|bootstrap-state|recover|ensure-bootstrap`, `quota/*`, `trash/purge`, `topic/delete|ensure`, `project/authorize|upload`, emisión de capacidades `get_index|replace_index|delete_messages` (boundary), `session/start` (nuevo). Probado por helpers y por el handler real (vm). |
| Cliente V08-A (simplificada) | `src/features/library/catalog/LibraryCompositionGate.tsx`, `catalogLibraryProvider.tsx`, `CatalogGalleryWorkspace.tsx`, `src/app/WebGalleryWorkspace.tsx` | Flag `VITE_CATALOG_API_ENABLED` apagado → árbol LEGACY **exactamente igual** (pager + App) y 0 peticiones; encendido → `/context` antes de montar: POSTGRES monta el workspace del catálogo (Gallery virtualizada V05 sobre el store V04, InteractionStore V07-A, sesión musical V06, medios T14, mutaciones T13, transferencias T12; **sin pager, sin cache global de beats, sin INDEX**); bloqueado/desconocido → estado visible con copy de plan B §7, nunca LEGACY; cambio de cuenta → teardown de todos los servicios y remontaje por clave. |
| Pruebas | `catalog-fence.test.cjs` (5), `catalog-fence.integration.cjs` (4, PG), `tests/component-dom/catalogLibraryComposition.test.tsx` (4), `direct-session-start-index-degraded.test.cjs` (contexto vm actualizado) | Suite `T16`; casos `unit`; `runner.test` T03..T16. |

## 2. Reglas verificadas

- **Dos bibliotecas (NATIVO §10 T16):** nativa + vault no elegible (RESET_REQUIRED declarado por `resolveContext`/`provisionLibrary` sin crear filas) + legacy, con el flag apagado: la API nativa responde 503 `NATIVE_FLAG_DISABLED` sin tocar datos; la capa 1 devuelve 410 en **todas** las entradas C10 por usuario y por chat para la nativa y deja pasar a las legacy.
- **Telegram caído:** gateway nulo → 503 en transferencias/medios; la metadata y las mutaciones SQL siguen; los jobs de verificación quedan en reintento visible (`TRANSPORT_UNAVAILABLE`), nunca `VERIFIED`.
- **Aislamiento:** la cuarentena del flush (§6.2) cierra solo esa biblioteca (lectura y escritura `VAULT_QUARANTINED`); la sana sigue. (`REVIEW` no existe en nativo: 0027 exige `IDLE`.)
- **Reinicio del worker:** lease vencido → otro worker termina el job; el worker viejo recibe `LEASE_FENCED`.
- **Guarda hacia delante:** versión desconocida en `schema_migrations` → `CATALOG_SCHEMA_AHEAD`; la guarda no escribe.
- **Cliente:** unknown/blocked nunca monta LEGACY; espías `get_index`/`replace_index` = 0 en la rama POSTGRES; teardown por cuenta observable (store vacío, selección y ronda liberadas).

## 3. Decisiones D-T16

- **D-T16-1:** el gateway real no se construye en T16 (requiere sandbox T11 fase B): los módulos se montan con `gateway: null` y responden fail-closed; activar `BEATGALER_CATALOG_GATEWAY_ENABLED` sin adaptador detiene el arranque.
- **D-T16-2:** V08 se entrega "simplificada": puerta de composición + provider de servicios + workspace POSTGRES con tarjetas mínimas; GalleryChrome/Playbar/Drawer sobre los servicios del catálogo y la paridad visual son integración pendiente antes de V09 (no se toca la UI aprobada: con el flag apagado nada cambia).
- **D-T16-3:** el vm test del handler `session/start` (T05) carecía de `respondLegacyFence` en su contexto; al añadir la capa 2 se completó el contexto con un no-op y se cubrió el 410/200 en `catalog-fence.test`.
- **D-T16-4:** `library_quota_state`/`library_beats` no se escriben para vaults nativos (capa 0); la prueba de RESET_REQUIRED usa un vault no elegible sin fila de catálogo, como ocurre en real.

## 4. Resultados (LOCAL/LAB, FAKE)

- `catalog-check unit` 121/121 (22 casos), `faults` 21/21, `runner.test` 9/9 (T03..T16 activas), `catalog-fence.test` 5/5, `direct-session-start-index-degraded` 5/5, vitest `catalogLibraryComposition` 4/4, `TYPECHECK_PASS`, esquema 33 migraciones.
- **LAB** (PG 18 WSL): `catalog-fence.integration` **4/4**.
- **No demostrado / pendiente:** V09 (navegador real, lector de pantalla, capturas vs LOCAL, 0 skips) → **T16 no PASS**; G3 (dictamen de Sol) pendiente; gateway real y G2 (T11 fase B); paridad visual de la rama POSTGRES; consumer-map T01 no se regeneró (su generador no está en el repositorio); V09-C.

**Siguiente:** T17 (CLI nativa `inspect`/`activate`/`reset`/`rebind-chat`, dry-run por defecto) con fakes; V09 cuando exista el entorno de navegador real.
