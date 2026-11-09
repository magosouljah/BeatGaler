# Estado de ejecución y transferencia

**V08 completa y V09 ejecutada en Chrome real (2026-11-09, LAB aislado, FAKE):** ver [E36](EVIDENCIA.md), [T16-INTEGRACION §5](T16-INTEGRACION-20261109.md) y [V09-INFORME](V09-INFORME-20261109.md). La rama POSTGRES monta el shell aprobado (GalleryChrome, BeatCards virtualizadas, Playbar con `useAudio`, Drawer) sobre los servicios del catálogo; 8 hallazgos reales corregidos con prueba (job ids/gramática de partKey, overlay de arranque, Tag Bar, base URL de comandos musicales, prewarm legacy, lectura corta de medios, avisos del track). V09: 14/14 PASS en Chrome; Edge, lector de pantalla, zoom 200 %, táctil y reduced-motion NO EJECUTADOS (STOP-ENV parcial). **T16 sin PASS formal: evidencia entregada para el dictamen G3 de Sol; ningún gate superado; T11 NO PASS.** Siguiente: CI con suites T12–T16 (E36-b).

**T17 implementada en LOCAL con fakes (2026-11-09):** ver [E35](EVIDENCIA.md), [T17-CLI-NATIVA](T17-CLI-NATIVA-20261109.md) y [MIGRACION §T17-N](MIGRACION.md). CLI nativa `inspect` (solo lectura, inventario SQL con hash, R12), `activate` (precondiciones §3.1/§5.0 verificables en SQL, idempotente), `rebind-chat` (única vía de cambio de chat; auditoría 0034) y `reset` (TOCTOU, chat por rebind, generaciones RETIRED sin DELETE, `reset-<uuid>` RESET; nunca vacía una biblioteca nativa), dry-run por defecto. LAB 3/3 + regresión; unit/faults PASS; ayuda exacta documentada. **FAKE: sin entorno real ni Telegram; R1 y lista marcada por el propietario pendientes; ningún gate superado; T11 NO PASS; G2/G3/G4 NO demostrados.** **CI aislado PASS** (run `42602179347`, `e0ff02b`; [E35-b](EVIDENCIA.md)). Encargo T12–T17 cerrado en LOCAL/CI aislado; T19–T21 fuera de este encargo (requieren autorización de Sol).

**T16 implementada en LOCAL con fakes (2026-11-09), NO PASS por V09 pendiente:** ver [E34](EVIDENCIA.md), [T16-INTEGRACION](T16-INTEGRACION-20261109.md) y [V09-MANIFIESTO](V09-MANIFIESTO-20261109.md). Capa 2 de sesión (`session/start` exige `catalog-v1` con el flag encendido; 410 antes de Telegram), guarda de compatibilidad hacia delante (`CATALOG_SCHEMA_AHEAD`), montaje de todos los módulos `/catalog/v1` con gateway nulo fail-closed, composición por autoridad en el cliente (flag apagado → LEGACY idéntico; bloqueado/desconocido nunca LEGACY; teardown por cuenta). LAB 4/4; unit 121/121; faults 21/21; typecheck PASS. **FAKE: V09 requiere navegador real (pendiente); V08 simplificada; gateway real → T11 fase B; ningún gate superado; T11 NO PASS; G2/G3/G4 NO demostrados.** **CI aislado PASS de la implementación** (run `42598993878`, `481482e`; [E34-b](EVIDENCIA.md)); T16 sigue NO PASS por V09. Siguiente: T17 (CLI nativa `inspect`/`activate`/`reset`/`rebind-chat`, dry-run por defecto) con fakes.

**T15 implementada en LOCAL con fakes (2026-11-09):** ver [E33](EVIDENCIA.md) y [T15-PURGE](T15-PURGE-20261109.md). Purge durable C9 (`catalog/purge.js`, 0033): intención 202 con límite de papelera por revisión, enumeración completa, journal externo verificado antes de cada delete, prueba de ausencia por lector autorizado (MessageEmpty), PURGED con cuota liberada una vez, bloqueos con motivo (compartido/OPAQUE/retención/hold/flag/operación), cancel seguro, `restore_hold`. LAB 4/4 + regresión; unit 111/111; faults 21/21; typecheck PASS. **FAKE: cleanup real apagado; ningún gate superado; T11 NO PASS; G2/G4 NO demostrados.** **CI aislado PASS** (run `42596072903`, `d6ff236`; [E33-b](EVIDENCIA.md)). Siguiente: T16 (capa 2, guarda de compatibilidad hacia delante, montaje de módulos con flags apagados, V08 simplificada; V09 requiere navegador real) con gateway fake.

**T14 implementada en LOCAL con fakes (2026-11-09):** ver [E32](EVIDENCIA.md) y [T14-PLAYBACK](T14-PLAYBACK-20261109.md). Rondas Shuffle persistidas en servidor (`catalog/playback.js`, 0032: Fisher–Yates perezoso, RNG por rejection sampling, sequence CAS, replay, STALE/reconstrucción), acceso a medios por referencia con concesión por parte y `Range` desde el gateway (`catalog/media.js`), vecino por sort (I2), cliente de medios con refcount/LRU y sesión musical V06 sin RNG en cliente. LAB 6/6 (incl. N=20k), unit 106/106, vitest 6/6, typecheck PASS. **FAKE: ningún gate superado; T11 NO PASS; G2 NO demostrado; 100k/1M y latencias → T20.** **CI aislado PASS** (run `42591718372`, `0a5ffb4`; [E32-b](EVIDENCIA.md)). Siguiente: T15 (purge durable, retención y limpieza segura; cleanup real apagado) con gateway fake.

**T13 implementada en LOCAL con fakes (2026-11-09):** ver [E31](EVIDENCIA.md) y [T13-MUTACIONES](T13-MUTACIONES-20261109.md). `catalogCommandsApi.ts` + `catalogMutations.ts` (PATCH/lotes/import/reemplazo/referencias por cuenta, sin INDEX) + `catalogInteractionStore.ts` (V07-A: selección global server-side, editor con conflicto sin PATCH automático, bulk por lotes, drop por identidad, facetas, rename) con doble de comandos y 12 pruebas vitest + typecheck; espías legacy = 0. Composición de producto apagada (montaje en T16). **FAKE: ningún gate superado; T11 NO PASS; G2 NO demostrado.** **CI aislado PASS** (run `42587853433`, `349bd9a`; [E31-b](EVIDENCIA.md)). Siguiente: T14 (playback, artwork y descargas desde referencias SQL; rondas Shuffle en servidor) con gateway fake.

**T12 implementada en LOCAL con fakes (2026-11-09, encargo explícito de Sol para T12–T17):** ver [E30](EVIDENCIA.md) y [T12-TRANSFERENCIAS](T12-TRANSFERENCIAS-20261109.md). Capacidad de subida opaca (solo hash en SQL, un solo uso), secuencia C7 sin cliente SQL retenido durante hash/envío/verificación, PROJECT por MASTER con intención durable antes de publicar, journal de intentos con nivel GATEWAY (nunca etiquetado BYTES), cliente Web `catalogTransfer.ts` sin reenvío ante incertidumbre; corrección del filtro de tipos en `claimJobs`. LOCAL/LAB: unit 101/101, faults 16/16, integración T12 7/7 (LAB), vitest 4/4, typecheck PASS, suites PROJECT legacy intactas. **Etiqueta FAKE: T11 sigue NO PASS y G2 NO demostrado; ningún gate superado.** **CI aislado PASS** (run `42585776070`, `29b2823`; [E30-b](EVIDENCIA.md)). Siguiente: T13 (cliente de mutaciones sin INDEX, V07-A) con gateway fake.

