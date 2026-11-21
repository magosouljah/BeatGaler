# T00 — Reparación de tests y propuesta de laboratorio

**Fecha:** 2026-11-07. **Rama:** `local/landing-gallery-unificada`. **Estado:** cambios de pruebas realizados, resultados del nuevo runner **PENDIENTES**. Esta acción no valida G0 ni inicia T01.

## 1. Fallos LOCAL del baseline original

La ejecución en `da735be` detectó:
- 3 pruebas fallidas que exigían arrancar Direct desde `src/main.tsx`, cuando LOCAL monta `WebGalleryWorkspace` detrás de `AuthExperienceGate`.
- 1 archivo de mutaciones Cloud con anclas literales obsoletas. El guard AST de producción pasó.

Se modificaron **solo tests** y un script de baseline documental. Ni `src/`, `cloud-server/`, `DESIGN/`, `src-tauri/` ni sus respectivos comportamientos fueron alterados.

## 2. Reparaciones de tests

- `tests/integration/appStartupBootstrapExtraction.test.ts`: verifica inicialización de `main.tsx`, distribución en WebExperience/WebGalleryEntry/Workspace, gate de sesión confirmada, composición y uso de Direct desde el workspace.
- `tests/integration/issue97PlaybackOptimization.test.ts`: comprueba que el preconnect no es global; conserva coordinator, CSRF y dispatch route-free tras Gallery autentificada.
- `tests/integration/issue97RuntimeWebFollowup.test.ts`: sustituye la expectativa pre-React por la ruta autenticada sin perder el resto de asserts de MSE, transporte, playback y protección de sesión.
- `tests/component-dom/webGalleryDirectAuthBoundary.test.tsx` **nuevo**: renderiza `WebExperience`, `WebGalleryEntry`, `AuthExperienceGate` y `WebGalleryWorkspace` reales con fakes de red/Player. Comprueba: Landing pública no monta Direct; sesión pendiente/signout no montan Direct; usuario A confirmado monta Direct; logout desmonta Gallery; usuario B vuelve a montar workspace con nueva invocación. No toca red real. Importante: simula la llamada de preconnect, **no** demuestra transferencia real o latencia; tests del módulo `webRememberedDirectPreconnect.behavior.test.ts` cubren la compuerta cookie/CSRF/Offline/Tauri.
- `scripts/regression-direct-manager-only.test.mjs`: conserva los **25 escenarios de mutación**, reparando 4 anclas obsoletas:
  1. `installPersistentDirectSessionStart` tiene `indexPinAuthority` adicional.
  2. `readyResult` tiene el segundo parámetro opcional `membership = null`.
  3. `pinMessages` es **false** para Direct; la mutación maliciosa debe elevarlo a `true`.
  4. `deleteMessages` es **false** para Direct; la mutación maliciosa debe elevarlo a `true`.
  
El guard real `regression-direct-manager-only.mjs` ya exige `pinMessages/deleteMessages=false` y reserva pin/delete a MASTER. Se comprobaron **las 25 anclas estáticamente** contra el código exacto del nuevo commit: 25/25 presentes. **No se han ejecutado las 25 mutaciones** en un proceso Node con TypeScript en el checkout Windows; su PASS sigue pendiente.

## 3. PostgreSQL de ensayo sin tocar bases

Existe un referente reproducible **histórico** en `.github/workflows/direct-persistent-vault-assignment.yml`: imagen Docker
`postgres:16@sha256:c1b3783309b6499c795eed7c20135a1a4d25cae1b575c3d52c6f536129a1b109`.
Pasó el gate SQL de asignaciones en Actions del 7 de noviembre. No es un descriptor de una instalación existente en Windows ni una prueba de colación/extensiones.

**Propuesta para T02 (NO ejecutar en T00):** crear un contenedor local dedicado con esa imagen/digest, loopback exclusivo, puerto que no sea 5432 (preferible 55432 solo tras comprobar ausencia de conflictos), identificador de cluster y bases efímeras con marcador de propiedad; sin conexiones por `DATABASE_URL` heredada. El arnés T02 debe verificar server_version, collation, `pg_trgm`, roles y marcador **antes de escribir/borrar**. No reutilizar CI de integración destructiva contra un URL externo.

El runner T00 ahora informa versiones de CLI `docker`, `podman`, `psql` si están disponibles, **sin consultar sus daemons ni servidores**. Un cliente instalado no prueba que exista servidor seguro. **STOP-ENV sigue abierto** hasta confirmar disponibilidad/aislamiento y registrar descriptor.

## 4. Decisiones técnicas C12, pendientes de aceptación para el catálogo

