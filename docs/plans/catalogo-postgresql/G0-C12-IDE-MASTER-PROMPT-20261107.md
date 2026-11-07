# C12 — Encargo maestro para una IDE inteligente

**Proyecto:** BeatGaler, `magosouljah/BeatGaler`, rama exclusiva `local/landing-gallery-unificada`. **Objetivo:** resolver y cerrar el diseño de C12 para una futura migración del INDEX de Telegram a un catálogo PostgreSQL, con PostgreSQL como autoridad de metadatos por beat/archivo y Telegram como almacenamiento de medios.

## 0. Límites no negociables

- Solo estudiar y documentar C12 en LOCAL. No cambiar `main`, producción `beatgaler.com`, AWS, Telegram, MASTER, Bots, Vaults, bases de datos reales, DESIGN ni el funcionamiento de Landing/Gallery/Playbar.
- **NO implementar la migración, esquema, endpoints ni modificaciones del producto**. T00 global/G0 aún requieren aceptación del entorno/descriptores y de este contrato. T01 solo empieza con gate formal y autorización.
- No introducir contratos productivos distintos por silencio. Una elección técnica puede cerrarse autónomamente cuando conserva UX e invariantes y tiene evidencia; si requiere cambio visible (por ejemplo orden Unicode distinto o links `bgPage` que ya no abren la página esperada), documenta una opción preferente y un bloqueo explícito, sin declarar aceptación ficticia.
- Usar las definiciones reales y los cambios autorizados del árbol local; no confundir `main` antiguo con la base de LOCAL. Revisar `AGENTS.md` aplicables antes de editar.
- No ejecutar `cloud-server/tests/postgres-live.integration.cjs` ni consultas con `DATABASE_URL`/AWS/Telegram. Las pruebas T00 whitelist previas pasaron 68/68 con 25 mutaciones Cloud rechazadas.

## 1. Leer antes de decidir

`docs/plans/catalogo-postgresql/README.md`, `ESTADO.md`, `CONTRATO.md` (C1, C4, C5, C11, C12 y contrato frontend LOCAL), `TAREAS.md` (T00, T01, T02), `MIGRACION.md`, `G0-AUDITORIA-20261107.md`, `LOCAL-BASELINE-20261107.md` y `T00-BASELINE-PASS-20261107.md`.

Código fuente real:
- `src/features/library/librarySelectors.ts`, `useLibraryViewState.ts`, `webLibrary.ts`, `webLibraryNavigation.ts`, `WebLibraryPagination.tsx`, `libraryPresentationCache.ts`, y TODOS sus callers; identificar cómo la Gallery entrega `includeMode="any"`.
- `src/app/WebExperience.tsx`, `WebGalleryEntry.tsx`, `WebGalleryWorkspace.tsx`, `src/features/auth/AuthExperienceGate.tsx`: auth, rutas y carga diferida.
- `src/features/playback/` y `src/features/cloud/` relacionados con routing, preconnect y reproducir; no proponer reemplazar Playbar por versión vieja.
- Contrato del INDEX y operaciones en `cloud-server/`, tests originales y validadores de metadata.

Citar ruta y líneas/código verificable para toda afirmación importante. No basarse en un resumen del plan si contradice el código.

## 2. Decisiones C12 que debes **resolver**, con evidencia

### A. Orden global y Unicode

- Determinar el orden actual de `manual`, `name`, `bpm`, `rating`; empates, valores vacíos/invalidos, `manualOrderIndex`, `localeCompare`, estabilidad de sort y sort recibido.
- No declarar `lower(name) COLLATE "C"` equivalente a `localeCompare`: comparar Unicode con casos de acentos, ñ, mayúsculas, normalización NFC/NFD, emoji, puntuación, dígitos, mayúsculas/minúsculas, empates exactos y duplicados. Analizar alternativas (PostgreSQL ICU collation/version fijada, sort key persistida, explicit locale/normalizador, o cambio deliberado), costo de reindexación y comportamiento al pasar de navegador a servidor.
- Elegir algoritmo SQL y su llave de desempate determinista para la paginación keyset. Si cambia el orden visible actual, marcar **DECISIÓN DE PRODUCTO NO APROBADA** y el impacto exacto.

### B. Filtros y búsqueda

- Preservar inclusión de tags **ANY** donde Gallery realmente la usa (el helper admite `all` por defecto), exclusión `NONE` prioritaria, coincidencias exactas de tags para filtro y substring case-insensitive para q en nombre/tags/Key/BPM. Identificar diferencias entre casefold JS/SQL, Unicode, BPM numérico/textual y null.
- Filtrar/buscar **antes** de paginar; NO convertir selección de la página actual en búsqueda global incompleta; no leer INDEX entero para cada consulta en el catálogo nuevo.
- Determinar índices y plan para `q` 1–2 caracteres, términos frecuentes, `pg_trgm` y `EXPLAIN`, sin prometer eficiencia no medida.

### C. Enlaces `bgPage` y cursores