**T11 fase A PASS técnico en CI (2026-11-09); bloque detenido en T12 (STOP-APPROVAL/STOP-GATE):** commit `e1ca7ad`, [run 42566052207](https://github.com/magosouljah/BeatGaler/actions/runs/42566052207) PASS: unit 93/93, faults 16/16, integration 2/2, T03–T10 verdes, T11 10/10 ([E29-b](EVIDENCIA.md)). T11 no es PASS y G2 no está demostrado. T12 requiere T11 PASS o encargo explícito de Sol limitado a mocks (TAREAS §T12, EJECUCION §4); T13–T21 dependen de T12. Pendiente: permiso de Purp para sandbox T11 fase B y/o encargo de Sol para T12–T17 con gateway fake.

**T11 fase A/MEDIA implementada en LOCAL (2026-11-09); fase B en STOP-APPROVAL:** ver [E29](EVIDENCIA.md) y [T11-TRANSPORTE](T11-TRANSPORTE-20261109.md). Adaptador del gateway (`catalog/transport-gateway.js`, SDK inyectado), servidor fake con forma gramjs, harness `scripts/catalog-transport-contract.cjs` (E1–E10 fake; sandbox cerrado por descriptor + aprobación), suite `T11` activa sin red ni PG. SDK `telegram` 2.26.22 registrado sin cambios. **T11 no es PASS y G2 no está demostrado** (E4/E7/E8 requieren sandbox real autorizado). Siguiente: T12 con gateway fake inyectado, sin PASS ficticio.

**T10 PASS técnico en CI (2026-11-09):** commit `7ed48a2`, [run 42564674616](https://github.com/magosouljah/BeatGaler/actions/runs/42564674616) PASS: unit 86/86, faults 13/13, integration 2/2, T03 14/14, T04 8/8, T05 24/24, T06 25/25, T07 16/16, T08 6/6, T09 13/13, T10 9/9, sin skips ([E28-b](EVIDENCIA.md)). El primer run (`ed72cd8`) falló por un spread de `pg Pool.options` sin password en un test, no por el worker ([E28-a](EVIDENCIA.md)). T11 en curso: contrato del gateway con fakes cerrados; sandbox real pendiente de permiso (STOP-APPROVAL / G2).

**T10 implementada en LOCAL (2026-11-09), PASS técnico LOCAL+LAB, CI pendiente del push:** ver [E28](EVIDENCIA.md) y [T10-WORKER](T10-WORKER-20261109.md). `catalog/worker.js` (claim/lease/generación, backoff y BLOCKED C8, efectos remotos sin SQL retenida, RECONCILE sin reenvío, jobs encadenados para conjuntos y bulk, health), entrypoint `catalog-worker.js` apagado por defecto, hooks de encolado en queries/commands/operations. Unit 4/4, faults 4/4, LAB integración 4/4 + regresión T02–T09 verde. Siguiente: T11 (fakes cerrados; sandbox real requiere STOP-APPROVAL/G2).

**T09 PASS técnico en CI (2026-11-09):** commit `e6bf040`, [run 42562934400](https://github.com/magosouljah/BeatGaler/actions/runs/42562934400) PASS: unit 80/80, faults 9/9, integration 2/2, T03 14/14, T04 8/8, T05 24/24, T06 23/23, T07 15/15, T08 6/6, T09 13/13, sin skips ([E27-b](EVIDENCIA.md)). **T10 en curso** (`catalog/worker.js`, `catalog-worker.js`, encolado de jobs desde T06/T07/T09).

**T09 implementada en LOCAL (2026-11-09), PASS técnico LOCAL+LAB, CI pendiente del push:** ver [E27](EVIDENCIA.md) y [T09-OPERACIONES](T09-OPERACIONES-20261109.md). 0030 (operaciones C7, partes con random_id, reservas, jobs C8), `catalog/operations.js` (IMPORT/REPLACE, recibo candidato, verificación con fencing, commit 202/200/409, cancel/RECONCILE, renew/readmit, jobs claim/renew/complete/fail), rutas de transferencia. Siguiente: CI con T09; luego T10 (worker con leases y pruebas de caída).

**T08 PASS técnico en CI (2026-11-09):** commit `767460b`, [run 42561000973](https://github.com/magosouljah/BeatGaler/actions/runs/42561000973) PASS: unit 77/77, faults 9/9, integration 2/2, T03 14/14, T04 8/8, T05 24/24, T06 23/23, T07 15/15, T08 6/6 (26 vitest + typecheck), sin skips ([E26-b](EVIDENCIA.md)). **T09 en curso** (0030 operaciones de transferencia/partes/reservas/jobs, `catalog/operations.js`).

**T08 implementada en LOCAL (2026-11-09), PASS técnico LOCAL, CI pendiente del push:** ver [E26](EVIDENCIA.md) y [T08-CLIENTE](T08-CLIENTE-20261109.md). Módulos del cliente en `src/features/library/catalog/` (API, geometría V03, store acotado V04, grid/hook/navegación V05, composición por flag apagada), 26 tests vitest + typecheck en la suite `T08`. Siguiente: CI con T08; luego T09 (intenciones, reservas y máquina de estados C7).

**T07 PASS técnico en CI (2026-11-09):** commit `6c3dadb`, [run 42559084665](https://github.com/magosouljah/BeatGaler/actions/runs/42559084665) PASS: unit 77/77, faults 9/9, integration 2/2, T03 14/14, T04 8/8, T05 24/24, T06 23/23, T07 15/15, sin skips ([E25-b](EVIDENCIA.md)). **T08 en curso** (cliente de lectura: `src/features/library/catalog/` — API, geometría V03, store V04, grid/navegación V05 en fixture; composición de producto apagada hasta T16).

**T07 implementada en LOCAL (2026-11-09), PASS técnico LOCAL+LAB, CI pendiente del push:** ver [E25](EVIDENCIA.md) y [T07-COMANDOS](T07-COMANDOS-20261109.md). 0029 (operaciones idempotentes, eventos, lotes ≤50, selección CAS), `commands.js` (PATCH/trash/restore atómicos, selección con rangos por sort, bulk por lotes con journal y conflicto externo, rename global, feed `/changes`), rutas de escritura con cabeceras C5. LAB: T07 6/6; regresión T03 6/6, T04 3/3, T05 9/9, T06 10/10. Siguiente: CI con T07; luego T08 (cliente de lectura/navegación/feed; V03–V05 en fixture).

**T06 PASS técnico en CI (2026-11-09):** commit `6af369c`, [run 42556542173](https://github.com/magosouljah/BeatGaler/actions/runs/42556542173) PASS: unit 72/72, faults 9/9, integration 2/2, T03 14/14, T04 8/8, T05 24/24, T06 23/23, sin skips ([E24-b](EVIDENCIA.md)). **T07 en curso** (0029 operaciones/eventos/selección, `catalog/commands.js`).

**T06 implementada en LOCAL (2026-11-09), PASS técnico LOCAL+LAB, CI pendiente del push:** ver [E24](EVIDENCIA.md) y [T06-API-CONTRATO](T06-API-CONTRATO-20261109.md). 0028 (ICU A1 real, proyecciones, índices de tupla), `/catalog/v1` montado (context, provision, beats keyset con resumeCursor/edge=last, detalle, files, navigation/legacy, facets, query-sets), cursores HMAC, EXPLAIN sobre 100k sin Sort. LAB: T06 10/10, regresión T03 6/6, T04 3/3, T05 9/9. Siguiente: CI `catalog-checks` con T06; luego T07 (PATCH/trash/restore, selección, rename, feed) sobre `requireLibraryForMutation`.

**T05-N PASS formal (dictamen de Sol, 2026-11-09) y modo de ejecución continua T06–T21:** Sol verificó el [run 42549450777](https://github.com/magosouljah/BeatGaler/actions/runs/42549450777) sobre `5392b2f` y declara T05-N PASS. Autoriza continuar T06→T21 de forma autónoma (commits normales y push fast-forward solo a `local/landing-gallery-unificada` para CI aislado; sin dictamen por tarea rutinaria; STOP solo ante integridad, arquitectura/producto sin resolver, gates con aprobación independiente o entornos reales; T23–T25 siguen fuera). `CLAUDE.md` §3/§7/§8 actualizados. **T06 en curso.**

**T05-N PASS técnico en CI (2026-11-09), dictamen de Sol pendiente:** commits `ecf7f59` + `5392b2f` en LOCAL (push fast-forward autorizado por Sol). [Run 42549450777](https://github.com/magosouljah/BeatGaler/actions/runs/42549450777) PASS: unit 60/60, faults 9/9, integration 2/2, T03 14/14, T04 8/8, T05 24/24, sin skips ([E23-b](EVIDENCIA.md)). T06 no se inicia hasta el dictamen.

**T05-N implementado en LOCAL (2026-11-09), PASS técnico LOCAL+LAB, PASS formal pendiente de CI (STOP-APPROVAL push):** ver [E23](EVIDENCIA.md). 0027 aditiva y condicionada; `resolveContext` solo lectura; `provisionLibrary` idempotente bajo el lock del vault; capa 1 (410) en todas las entradas C10 por helper y por ruta; capa 0 en DB; cascadas, rebind, cuarentena §6.2, §6.1 deshabilitado, guardas §12; sesión `catalog-v1` sin credenciales. Regresión LOCAL: unit 60/60, faults 9/9; LAB (PostgreSQL 18 efímero propio, no CI): T03 6/6, T04 3/3, T05 9/9. Código sin commit (requiere permiso); para el PASS formal hace falta autorizar un push a LOCAL que dispare `catalog-checks` (suites unit, faults, integration, T03, T04, T05) y el dictamen de Sol. T06 bloqueada hasta entonces.

**Rediseño nativo r2.1 VIGENTE y bloque T05–T21 autorizado (2026-11-08):** [CLAUDE.md](../../../CLAUDE.md) (actualizado 2026-11-08) declara [NATIVO-POSTGRES-20261108.md](NATIVO-POSTGRES-20261108.md) r2.1 como arquitectura nativa vigente y autoriza un bloque continuo de implementación T05–T21 **solo en LOCAL y CI efímero aislado**, sin push, despliegues, borrados ni servicios reales; T23–T25 requieren permisos independientes. El encabezado "PROPUESTA pendiente" de NATIVO r2.1 queda como texto histórico del documento: su vigencia la fija CLAUDE.md.

- Reconciliación Git **PASS**: HEAD `83b5abf983c4f51c0fddd71a45f3cbd755330fa9` (T04 PASS por CI 42530209790 sobre `3d291d5`; `83b5abf` solo documentación). 112/112 hashes preservados; `backup/pre-recon-20261108` → `a446219`. `stash@{0}` y `backup/autostash-20261028-011451` intactos.
- C12-r4 (acta, cierre V00, matrices y manual N1) y NATIVO r2.1 verificados presentes y completos en el checkout antes de T05-N.
- **T05-N en implementación** conforme a NATIVO r2.1 §3, §5–§7, §12 y §15. T18 y T22 **sin objeto** (identificadores conservados). T06–T17 y T19–T21 pendientes según dependencias.
- Este bloque se registra en el commit documental LOCAL autorizado por CLAUDE.md §5.A (solo documentos de plan y CLAUDE.md; sin código).

**Rediseño nativo PostgreSQL (2026-11-08), PROPUESTA r2.1 pendiente de aprobación:** [NATIVO-POSTGRES-20261108.md](NATIVO-POSTGRES-20261108.md). La r2.1 corrige los bloqueantes de Sol:

- cerco de credenciales (rol DB y rotación de tokens) antes de cualquier efecto externo; la capa 0 SQL solo defiende el ledger;
- gateway de medios sin `bot_token` en los clientes nativos, con impacto de costo y latencia medido en T20 y decisión D-N6;
- borrado de cuenta controlado y deshabilitado;
- cuarentena por usuario en el flush;
- C12-r4 local vigente durante la reconciliación.

Respaldo previo: `E:\777\app\BeatGaler-plan-backups\NATIVO-r2_1-pre-20261108-180350`. Antecedente r2: la r2 corrige el orden de inserción y los ids frente a 0026, separa GET/provision, añade la capa 0 en DB, las guardas de cascada y rebind, el aislamiento por chat nuevo (bot_token en cliente Direct), la recuperación sin INDEX, las dependencias T19/T23 y la reconciliación Git detallada (§14). Respaldo previo: `E:\777\app\BeatGaler-plan-backups\NATIVO-r2-pre-20261108-172953`.

- Decisión del propietario (Purp): no hay usuarios reales que migrar; se autoriza descartar los INDEX, beats, metadatos y archivos de prueba, pero **no** ejecutar borrados.
- Bibliotecas nuevas directamente en PostgreSQL. Telegram queda solo para bytes.
- **T05 detenido** hasta aprobar el rediseño. Se redefinen T05, T17 y T23; T18 y T22 quedan sin objeto; T07–T09, T11, T13, T15, T16, T24 y T25 se simplifican.
- T00–T04 siguen en PASS, sin reabrir.
- Antes de T05 hay que resolver R2 (base Git): HEAD local `a446219` no contiene los commits T02–T04, y `3d291d5` existe solo como objeto.
- Solo se cambió documentación; sin código, servicios, datos ni Git de escritura. Respaldo verificado (SHA-256, 5/5): `E:\777\app\BeatGaler-plan-backups\NATIVO-pre-20261108-170039`.

**T04 PASS (LOCAL, 2026-11-08, BAJA):** registrado por encargo explícito del usuario (Purp). CI catalog-checks run 42530209790 sobre commit 3d291d5 (fast-forward desde b6df121, solo LOCAL), PostgreSQL 16 efímero:

- T04/t04-catalog-codec 5/5 y T04/catalog-roundtrip-integration 3/3, sin skips: 22 fixtures elegibles con source-roundtrip exacto en SQL, authoritative-export con solo deltas C4 (V1_TO_V2, SQL_ONLY_TOMBSTONE), VALIDATED sin autoridad (bibliotecas LEGACY/IDLE, época y revisión intactas, library_* sin cambios); lotes de 250 con crash/replay sin duplicados; snapshot cambiado exige generación nueva; REVIEW no escribe.
- Regresión: unit 46/46, faults 9/9, integration 2/2, T03 14/14.
- Decisión aprobada: el conflicto sintético 1600/1601 (t01-manifest-toplevel-ref) es REVIEW por C4 (referencias inconsistentes). Corregido solo su oracle (index-review/review) y su registro en contract-map (t04.fixture_oracle_fix_20261108); contenido del fixture sin cambios (sha256 idéntico). Sin 0027 ni cambio de contrato.
- Para Sol: ningún fixture importable cubre la forma real de los escritores (manifest.ref == parts[0]); registrado como test_gap en los 2 paths de manifest de contract-map. Siguen pendientes de revisión los 4 fixtures review→importable-con-flag y la nota A2 de bpm_sort.

**T01 PASS (LOCAL, 2026-11-08):** se registra por encargo explícito del usuario (Purp), que pidió registrarlo si se cumplían los criterios. T01-C (MEDIA) cerró FX-01, FX-02, COV-01 y COV-02 ([E20](EVIDENCIA.md), [cobertura](consumer-map.md)). Criterios de TAREAS T01 y MATRIZ-T:

- 69/69 JSON paths con destino, regla y fixture.
- 53 fixtures reproducibles; los 41 previos conservan sus oracles.
- 0 consumidores sin clase y 0 globales sin contrato.
- Cada consumidor tiene test con evidencia o `test_gap` con tarea propietaria.
- Rutas inversas verificadas desde `server.js` y `main.tsx`.
- C12-U01/U02/N01/F01/F02/D01 y V01-A tienen fixture.
- Contrato T01-B cerrado.
- NUL sin pérdida silenciosa: `raw_index` bytea, `legacy_json` TEXT con escapes y nunca jsonb, REVIEW si cae en campo proyectado.

**Reglas aprobadas por el usuario (Purp, 2026-11-08):** (1) `catalog_legacy_fields` y los extras legacy se guardan en TEXT JSON con escapes ASCII seguros, nunca en jsonb, y sustituyen el `root_extras jsonb` de T01-A; (2) CS-050 (`uploadedFiles`, `messageRedirects`) solo se coteja con C4:99 y no se importa. G1 no está completo sin T04.

**T02 PASS (LOCAL, 2026-11-08):** se registra con la autorización del usuario (Purp) para finalizar T02. Commits `eebb7ea` y `6a7e4b0`, con push fast-forward solo a `local/landing-gallery-unificada` y sin merge. Resultados ([E21](EVIDENCIA.md)):

- CI [run 42519548345](https://github.com/magosouljah/BeatGaler/actions/runs/42519548345), PostgreSQL 16.15 efímero de GitHub Actions: `unit` 34/34, `faults` 9/9 e `integration` 2/2, sin skips.
- Guard de red del job: solo `postgres:5432`, 0 bloqueos.
- DB nueva con rol propio no privilegiado y marcador; cleanup tras verificar identidad, owner y marcador; DB borrada, doble cleanup rechazado y DB ajena intacta.
- Local: `web` (V01-B) PASS.
- El primer run (42519400428) falló porque el rol de prueba no podía leer su marcador (42501). Se corrigió con `GRANT SELECT` y se repitió.

Como `workflow_dispatch` no existe fuera de `main`, el workflow se dispara con push a LOCAL de su YAML o del arnés, igual que el probe G0. Solo se activó `catalog-checks`.

**T03 PASS (LOCAL, 2026-11-08):** con la autorización del usuario se hizo commit y push a LOCAL, partiendo del HEAD remoto `b23ea3f`, sin force-push, pull, reset ni merge: `fb7ff97` (T03) y `8a192e6` (corrección).

- Migraciones 0001–0025 idénticas al remoto; `0026_catalog_core.sql` es aditiva.
- CI [run 42520961552](https://github.com/magosouljah/BeatGaler/actions/runs/42520961552), PostgreSQL 16.15 efímero: `T03` PASS, con contrato 6/6, schema y migration-runner PASS e integración 6/6 (fresh + idempotente, concurrente, upgrade 0001–0025→0026 con datos legacy idénticos, restricciones de biblioteca/generación/autoridad y de beats/tags/papelera/tombstones/archivos/conjuntos, repositorio con rollback y release medidos). Sin skips; red solo `postgres:5432`.
- `unit` 41/41, `faults` e `integration` PASS.
- Tamaño inicial del catálogo: 745 472 bytes en 54 relaciones (no es benchmark T20).
- El run 42520640249 falló por 3 errores de preparación de la prueba y un bug del helper T02 `instrumentPool`, que contaba de más cuando pg reutilizaba el mismo cliente. Corregidos, con prueba de regresión.
- Solo se activó `catalog-checks`.

**T04 (BAJA, 2026-11-08): implementado en local, NO PASS: STOP-CONTRACT + STOP-APPROVAL.**

- Archivos: `cloud-server/catalog/legacy-codec.js`, `migration.js` (solo transformación) y `staging.js` (STAGING en lotes de 250 con checkpoint `(snapshot_hash, ordinal)`, export y VALIDATED; sin autoridad ni `library_*`). Pruebas `catalog-codec.test.cjs` (5/5 local) y `catalog-roundtrip.integration.cjs` (pendiente de CI); suite `T04` registrada. `unit` local 46/46.
- Oráculo independiente por fixture: 22 INDEX elegibles con roundtrip profundo source exacto (527 beats); authoritative solo con los deltas listados (V1→V2, tombstones SQL-only); 17 REVIEW y 3 rechazos de parser según C4/T01-B; cota de export ≥ bytes reales, también con `sort_order` regenerado; límite exacto probado.
- Interpretación aplicada: `t01-trash-unwrapped`, `t01-size-zero`, `t01-botapi-file-id` y `t01-shared-reference` tienen la etiqueta `expected=review` de T01-A, pero sus oracles y las reglas T01-B (D-07, D-10, C3) las hacen importables con flags (TRASH_UNWRAPPED, SIZE_ZERO, OPAQUE_LOCATOR, SHARED_REFERENCE). Para revisión de Sol.
- A2: `bpm_sort` es NULL en clases no finitas, en lugar del 0 de §3.3; el orden (clase, valor) es equivalente.
- **STOP-CONTRACT:** una referencia a nivel `manifest.telegram_*` distinta de todas sus `parts` (fixture `t01-manifest-toplevel-ref`) no tiene representación en C3. `catalog_part_locations` solo admite PRIMARY/BACKUP por parte, y sin fila SQL la protección de purge de T15 no la vería. Hoy va a REVIEW (fail-closed), lo que contradice el oracle `actual` del fixture. Decisión requerida (ALTA/Sol): (a) migración aditiva con un tipo de ubicación propio para la referencia de manifest, o (b) confirmar REVIEW y corregir el oracle.
- **STOP-APPROVAL:** commit y push de T04 a LOCAL para ejecutar `T04` en el PostgreSQL efímero de CI.

**T01-B ALTA (2026-11-08), sin PASS:** cerrados con C1–C12/r4 los 18 hallazgos de T01-A (D-01…D-10, C-01…C-06, S-01/S-02); ningún STOP-DATA/STOP-CONTRACT de T01-A queda abierto y no se tomó ninguna decisión de producto nueva. C-01 y C-04 no eran STOP: drag-reorder y upload YouTube están apagados en Web por capability. D-05 se rebaja: el colector incompleto es código muerto. Contrato de filas/locks/fases DDL y reglas de codec en [contract-map.json](contract-map.json) (`stops[*].t01b`, `contracts`, `t01b`) y [consumer-map.md](consumer-map.md). **Pendiente para T01-C (MEDIA):** FX-01 fixtures con `schema` incorrecto (`generate-fixtures.cjs:42`), FX-02 fixtures de reglas nuevas, COV-01/COV-02 cobertura. **T01 NO PASS; T02 no iniciada.**


**Cierre T00/G0 LOCAL (2026-11-08):** dictamen independiente GPT-6 (Sol) sobre `G0-REVISION-FINAL-v2.zip`: **G0 cumple técnicamente para LOCAL; T00 PASS (LOCAL).** Evidencias citadas por el dictamen: 48/48 hashes, baseline 68/68, smoke de rutas 6/6, smoke autenticado simulado 5/5, PostgreSQL verificado (run 42416790955) y C12-r4 cerrado. Límite: el smoke simulado no demuestra transporte real ni producción. Autorización del usuario (Purp) para cerrar documentalmente T00/G0 y abrir **T01 (en curso)**. T02 no iniciada; sin migraciones ni servicios reales. Los bloques siguientes quedan como antecedentes.


**Vigencia C12-r4 (2026-11-07):** [cierre C12-r4](C12-V00-CIERRE-20261107.md) integra el [acta I1/I2/I3 aprobada](C12-V00-INTERACCIONES-APROBADAS-20261107.md) de `c6d7b7cf4455623ab2da7bfbdadabb0b4b3e3b81` y las respuestas explícitas del usuario de este encargo. **A1/A2/B-legacy e I1/I2/I3 aprobados; decisiones C12/V00 cerradas para diseño.** Shuffle sin repetición por ronda, aviso de selección solo si existía y rename también en papelera sin alterar su estado. Las menciones pendientes r2/r3 quedan como antecedentes, sustituidas por r4. **T00/G0 no PASS; T01 bloqueada; T02 no iniciada.** No hay autorización de implementar.


**Cierre de integración documental r3:** diff whitespace/enlaces/fences PASS; caracterización r2 intacta byte a byte,5/5 MD remotos exactos. Inventario de7 MD modificados y6 incorporados en [plan B sección11](C12-B-INTEGRACION-Y-PLAN-20261107.md). Sin nuevas pruebas de producto/SQL/performance, sin runtime ni servicios reales. B-experiencia aprobada; C12/T00/G0 continúan NO PASS y T01 bloqueada por decisiones pendientes, no por falta de aprobación del scroll infinito.


Actualizado: 7 de noviembre de 2026.

## Estado histórico — C12-r3 / B-scroll-v1

**B-experiencia APROBADA:** Gallery POSTGRES continua con infinite scroll virtualizado, sin paginador visible. Autoridad: [anexo oficial](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md), remoto `b585540a3a82bc8604d8d6de603514af48b5feb4`. **B-legacy PENDIENTE:** cota10.000, copy y destino de links no resolubles; Ir al inicio sigue como recomendación. **A1/A2 siguen pendientes** según evidencia r2. El [plan V00–V11](C12-B-INTEGRACION-Y-PLAN-20261107.md) identifica además STOP-INTERACTION de selección/cola/facetas antes de conectarlas, sin reabrir la aprobación del infinite scroll.

**C12 NO CERRADO, T00 NO PASS, G0 NO APROBADO, T01 BLOQUEADA, T02 NO INICIADA.** Solo se autorizó documentar/diseñar. Los estados históricos siguientes no prevalecen sobre este bloque.

HEAD local continúa `a4462191aea29ffdae136f04e1fdc2e4024291d1`, rama LOCAL. Se guardó copia versionada de15 documentos con hashes verificados antes de editar: `E:\777\app\BeatGaler-c12-document-backups\20261107-185609-a446219`; también snapshot remoto. Fetch genérico falló por refspec release inexistente; fetch explícito LOCAL pasó. No merge/pull/checkout/commit/push; no se integró workflow ni runner remoto. [Reconciliación, evidencia V01–V14 y alcance](C12-B-INTEGRACION-Y-PLAN-20261107.md).

## Registro histórico — revisión C12-r2

Base local observada: `a4462191aea29ffdae136f04e1fdc2e4024291d1`, `local/landing-gallery-unificada`; no se movió HEAD. [C12-DECISION-RECORD.md](C12-DECISION-RECORD.md) y [caracterización](C12-CARACTERIZACION-20261107.md) contienen decisiones, evidencia y transferencia. Los registros anteriores del trabajo conservados debajo son **históricos** y no sustituyen este estado.

- **T00 NO PASS / STOP-DESIGN; G0 NO APROBADO; T01 BLOQUEADA; T02 NO INICIADA.**
- STOP-TEST del baseline está resuelto por el informe histórico Windows `5b19916`: 68/68 + 25/25 mutaciones. No se repitió aquí.
- STOP-ENV del descriptor G0 está resuelto: run [42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955), job `128536516538`, estado/pasos/logs verificados. PostgreSQL16.15, UTF8, en_US.utf8, pg_trgm1.6 y marcador correctos; no equivale al arnés T02 ni a pruebas SQL de catálogo.
- Decisiones técnicas C12 cerradas según tabla del acta. **Pendientes de producto:** A1 orden ICU fijo; A2 BPM inválidos; B transición global de bgPage, filtros, contador y navegación. Ninguna aceptación inferida.
- Nuevos experimentos: selector/parser puros en Node y orden de nombres en Chrome sintético; no DB, Edge ni aplicación integrada. Resultados y límites en caracterización. No se ejecutó la suite postgres-live ni se usaron servicios reales.

Próximo paso permitido: decidir A1/A2/B con el protocolo de sección9 del acta, consolidar el contrato y revisar formalmente T00/G0. No iniciar tareas de implementación como consecuencia automática de esta documentación.

Paths documentales de esta entrega: nuevos `C12-DECISION-RECORD.md`, `C12-CARACTERIZACION-20261107.md`; actualizados `README.md`, `CONTRATO.md`, `ESTADO.md`, `EVIDENCIA.md`, `TAREAS.md`. Todos bajo este directorio. Sin cambios a producto/tests/workflows, sin commit/push. No rastreados ajenos preservados: `Claude outputs/`, `beatgaler-console.jpg`.

Verificación documental: `git diff --check`, enlaces locales/fences y alcance de archivos PASS. El resultado final de C12 sigue **STOP-DESIGN**, no PASS por haber pasado estos checks. Evidencia de comandos/resultados en EVIDENCIA y anexo de caracterización.

## Registro histórico del plan inicial

**Entregable actual:** plan documental terminado. **Implementación:** no iniciada. **Migraciones reales:** ninguna. **Autorización actual:** análisis y elaboración del plan; no implementación ni servicios reales.

Base inspeccionada: `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`, rama `local/landing-gallery-unificada`. Referencia `main` local `10ae1908d947cc4f6981469f9a722936ec3ee57e`. No fetch ni verificación de producción.

La ejecución de seis pruebas locales en EVIDENCIA/E4 terminó PASS. No es PASS de las tareas futuras ni de sus puertas. Los nuevos comandos, tablas, módulos y APIs descritos todavía no existen.

| Tarea | Estado | Evidencia de implementación |
| --- | --- | --- |
| T00 Base/contrato | **STOP-DESIGN / NO PASS** | C12-r4: decisiones cerradas para diseño; falta dictamen formal T00/G0. Sin implementación. |
| T01 Campos/consumidores | **BLOQUEADA** | Requiere T00/G0 formal y autorización; no iniciada. |
| T02 Arnés aislado | PENDIENTE | — |
| T03 Esquema | PENDIENTE | — |
| T04 Codec/import/export | PENDIENTE | — |
| T05 Autoridad/época | PENDIENTE | — |
| T06 Lectura/API | PENDIENTE | — |
| T07 Mutaciones metadata | PENDIENTE | — |
| T08 Cliente lectura/eventos | PENDIENTE | — |
| T09 Operaciones/reservas | PENDIENTE | — |
| T10 Worker | PENDIENTE | — |
| T11 Telegram real aislado | PENDIENTE | — |
| T12 Transferencias/PROJECT | PENDIENTE | — |
| T13 Cliente mutaciones | PENDIENTE | — |
| T14 Playback/downloads | PENDIENTE | — |
| T15 Purge/retención | PENDIENTE | — |
| T16 Arranque/cercado | PENDIENTE | — |
| T17 CLI migración | PENDIENTE | — |
| T18 Ensayo rollback | PENDIENTE | — |
| T19 Restore/backups | PENDIENTE | — |
| T20 Performance | PENDIENTE | — |
| T21 Candidato/revisión | PENDIENTE | — |
| T22 Sombra real | PENDIENTE | — |
| T23 Piloto | PENDIENTE | — |
| T24 Cohortes/cleanup | PENDIENTE | — |
| T25 Retirada | PENDIENTE | — |

G0, G1, G2, G3, G4: **PENDIENTES**. El plan contiene decisiones propuestas concretas y comprobaciones para cerrarlas. No hay GO productivo.

## Registro de una tarea completada

Copiar por cada ejecución, sin borrar antecedentes:

```text
Tarea / fecha / ejecutor:
Encargo y alcance autorizado:
Rama / worktree / SHA inicial / SHA final (o sin commit):
Estado inicial de archivos ajenos y preservación:
Dependencias PASS y enlaces a evidencia:
Entorno y descriptor (sin credenciales):
Archivos creados/modificados:
Cambios de comportamiento:
Comandos exactos ejecutados + exit codes:
Pruebas totales / PASS / FAIL / SKIP:
Artefactos y hashes:
Resultado: PASS | PASS-AISLADO | STOP-...
Puerta que queda abierta/cerrada:
Próxima tarea habilitada (no iniciarla automáticamente):
```

## Expediente para escalar a alta capacidad

```text
STOP-<código> — Tarea T__ — Paso exacto:
Qué exigía el contrato (C__/M__):
Qué se observó y dónde está la evidencia:
Reproducción mínima / comando / exit code:
Hechos comprobados:
Hipótesis todavía no comprobadas:
Datos/operaciones afectados (IDs redactados fuera del artefacto protegido):
Autoridad / epoch / estado / última operación confirmada:
¿Hay un efecto externo en vuelo o incierto?:
Archivos y servicios modificados:
Medida de contención autorizada ejecutada, si existe:
Qué NO se ejecutó:
Decisión concreta que debe tomar la inteligencia de alta capacidad:
```

No sustituir este expediente por “no pude”, “parece un problema de Telegram” o un intento de reparación no autorizado. Una vez emitido STOP, la IA ejecutora espera una instrucción nueva.


## Estado actualizado al baseline LOCAL (2026-11-07)

<!-- BG-PG-LOCAL-BASELINE-20261107 -->
- Checkout auditado localmente por script: rama `local/landing-gallery-unificada`, commit `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b` (esto verifica solo identidad/parentesco, NO ejecución de tests).
- Referencia visual/funcional de integración: `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`.
- Árbol Cloud igual que base histórica en snapshot GitHub: `bcb488ae3802dfd2bbe8f3fe6245b314a152c189`.
- **G0: PENDIENTE** de examen completo de documentos, DB test aislada (issue #133), baseline CI/Direct, DTO UI/API, equivalencia del INDEX, smoke local y revisión de diffs no confirmados.
- 26 tareas y gates G0–G4: **estados previos conservados**, no se declara ninguna completada mediante esta actualización documental.
- No hay implementación ni migración SQL realizada por este script.

Ver [LOCAL-BASELINE-20261107.md](LOCAL-BASELINE-20261107.md).

## Resultado de auditoría G0 estática — 2026-11-07

- **G0: NO APROBADO** (`STOP-ENV`, `STOP-TEST`, `STOP-DESIGN`). **T00: PENDIENTE. T01: BLOQUEADA** por dependencia. Ninguna tarea se inició.
- Rama `local/landing-gallery-unificada`; fuente remota de auditoría `edabd715664f9564346e95b8553b68b4ac411da9`; código de referencia `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`. Solo cambió documentación.
- Evidencia: siete archivos y código remoto, salida Git del usuario. Los seis PASS E4 proceden de ejecución anterior; **cero tests nuevos ejecutados aquí**.
- Pendientes antes de T01: T00 PASS autorizado, descriptor DB segura, baseline reproducible de Web/Cloud/Direct y clasificación de fallo #151, decisión C12 sobre orden/Unicode/compatibilidad `bgPage` y SLO, pruebas de Landing/Gallery/Playbar.
- [Informe G0 completo](G0-AUDITORIA-20261107.md). No habilita AWS, Telegram, DB real ni despliegue.

## T00 — iniciado, sin PASS (2026-11-07)

- **Autorización:** el usuario indicó «go» para continuar con T00 en LOCAL; no autorizó infraestructura, credenciales, Telegram, PostgreSQL real, migración ni T01.
- **Base:** usuario confirmó `f90b488` en `local/landing-gallery-unificada`, fast-forward sin cambios de aplicación; dos elementos ajenos sin seguimiento permanecen intactos.
- **Evidencia estática nueva:** 25 migraciones 0001–0025; 1211 entradas del árbol GitHub; sin `AGENTS.md` versionados; manifests/lockfiles leídos; seis pruebas E4 históricas y otras suites inspeccionadas **sin reejecutar**.
- **Resultado T00:** `EN CURSO / NO PASS` por `STOP-ENV` (sin descriptor PostgreSQL aislado), `STOP-TEST` (sin resultados Windows/Direct/Playbar actuales), `STOP-DESIGN` (C12 sin aceptación y fixtures Unicode/offset). No se declara ningún test aprobado en esta ejecución. **T01 continúa BLOQUEADA**.
- **Comprobación segura preparada:** [T00-BASELINE-READONLY.ps1](T00-BASELINE-READONLY.ps1); únicamente comandos Git y tests locales permitidos. Tras inspeccionar resultados, completar T00 con evidencia; no promover PASS por omisión.
- **Expediente técnico:** [T00-REVISION-20261107.md](T00-REVISION-20261107.md).

### Actualización CI histórico (T00)

Logs examinados del run `42353075806`: PostgreSQL persistent assignment PASS histórico; TypeScript Direct 3 FAIL/188 PASS por tres asserts de bootstrap antiguo; Cloud guard FAIL por ancla literal de mutación. La clasificación es de **fallo de aserción observado**, no prueba de equivalencia funcional ni PASS actual. El runner T00 incluye las suites afectadas y el guard. `STOP-TEST` permanece abierto.

## T00 — Resultado ejecutado en Windows LOCAL (2026-11-07)

- Usuario ejecutó `T00-BASELINE-READONLY.ps1` después de fast-forward a `da735bed34733b5ed1e5e22a9d2e389d78bbad43`, rama correcta. `git status`: solo `Claude outputs/` y `beatgaler-console.jpg` sin seguimiento. 25 migraciones, Node 22.23.2 y npm 10.9.8 confirmados.
- **PASS:** 6 pruebas E4, 3 de config/runner/Direct simulado, 23 de DOM/Gallery y 24 de 27 de tests de arranque heredado; check AST Cloud exit 0 y TypeScript `--noEmit` exit 0.
- **FAIL:** 3 tests de integración de arranque Direct, todos por exigir `src/main.tsx` anterior; script de mutaciones de guard Cloud exit 1 al faltar ancla literal con 2 argumentos (el runtime tiene `indexPinAuthority` como tercero). El guard AST original PASÓ, de modo que el fallo del test mutante es de preparación de fixture, no evidencia de ruptura del guard real. Con todo, no demuestra que la nueva ruta de Direct sea funcionalmente equivalente.
- **Dictamen:** `T00 = STOP-TEST / NO PASS`; `STOP-ENV` por falta de descriptor PostgreSQL aislado, `STOP-DESIGN` por falta de cierre C12. `G0 = NO APROBADO`; `T01 = BLOQUEADA`. No se iniciaron T01 ni T02 y no se autorizan servicios reales.
- **Expediente detallado:** [T00-LOCAL-RESULTADOS-20261107.md](T00-LOCAL-RESULTADOS-20261107.md). Evidencia obtenida de salida aportada por el usuario, no ejecutada remotamente por GitHub.

## Reparación de pruebas T00 enviada (2026-11-07)

Corrección limitada a cuatro tests existentes, un test DOM nuevo y el runner documental; 25 anclas de mutación verificadas por lectura estática, **sin ejecutar la nueva suite todavía**. PostgreSQL 16 Docker digest de CI es solo referente para laboratorio, no servidor Windows verificado. C12 sigue STOP-DESIGN y entorno STOP-ENV. T00 NO PASS; T01 BLOQUEADA. Ver [T00-TEST-CORRECTIONS-20261107.md](T00-TEST-CORRECTIONS-20261107.md).

### Reparación del guard de alcance del runner — 2026-11-07

El usuario actualizó LOCAL a `b5d23fc`; el runner T00 se detuvo en `STOP-BASE` antes de ejecutar tests porque la revisión original permitía exclusivamente `docs/plans/catalogo-postgresql/`, pero las pruebas T00 autorizadas habían cambiado cinco archivos `tests/`/`scripts/`. **No es fallo de app, Cloud ni PostgreSQL.** Se sustituyó por una allowlist exacta de esos cinco paths; continúa el bloqueo para `src/`, `cloud-server/`, migraciones, `DESIGN/`, UI y cualquier otro archivo inesperado. Nueva ejecución Windows todavía PENDIENTE; T00 sin PASS, T01 bloqueada.

### Nuevo baseline Windows de T00 — 2026-11-07 (HEAD `259b077`)

Ejecución real aportada por el usuario, script completado: E4 6/6 PASS; PostgreSQL fake 3/3 PASS; guard AST PASS; guard 25 mutaciones PASS; DOM 31/32 PASS con **1 FAIL** en la suite nueva `webGalleryDirectAuthBoundary.test.tsx:134`; tres suites legacy de bootstrap 27/27 PASS; TypeScript `--noEmit` PASS. Entorno Windows: Node 22.23.2/npm 10.9.8, **sin docker/podman/psql en PATH**. No se ejecutó ningún servicio externo.

Único fallo observado: la expectativa de UI tras confirmar sesión se evalúa después de solo un `flushLazy()`; el comportamiento de carga diferida de React puede requerir más de un turno. Se preparó una prueba que espera de forma acotada la carga real y confirma que el mock de restauración sí fue invocado antes de resolverlo; no se modificó ningún módulo de aplicación. **No se afirma que la causa sea solo timing hasta repetir el test**. T00/ G0 NO PASS, STOP-TEST por validar; STOP-ENV/STOP-DESIGN continúan. T01 bloqueada.

## T00 — Siete fases del baseline Windows PASS (HEAD 5b19916)

El usuario ejecutó el runner actualizado completo: **68/68 pruebas individuales PASS, 25/25 mutaciones Cloud peligrosas rechazadas, AST Cloud PASS, TypeScript PASS, todos los 7 exit codes 0**. Advertencia no bloqueante de React `act(...)` en fixture de Suspense. `STOP-TEST` del baseline queda **resuelto**, pero esto no certifica smoke real con Telegram/Player ni PostgreSQL conectado. Docker, Podman y psql no disponibles en PATH. **T00 global: NO PASS por STOP-ENV y STOP-DESIGN**; G0 no aprobado y T01 bloqueada. [Informe final del baseline](T00-BASELINE-PASS-20261107.md).


## Antecedentes remotos reconciliados (históricos)

Importados de `b585540a3a82bc8604d8d6de603514af48b5feb4`; no reemplazan C12-r2/r3 ni el estado vigente.

## Entorno G0 e IDE C12 preparados (2026-11-07)

Se agregó el workflow acotado de **laboratorio PostgreSQL 16 efímero** en GitHub Actions, activable en LOCAL únicamente por cambios a su propio YAML. No contiene rutas de producción, checkout, SQL destructivo ni deploy. El primer push del workflow **puede disparar un run**; comprobar resultado antes de afirmar `STOP-ENV` resuelto. Se agregó [G0-LAB-POSTGRES-ACTIONS.md](G0-LAB-POSTGRES-ACTIONS.md). La IDE de alta capacidad puede cerrar las decisiones C12 desde [G0-C12-IDE-MASTER-PROMPT-20261107.md](G0-C12-IDE-MASTER-PROMPT-20261107.md), sin implementar. T00 global/G0 no PASS hasta evidencias y dictamen explícitos; T01 bloqueada.

### G0 PostgreSQL Actions — primer run falló en lectura de locale

Run `42416620409`, en LOCAL, PostgreSQL 16.15 inició y `pg_trgm` se instaló. Fallo exclusivo de SQL diagnóstico: `lc_collate` no es parámetro `current_setting` en PostgreSQL 16. La fuente correcta es `pg_database.datcollate/datctype`. Corrección hecha en workflow para nueva corrida, con marcador run verificado. **STOP-ENV sigue pendiente de run PASS.** Ver [G0-LAB-POSTGRES-ACTIONS.md](G0-LAB-POSTGRES-ACTIONS.md).

## G0 — descriptor PostgreSQL verificado en GitHub Actions (2026-11-07)

Run [42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955), rama LOCAL SHA `758669a`, **PASS**: PostgreSQL **16.15**, UTF8, `datcollate/datctype=en_US.utf8`, `pg_trgm=1.6`, DB `beatgaler_catalog_g0_probe`, rol `catalog_g0_probe`, marker del run verificado; contenedores destruidos al finalizar. **STOP-ENV para descriptor G0 RESUELTO**, no equivale al arnés real T02. Las 68/68 pruebas T00 y 25/25 mutaciones también permanecen PASS. **T00 global/G0 NO APROBADOS por C12 STOP-DESIGN y restantes criterios formales**. T01 sigue bloqueada. Ver [G0-POSTGRES-VERIFIED-20261107.md](G0-POSTGRES-VERIFIED-20261107.md).

## C12 — acta técnica inicial para IDE (2026-11-07)

Se creó [C12-DECISION-RECORD.md](C12-DECISION-RECORD.md) sobre la fuente LOCAL `894f486`, documentando semántica ANY/ALL, sort `localeCompare`, `bgPage` offset y pruebas de contrato. **STOP-DESIGN-A** Unicode y **STOP-DESIGN-B** URLs antiguas requieren resolución/aceptación por IDE y pruebas. El baseline T00 y descriptor G0 PostgreSQL PASS no equivalen a aprobación global. **T00/G0 no PASS; T01 bloqueada**.

## Transferencia normativa vigente C12-r4

[cierre C12-r4](C12-V00-CIERRE-20261107.md) integra las aprobaciones explícitas y sustituye pendientes/recomendaciones incompatibles r2/r3. A1 ICU fijo, A2 binary64/clase y B-legacy <=10.000 quedan aprobados. I1 selección global con aviso solo si había selección; I2 audio continuo, nuevo query y cola prioritaria, Shuffle sin repetición por ronda; I3 rename ACTIVE/TRASH sin modificar estado. Se descarta fijar permanentemente la búsqueda musical al pulsar Play.

Aplicar las dependencias, algoritmos, alternativas y STOP de sección 7 del cierre a T01/T03/T06/T07/T13/T14/T20 y V00–V11. Membresías SQL persistidas, selección CAS, facetas, journal y swaps Shuffle no son memoria global del cliente. T01/T06 deben producir inventario y contratos tipados completos en sus tareas futuras. T00 revisa formalmente base/descriptor/baseline/contrato, sin volver a solicitar las aprobaciones resueltas. T01 permanece bloqueada; ningún paso de implementación iniciado.

## Verificación documental r4 ejecutada

`git diff --check`: PASS. Comprobación local de enlaces, fences y caracteres de sustitución: **22 Markdown, 0 errores**. Caracterización r2 idéntica byte a byte al snapshot previo; nuevo anexo I1/I2/I3 idéntico al blob remoto c6d7b7c. Backup previo verificado: 21 archivos con manifiesto SHA256. HEAD permanece a4462191aea29ffdae136f04e1fdc2e4024291d1. Diff de producto entre HEAD/remoto vacío. No cambios de runtime, tests, workflows ni runner; no commit/push. `Claude outputs/` y `beatgaler-console.jpg` preservados.

Entrega r4: nuevo `C12-V00-CIERRE-20261107.md` y anexo remoto `C12-V00-INTERACCIONES-APROBADAS-20261107.md`; actualizados acta C12, plan B, README, CONTRATO, TAREAS, ESTADO y EVIDENCIA. Los demás cambios Git preceden este encargo. Se corrigió un fallo del script documental por lectura Python cp1252 usando UTF-8 explícito; se validaron después todos los MD. No hubo pérdida/restauración de contenido ni ejecución de producto.

Decisiones C12/V00 cerradas para diseño conforme a respuestas del usuario, incluyendo corrección de Shuffle sin repeticiones. No tests de aplicación, SQL, browser, uniformidad RNG, benchmarks ni despliegues ejecutados. G0/T00 requieren dictamen formal independiente; T01 bloqueada, T02 no iniciada.

## Plan N1 por niveles completado — documental (2026-11-07)

**Alcance:** solo documentación en este directorio. Continúa el trabajo N1 de la IDE anterior; no ejecuta T00/G0, T01 ni T02 y no emite PASS de tareas, subtareas ni gates.

- **Conservado sin cambios:** [matriz T](MATRIZ-T-NIVELES-20261107.md) (26 fichas T00–T25, byte a byte igual) y el contenido previo del [manual N1](EJECUCION-POR-NIVELES-20261107.md).
- **Nuevo:** [matriz V](MATRIZ-V-NIVELES-20261107.md): 12 fichas V00–V11 con 20 campos cada una, T padre, paquetes por nivel, intervenciones ALTA concretas, PASS/STOP/handoff. Relación con las tareas originales: cada V subdivide una o varias T (V00→T00/T01, V01→T01/T02, V02→T06, V03–V05→T08, V06→T14, V07→T13/T14, V08→T16, V09→T16 con consumo T21, V10→T20, V11→T21/T22/T23); no es una T nueva.
- **Ampliado:** N1 §3 con cinco reconciliaciones RV1–RV5 detectadas al construir la matriz V (copy legacy r4, I2/Shuffle frente a plan B §6, raíz única de módulos cliente, flags de selección en DTO, citas históricas «pendiente»). README con enlaces y regla de uso; TAREAS con referencia normativa N1 sin renumerar.
- **Reparto final:** T — BAJA 8, MEDIA 16, ALTA 2; V — Chat 1, BAJA 3, MEDIA 8. ALTA interviene solo en T01-B, T06-A/V02-A, T11 y T21-B, más STOP-SHUFFLE-PERF o contrato incompatible.
- **Verificación documental real:** validador propio de cobertura/consistencia/enlaces/fences/UTF-8/espacios/alcance: PASS sobre 26 archivos (25 MD, 157 enlaces locales); 4/4 defectos inyectados detectados. Detalle en EVIDENCIA.
- **Limitaciones:** el shell del equipo no arrancó en esta sesión; el estado Git se obtuvo leyendo `.git` (HEAD, refs, índice) y calculando hashes de blobs, y `git diff --check` se sustituyó por una comprobación equivalente de líneas añadidas. Debe repetirse `git status --short` y `git diff --check` en Windows antes del próximo encargo. No se ejecutaron tests de producto, SQL, navegador ni benchmarks.
- **Estados sin cambio:** C12-r4 cerrado para decisiones de producto/diseño (no implementado). **T00 global NO PASS; G0 NO APROBADO; T01 BLOQUEADA; T02 NO INICIADA.**
- **Siguiente paso permitido:** encargo independiente de revisión formal T00/G0 (N1 §10): IDE BAJA prepara T00-A y el paquete V00-A0; GPT-6 Sol dictamina V00-A/G0. No se inicia sin autorización separada.