- **Fijar por defecto:** mantener semántica visible de inclusión ANY y exclusión de tags en Web; buscar y filtrar globalmente antes de paginar; preservar `manual`, desempates y metadata de BeatCard; no tocar UI ni Player. API 100/240, lotes 50, límites de payload C5 y código de errores por contrato.
- **Nombre/Unicode:** `lower(name) COLLATE "C"` del C12 original **NO es paridad** con `localeCompare` actual. No adoptarlo silenciosamente ni fingir equivalencia; crear fixtures Unicode y comparación real en T01 y tomar una decisión explícita antes de T06. Si se acepta el cambio deliberado, registrarlo como nueva semántica visible.
- **`bgPage` profundo:** mantener el parámetro legado y dar respuesta acotada, sin cargar INDEX completo ni recorrer páginas por bucle. La política exacta de traducción a cursor o incompatibilidad visible necesita cierre; no inventar un límite de páginas sin verificar usuarios afectados.
- **SLO y recursos:** p95 ≤250 ms/p99 ≤1 s, PATCH p95 ≤250 ms, muestras 100k/1M y presupuestos en C11 son objetivos **de laboratorio**, aún no probados ni presupuestos de AWS. Registrar el hardware y límites de test antes de usarlos para PASS.
- **Retención/backup/rollback:** conservar propuestas C12 como guardas, no afirmar que existen backups o restauración de medios. La operación productiva requiere puertas posteriores y autorización independiente.

Se recomienda mantener `STOP-DESIGN` hasta documentar explícitamente el criterio de orden Unicode y bookmarks; ningún cambio de algoritmo ha sido implementado.

## 5. Estado de calidad

Nueva suite DOM y tests de guard reparados publicados. **No hay resultados de CI/Windows sobre este commit**. No se ha desplegado nada, no se han realizado merges ni iniciado PostgreSQL/Telegram/AWS.

**T00 = EN CURSO / NO PASS; G0 = NO APROBADO; T01 = BLOQUEADA.**

**Siguiente verificación:** actualizar rama LOCAL con `git pull --ff-only origin local/landing-gallery-unificada`, ejecutar `T00-BASELINE-READONLY.ps1`; si el guard mutante o las nuevas suites fallan, conservar salida y revisar. No ejecutar `postgres-live.integration.cjs`.

## 6. Corrección del guard de alcance del ejecutor

La ejecución Windows de `b5d23fc` paró antes de pruebas con `STOP-BASE: cambio de código ajeno al plan: scripts/regression-direct-manager-only.test.mjs`. Causa: el script comparaba `31861e6..HEAD` y admitía únicamente documentación, un supuesto anterior a las correcciones T00. Se permite ahora solo la documentación del plan y **los cinco paths exactos** de tests aprobados; código de aplicación, Cloud y migraciones siguen prohibidos. Se conserva el rechazo de modificaciones tracked sin commit; los dos archivos sin seguimiento siguen intactos. No se interpreta esta parada como FAIL de pruebas ni se declara PASS sin una nueva ejecución.

## 7. Falla en test DOM nuevo (segunda ejecución Windows, 259b077)

Resultado: el guard Cloud ya ejecutó sus 25 mutaciones y todas fueron rechazadas; los 27 tests legacy Direct pasaron. La única prueba que falló fue `webGalleryDirectAuthBoundary.test.tsx:134` al evaluar la marca del DOM después de un único `flushLazy()` tras resolver la sesión. Esta salida no permite distinguir de forma definitiva latencia de `React.lazy` de un problema de autenticación/montaje; por ello la nueva versión **no elimina aserciones**, sino que primero exige ver invocación del mock `restoreBeatGalerSession`, después espera con `vi.waitFor` (máximo 3 s) a que el árbol real de Gallery monte y Direct se invoque una sola vez; tras logout se mantiene el rechazo inmediato y al cambiar a B vuelve a exigir una única invocación adicional. Si el problema persiste, fallará con un timeout informativo sin falsear PASS. Pendiente nueva ejecución en PC LOCAL. Docker/Podman/psql no aparecen en PATH, por lo que STOP-ENV sigue.

## 8. Resultado posterior, ejecución en 5b19916

Todas las fases del runner terminaron en exit 0. Las tres pruebas del `webGalleryDirectAuthBoundary.test.tsx` pasaron; 32/32 DOM y 27/27 legacy Direct. El mock de preconnect se verifica detrás del Auth gate. Hay warning de Suspense/`act` no bloqueante. Ver [T00-BASELINE-PASS-20261107.md](T00-BASELINE-PASS-20261107.md).