- Inventariar offset actual (`bgPage`), tamaño de página, parámetros, bookmarks, botones prev/next, API de eventos, experiencia cuando cambian filtros/sort y rutas `/`, `/gallery`, `/login`, `/signup`.
- Elegir migración acotada a cursor firmado por tenant/epoch/revision/filtros/sort. Definir el destino de links históricos a offsets profundos y UX explícita si no pueden resolverse sin `OFFSET` caro o recorrer ilimitadamente. No inventar compatibilidad total si no se puede sostener.
- Definir estado/códigos 400, 409 `CURSOR_STALE`, 410 `RESYNC_REQUIRED` y navegación al cambiar revisión/account.

### D. Integridad y políticas

- Validar C5 para tamaño máximo 100/240, lotes 50, 64 KiB metadata, 256 KiB batch, 2 MiB respuesta, y cuotas ya vigentes sin alteración comercial.
- Confirmar `version` por beat, `epoch`, idempotencia, bloqueo cross-tenant y fail-closed de fallback.
- Retención: papelera 14 días como dato, sin autopurge, protección física mínima propuesta 35 días. Rollback propuesto 30 días y export máximo 15 MiB; no prometer que la copia real de medios existe. RPO objetivo DB ≤5 min / RTO ≤60 min son metas por demostrar, no realidad AWS.
- Acordar perfil de laboratorio C11 para 100k y 1M beats, hardware/digest/version/collation, latencias p95/p99 y presupuesto de memoria; identificar cifras aún no medidas. Desktop queda fuera de bibliotecas migradas.
- Delimitar MVP piloto, rollback manual seguro y criterios de STOP de futuras etapas.

## 3. Entorno G0

El baseline Windows del 7-11-2026 sobre `5b19916` pasó 68/68 + 25/25 mutaciones; `STOP-TEST` del runner se resolvió. Windows no tenía Docker/Podman/psql en PATH. Se está preparando un workflow exclusivo de LOCAL `.github/workflows/catalog-g0-postgres-probe.yml` para obtener versión y locale reales de PostgreSQL 16 y `pg_trgm` en un contenedor efímero GitHub Actions. **No afirmes que ya pasó** sin verificar el run de GitHub y su resumen. T02 debe construir arnés aislado separado; el G0 probe no reemplaza esas pruebas de PostgreSQL real.

## 4. Entregables obligatorios (documentación)

Crear `docs/plans/catalogo-postgresql/C12-DECISION-RECORD.md` con:
1. Tabla por subdecisión: `aceptada` / `bloqueada`, alternativa recomendada, justificación, prueba/paridad exigida, efectos visibles, revertibilidad, módulos implicados.
2. Contrato preciso de filtros/orden y DTO/cursor/URL, ejemplos de entradas/salidas y edge cases Unicode, BPM, tags y offsets.
3. Requisitos SQL a verificar más tarde (solo pseudocódigo o ejemplos, sin migración ejecutable que toque DB).
4. Matriz de pruebas sintéticas para T01/T06/T14/T17 y criterios G0/G1 sin mezclar resultados históricos con nuevos.
5. Protocolo de decisión para todo comportamiento que pueda cambiar: diferencia esperada, impacto y aprobación explícita necesaria. Sin asumir que el usuario dio consentimiento a cambiar la UX.
6. Lista de dudas realmente bloqueantes vs temas que puedes resolver autónomamente con código y criterio de ingeniería, sin preguntas innecesarias.
7. Dictamen final: `C12 cerrado` únicamente si cada decisión necesaria está resuelta con evidencia y sin cambios visibles no aprobados; de lo contrario `STOP-DESIGN` con pasos concretos.

Actualizar `ESTADO.md`, `EVIDENCIA.md` y `TAREAS.md` de manera consistente, solo documentación. Incluye SHA real y lista de paths modificados; deja intactos archivos no rastreados del usuario.

## 5. Política de ejecución

La IDE puede investigar, comparar, decidir y **cerrar las decisiones técnicas de C12** usando razonamiento de alta capacidad, sin solicitar permiso para cada deducción técnica. No puede certificar una prueba inexistente, aceptar una degradación visible de producto por sí sola o declarar G0 PASS mientras falte validación del entorno. Si ocurre un conflicto de contrato, preferir preservación de datos/UX; documentar STOP y alternativa segura. No iniciar T01.

## Evidencia actualizada para IDE — laboratorio verificado

No se trata solo de preparación: GitHub Actions [42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955), HEAD `758669a4ca0df1f0b3f5cce6abef703e3ab10047`, **PASS** en un contenedor efímero PostgreSQL `16.15`, `UTF8`, `datcollate/datctype=en_US.utf8`, `pg_trgm=1.6`. El marcador de run y rol/DB se verificaron. El run no contiene catálogo real ni prueba de performance, pero cierra `STOP-ENV` para el descriptor G0. Consultar [G0-POSTGRES-VERIFIED-20261107.md](G0-POSTGRES-VERIFIED-20261107.md). La IDE no debe inferir que `en_US.utf8` garantiza equivalencia con `localeCompare` de todos los navegadores.
