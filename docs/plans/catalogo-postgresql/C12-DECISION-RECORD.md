# C12 — Decisiones de diseño del catálogo PostgreSQL

**Vigencia C12-r4 (2026-11-07):** [cierre C12-r4](C12-V00-CIERRE-20261107.md) integra el [acta I1/I2/I3 aprobada](C12-V00-INTERACCIONES-APROBADAS-20261107.md) de `c6d7b7cf4455623ab2da7bfbdadabb0b4b3e3b81` y las respuestas explícitas del usuario de este encargo. **A1/A2/B-legacy e I1/I2/I3 aprobados; decisiones C12/V00 cerradas para diseño.** Shuffle sin repetición por ronda, aviso de selección solo si existía y rename también en papelera sin alterar su estado. Las menciones pendientes r2/r3 quedan como antecedentes, sustituidas por r4. **T00/G0 no PASS; T01 bloqueada; T02 no iniciada.** No hay autorización de implementar.


Fecha: 7 de noviembre de 2026. Revisión documental **C12-r4** (integra cierre V00; conserva evidencia r2/r3). Base LOCAL: `a4462191aea29ffdae136f04e1fdc2e4024291d1`, rama `local/landing-gallery-unificada`.

**Dictamen: decisiones C12/V00 CERRADAS para diseño**, según [cierre C12-r4](C12-V00-CIERRE-20261107.md). A1/A2/B-legacy aprobados explícitamente; I1/I2/I3 integrados con Shuffle sin repetición. T00/G0 sin PASS; T01/T02 no iniciadas. Pruebas y revisión formal de gates pendientes.

La idea inicial y el acta remota anterior son antecedentes. En C12 prevalece esta revisión sobre la propuesta anterior `lower(name) COLLATE "C"` y sobre afirmaciones de compatibilidad total con bgPage. El [anexo oficial B](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md) reemplaza la experiencia paginada propuesta por r2 para POSTGRES; prev/next siguen solo como protocolo interno. El [plan granular V00–V11](C12-B-INTEGRACION-Y-PLAN-20261107.md) fija virtualización, vida de estado, presupuestos, pruebas y paradas. Las reglas C1–C11, pérdida cero, autoridad única y puertas de MIGRACION permanecen. Una propuesta bloqueada no se convierte en contrato activo porque tenga pseudocódigo.

## 1. Evidencia y alcance

Integración r3: HEAD local sigue `a4462191aea29ffdae136f04e1fdc2e4024291d1`; remoto obtenido `b585540a3a82bc8604d8d6de603514af48b5feb4`. Copia local versionada con15/15 hashes verificados y snapshot remoto antes de reconciliar; ubicación/procedimiento en sección1 del plan B. No se sustituyó r2 por el acta remota abreviada ni se incorporó runtime/workflow/runner remoto.

[Evidencia reproducible y experimentos](C12-CARACTERIZACION-20261107.md) identifica E01–E14, SHA, callers y resultados nuevos. Se leyeron README, ESTADO, CONTRATO, TAREAS T00/T01/T02, MIGRACION, auditoría G0, anexo LOCAL y baseline T00. Se consultó la rama remota hasta `9e0a7b237d8d063b6a50c4e71192d4b6716e0cd3` sin mover este checkout.

- Baseline histórico Windows `5b19916`: 68/68 pruebas y 25/25 mutaciones rechazadas; no se repitió aquí.
- Probe [42416790955](https://github.com/magosouljah/BeatGaler/actions/runs/42416790955) verificado: PostgreSQL 16.15, UTF8, en_US.utf8, pg_trgm 1.6; **STOP-ENV del descriptor resuelto**. No demuestra ICU de catálogo, pruebas SQL, benchmarks ni producción.
- Nuevo: caracterización pura del selector/parser en Node 22.23.2 y del orden de nombres en Chrome 152; no DB, INDEX real, AWS, Telegram ni aplicación integrada.
- No hay evidencia de paridad PostgreSQL/Chrome/Edge. La colación del probe no es la colación propuesta de nombres. Las comprobaciones SQL se harán mediante el arnés de T02, después de su gate; no se introduce una dependencia circular en G0.

## 2. Tabla de decisiones

**Aceptada** significa elección técnica de diseño dentro de este encargo, con pruebas de implementación aún pendientes. **Bloqueada** significa DECISIÓN DE PRODUCTO NO APROBADA. Revertir una decisión técnica requiere versión de contrato/cursores nueva y revisión; no habilita fallback de autoridad.

| ID / estado | Elección y alternativa descartada | Motivo / prueba exigida | Efecto visible / reversión | Módulos y tareas |
| --- | --- | --- | --- | --- |
| A1 **APROBADA r4** | Preferir nombre global con ICU `und`, opciones fijadas, empate manual; descartar lower+C como equivalencia | E01, experimento Unicode; comparar fixture SQL/navegadores en T06, inventario T01 | Cambia orden según locale previo; revertible recalculando índices/perfil, no datos raw | queries, índices, selector; T01/T06/T08 |
| A2 **APROBADA r4** | BPM total: −Infinity, finitos ascendentes, +Infinity, NaN al final; no imitar comparador inconsistente | E01/E03, `[200,oops,100]`; fixtures de Number y roundtrip | Legacy inválido puede moverse; alternativa segura: biblioteca completa no elegible hasta decisión | codec/proyecciones/queries; T01/T04/T06 |
| A3 aceptada | Manual por ordinal del array fuente; rating proyectado descendente; empate manual, ID binario solo último recurso | E01/E03/E09; IDs y ranks únicos, empates, nueva alta/restore | Conserva relación de orden de esos comparadores, salvo alcance global B1; no ordenar import por sort_order legacy | codec/queries; T01/T04/T06 |
| F1 aceptada | ANY en Gallery, ALL solo cuando se pida explícito; excluir cualquiera; tags exactos | E01/E02/E06; fixture ANY/ALL/overlap/case | Preserva predicado; raw reversible | queries/client; T01/T06/T08 |
| F2 aceptada | Proyección JS versionada para búsqueda, sin lower SQL, unaccent ni casefold amplio | E01/E03/E11; Unicode contextual, NFD, `%`, BPM textual | Preserva búsqueda actual incluido BPM sin lowercase; ampliarla a texto BPM insensitive exige nueva decisión | codec/commands/queries; T01/T04/T06/T07 |
| B1 experiencia **APROBADA** | Gallery continua virtualizada por filas, sin pager POSTGRES; filtros/orden SQL global antes de bloques internos | Anexo oficial B; pruebas V00–V11 futuras, no PASS actual | Desmontaje y cache acotada, reset de query aprobado; UI LOCAL conservada | queries/store/grid/playback; T06/T08/T14/T16 |
| B2 legacy **APROBADA r4** | bgPage intenta resolver ancla del nuevo orden global una vez; cota10.000 aprobada r4 | E04/E05, sección5 y plan B | No pager; ancla global, aviso y acción Ir al inicio aprobados en r4 | navigation/routes/anchor; T06/T08/T17 |
| C1 aceptada | Cursor HMAC contextual + keyset; no offsets crecientes ni snapshot entre peticiones | C1/C5; manipulación, tenant, revision, vuelta atrás | Invalidación explícita con filtros conservados; Tratamiento de scroll en plan B; copy legacy pendiente | API/client; T05/T06/T08 |
| C2 aceptada | DTO acotado y raw separado; Gallery pide 240, API default 100, max 240; batch 50 | E03/E12 y C4/C5; bytes UTF8, extremo que no cabe | No truncar ni cambiar cuotas; datos incompatibles bloquean elegibilidad | DTO/commands; T01/T06/T07 |
| C3 aceptada | Version beat, era/epoch, idempotencia, tenant server-side, fail closed | C1/C5; carreras y replay, 0 red con cliente SQL retenido | Conflictos visibles ya exigidos; reversión solo MIGRACION R2 | authority/commands/worker; T05/T07/T10 |
| D1 aceptada para diseño aislado | 14 días como dato; cleanup apagado, sin autopurge; protección física mínima 35 días extensible | E13, C9; T15/T19 demuestran ventanas/journal | Ninguna eliminación real autorizada; política real se ratifica en G4 | worker/purge; T15/T19/T24 |
| D2 aceptada para piloto propuesto | Rollback manual 30 días como mínimo operativo, cota 15 MiB, no cierre automático; RPO 5 min/RTO 60 min objetivos | C4 y MIGRACION R2/R3; export con escrituras y restore | Si excedería cota, rechazo antes de commit; admitir ese piloto requiere autorización G4 | codec/CLI/backups; T04/T17–T19/T23 |
| D3 aceptada | Perfil de laboratorio sección 7; conservar SLO C11, no presumir rendimiento | Hardware/digest/métricas y EXPLAIN futuros | Sin promesa comercial; no relajar objetivos para PASS | harness/benchmark; T02/T20 |
| D4 aceptada | Web + Cloud + worker; transporte PROJECT actual; Desktop cercado, UI LOCAL y Playbar conservados | E07–E10, C10 y prueba de sesiones antiguas | No reemplazo por main viejo; corte real depende de G2/G4 | auth/routes/playback/guards; T11/T14/T16 |

## 3. Orden, Unicode y proyecciones

### 3.1 Comportamiento actual, no supuesto

`librarySelectors.ts:12–33` conserva orden recibido para manual. Nombre usa `a.name.localeCompare(b.name)`. BPM usa `Number(a.bpm || 0) - Number(b.bpm || 0)`. Rating usa diferencia descendente y después el índice que tenía cada ID antes del filtro. El sort estable conserva empates cuando el comparador es consistente; NaN no define un orden numérico total. IDs duplicados pisan la entrada del Map: se rechazan en import, no se inventa un desempate que los legitime. [Semántica ECMAScript de sort](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.sort).

La proyección de Gallery (`webLibrary.ts:165–193`) convierte name no string/vacío a Untitled y recorta extremos; BPM/key no string a `""`; rating a `max(0,min(255,trunc(Number(value)||0)))`; tags conserva strings con duplicados y case. Un BPM JSON numérico 120 **se muestra vacío**; no convertirlo automáticamente a `"120"`. Guardar raw y proyección por separado. `sort_order` no manda en el lector Web actual. T01 debe detectar conflictos de otros consumidores sin sobrescribir raw.

Manual rank inicial = ordinal fuente con separación fija entre ranks, único por `(tenant,generation,state)` para registros visibles. Import preserva orden ACTIVE y wrappers TRASH por separado. Alta prepend/restore append según C6; cambios legítimos de orden afectan el registro movido, no reenumeran biblioteca en cada edición. La asignación sin espacio obliga STOP de ese comando y mantenimiento revisado, no global rewrite oculto. Persistir drag Web no forma parte de C12: E14 muestra que hoy es local/Tauri; T01 lo clasifica antes de ampliar API.

### 3.2 A1 — alternativa preferente y sus límites

Elegir un único perfil `name-icu-und-v1`: proveedor ICU, locale `und`, strength terciaria, numeric=false, caseFirst=false, puntuación no ignorada; `deterministic=false` para que empates canónicos puedan resolverse por manual_rank. T02/T06 deben verificar opciones efectivas, disponibilidad y versión del proveedor, y guardar `collversion` y versión real. Si el entorno no puede materializar ese perfil exacto, STOP-DESIGN-A; no sustituirlo por en_US.utf8 o C.

El flag nondeterministic no vuelve aleatoria la consulta: la tupla manual/ID la hace total. Evita el desempate binario automático de nombres equivalentes; en PostgreSQL 16 esa colación no debe usarse para LIKE. Usar columnas/proyecciones separadas para búsqueda. [Colaciones PostgreSQL 16](https://www.postgresql.org/docs/16/collation.html#COLLATION-NONDETERMINISTIC).

No hay locale explícito en el navegador actual. La comparación Intl puede variar entre configuraciones/implementaciones; un perfil fijo no garantiza equivalencia universal. [ECMA-402](https://tc39.es/ecma402/#sup-string.prototype.localecompare). En el experimento, sueco coloca ä después de z; es-MX lo coloca junto a a. Turco cambia I/ı/i/İ. Acentos, NFC/NFD, emoji, puntuación y dígitos separan además el candidato binario del actual. ICU und SQL **todavía no se ejecutó**: se recomienda por contrato lingüístico explícito, no por paridad certificada.

Alternativas evaluadas:

| Alternativa | Costo o impedimento | Decisión |
| --- | --- | --- |
| lower(name) COLLATE C | Cambia case, acentos, NFC/NFD y símbolos; barato pero no lingüístico | Retirar como opción preferente, nunca llamarla paridad |
| Locale por navegador/petición | Índices por locale, versiones diferentes y cambios al usar otro dispositivo | No adoptar en MVP |
| Normalizar NFC + locale fijo | Puede empatar canónicos, pero no resuelve variabilidad de locales; normalizar raw perdería forma original | Solo proyecciones si se reconsidera, no raw |
| Sort keys ICU persistidas | Requiere generador fiable/versionado y materialización/reconstrucción; no asumir función core de PG16 para exportarlas | Más piezas que índice ICU; no adoptar |
| Ordenar solo la página en navegador | No produce orden global ni keyset coherente | Prohibido |
| Mantener toda biblioteca legacy | Preserva comportamiento existente hasta aprobar transición | Salida segura actual |

Actualizar ICU exige detener admisión del perfil incompatible, reconstruir índices dependientes, comparar fixture/deltas y publicar nuevo sortProfile/epoch invalidando cursores. Medir tiempo, disco temporal, locks y rollback de índices; no actualizar únicamente la etiqueta de versión. [ALTER COLLATION PostgreSQL 16](https://www.postgresql.org/docs/16/sql-altercollation.html). T20 mide el costo; no hay estimación verificada aquí.

### 3.3 A2 — orden total de BPM

Propuesta pendiente: calcular **sobre bpmDisplay** con semántica Number de JS fijada, nunca cast SQL de texto arbitrario. Proyectar `bpmClass` 0=−Infinity, 1=finito, 2=+Infinity, 3=NaN; `bpmValue` float8 para finitos y 0 para otras clases. Vacío/espacios→0; `0x80`→128; `1e2`→100; conservar textos en DTO/raw. ±0 empatan. Parseo y redondeo deben ser los de JS binary64, sin sustituir por numeric decimal que distinga valores que JS empataba.

Orden: clase asc, valor asc, manual_rank asc, ID binario asc. Para entradas válidas nuevas preserva resultado numérico. Para `[200,oops,100]` actual observado = mismo orden; propuesta = `[100,200,oops]`. **Cambio visible pendiente A2**. Alternativa sin cambio: excluir del piloto una biblioteca con cualquier NaN en proyección; no ocultar esos beats ni convertirlos a 0. Infinity se conserva en raw y clase, no se transmite como JSON number inválido.

### 3.4 Filtros y búsqueda, contrato exacto

1. Resolver tenant autenticado, generación activa y estado ACTIVE/TRASH. Aplicar predicados sobre **todos** sus beats antes de paginar.
2. Gallery siempre envía `includeMode=any`; API admite all explícito y usa any por defecto para `/catalog/v1`. Incluidos vacíos = true; ANY = EXISTS de alguna coincidencia; ALL = no falta ninguna. Excluidos = NOT EXISTS de cualquiera; vence aunque el mismo tag esté incluido.
3. Igualdad de tags por texto exacto, colación C; no lower/trim/NFC en filtro. Duplicados de input se deduplican como conjunto, sin cambiar raw. Tag `Trap` no equivale a `trap` ni a ` Trap `. El selector de facetas visual normaliza de otra manera (E14); no usarlo como predicado SQL.
4. q lógico = JS `search.trim().toLowerCase()`. Match OR en `nameDisplay.toLowerCase()`, cada tag string `.toLowerCase()`, `keyDisplay.toLowerCase()`, y **bpmDisplay sin lowercase**, igual a E01. q vacío no filtra. No quitar acentos, tokenizar, regex, ni extender búsqueda a filenames. La frase del encargo «case-insensitive BPM» describe bien valores numéricos válidos; para legacy textual hay esta excepción real. Hacer `NaN` encontrable con q nan sería otra modificación, no preservación.
5. Materializar proyecciones JS al importar o editar la entidad. Fijar versión `search-js-v1`, runtime/Unicode del generador y fixtures; Node observado 22.23.2/Unicode17.0 es referencia, no afirmar que coincide con todo navegador histórico. No convertir cada carácter por separado: `ΟΣ→ος` es contextual. Si una versión futura cambia resultados, reconstrucción en sombra y decisión de versión, no mezcla silenciosa.
6. Guardar tags consultables como relaciones sin concatenar campos: `foo` en name y `bar` en key no debe coincidir con `oob`. Preservar duplicados/orden originales en raw; relación de lookup puede ser única por beat/tag exacto.
7. SQL recibe q canónico como parámetro. LIKE literal con `%`, `_` y `\` escapados; comparación con proyección COLLATE C. Ninguna interpolación SQL ni ILIKE dependiente del locale. q `%` solo encuentra un signo literal. Nunca truncar query o tags para pasar el límite.
8. NUL o surrogate aislado que PostgreSQL UTF8 no represente: preservar bytes origen y REVIEW de la biblioteca; no reemplazar por U+FFFD ni perder campos. T01 valida todas las strings consultables.

Índices propuestos: B-tree por tenant/generación/estado y cada tupla de orden; tags exactos `(tenant,generation,tag COLLATE C,beat_id)`; GIN pg_trgm en proyecciones name/key/BPM y tag lower, con evaluación exacta final. No es obligatorio que el planner use GIN si otro plan medido gana. q 1–2 caracteres, símbolos y términos frecuentes siguen válidos; un patrón sin trigramas extraíbles puede recorrer el índice completo. [pg_trgm PostgreSQL 16](https://www.postgresql.org/docs/16/pgtrgm.html#PGTRGM-INDEX).

T06 obtiene EXPLAIN con ANALYZE/BUFFERS en datos sintéticos del arnés, por estado, tenant, sort y selectividad; T20 mide C11. Usar timeout SQL inicial 1.000 ms y timeout total API 2.000 ms en laboratorio, sin retry automático ilimitado. Timeout devuelve error visible `503 CATALOG_QUERY_TIMEOUT`, no 200 vacío ni búsqueda parcial. Estos topes no equivalen a cumplir p95. LIMIT acota salida, **no filas examinadas**; si los perfiles no cumplen, STOP-PERF y revisión de alta capacidad. No limitar búsqueda a prefijo, tres caracteres o página actual para aprobar.

## 4. DTO, cursores y pseudocódigo SQL

Todo lo siguiente es especificación futura; no hay endpoint, migración ni SQL ejecutados. A1/A2/B-legacy permanecen bloqueadas; B-experiencia está aprobada, sin permiso de implementación. Las referencias a páginas de esta sección describen bloques internos de API, no pantallas ni paginador POSTGRES.

### 4.1 Petición y respuesta

`GET /catalog/v1/beats?state=ACTIVE&sort=rating&includeMode=any&limit=240&q=trap&includeTag=Trap&includeTag=lofi&excludeTag=demo`

- state ACTIVE por defecto; sort rating por defecto; q vacío, conjuntos vacíos y any por defecto. limit entero 1…240, default100; Gallery pide240. Valores de enum/limit inválidos → 400 INPUT_INVALID; no clamp silencioso. `includeTag`/`excludeTag` repetidos forman conjuntos; parámetros escalares repetidos → 400. No aceptar propietario/generación elegidos por cliente.
- Para q/tags históricos no imponer los límites de escritura 40/30: consultas deben poder referirse a strings preservadas. Límite global propuesto de query decodificada 64 KiB UTF8, con escape/URL-length probado en cliente/proxy T06. Si los datos históricos elegibles necesitan más, STOP-DATA; no recortar.
- `includeTotal=true` en primera consulta de Gallery: contar matches exactos en snapshot SQL de esa página; sin filtro usar contadores. Guardar total/ordinal en cursor firmado para siguientes páginas de la misma revisión, sin COUNT en cada paso. Un cliente que no solicita total puede recibir null; **Gallery sí lo exige**, no reemplazar el texto actual por total aproximado. Al cambiar revisión o filtros se recalcula. Costo de COUNT filtrado se incluye en C11; no amortizarlo fuera del benchmark para ocultarlo.
- Orden SQL final, sin re-sort/filtro de estos items en Gallery. Mientras autoridad sea LEGACY siguen las rutas existentes; POSTGRES nunca interpreta fallo como permiso para usarlas.

Ejemplo de forma, con datos sintéticos (version/epoch/revision/ranks como strings decimales para no perder bigint):

```json
{
  "items": [{
    "id":"beat-241", "version":"7", "state":"ACTIVE",
    "name":"Árbol", "bpm":"120", "key":"Cm", "tags":["Trap"],
    "rating":5, "color":"#666666", "color2":"#999999",
    "artwork":{"fileId":"art-1","version":"2"},
    "playback":{"fileId":"audio-1","version":"3"},
    "hasWav":true, "hasStems":false, "hasProject":false
  }],
  "authorityEra":"00000000-0000-4000-8000-000000000001",
  "epoch":"3", "revision":"42", "sortProfile":"catalog-order-v1",
  "totalLibrary":241, "totalMatched":1, "startOrdinal":0,
  "nextCursor":null, "previousCursor":null, "resumeCursor":"<token-inclusivo>"
}
```

Es un ejemplo de valores/campos nucleares, **no el mapa exhaustivo de T01**. Color/crop/flags y resto de Beat se mapean con C4/C5; una propiedad no enumerada aquí no está autorizada a desaparecer. IDs de files son opacos de catálogo, no Telegram locators ni credenciales. Detalle y lista de partes paginada conservan extras/proyectos/multipartes; nunca descargar manifests completos para dibujar página. Diferenciar raw de DTO y referencias actuales de versiones retenidas.

La serialización completa de metadata de página no supera 2 MiB UTF8 (sin contar compresión). Si no cabe, error explícito `413 CATALOG_PAGE_TOO_LARGE` y biblioteca no habilitada para piloto hasta resolver DTO; no truncar tags/nombres ni devolver un éxito incompleto. Preflight T01/T06 prueba un beat extremo y páginas de240; defaults100 no justifican una Gallery rota a240. Body PATCH64 KiB, batch256 KiB, máximo50 beats; rechazo413 antes de mutación y 400 para lote >50. Son límites nuevos del contrato, no límites ya implementados E12.

### 4.2 Cursor

Formato futuro `base64url(payloadCanónico).base64url(HMAC-SHA256(payloadCanónico))`, con versión y keyId del firmante. Firma verificada en tiempo constante antes de confiar en campos; límite de token16 KiB, fallo de formato/firma→400 CURSOR_INVALID. HMAC autentica, **no cifra**: no incluir rutas de medios, secretos ni raw; no registrar tokens/URLs completos. Un nombre de orden puede aparecer en payload: tratar URL/historial como datos privados, no enlace público de compartir biblioteca.

Payload obligatorio: `v,kid,tenantId,vaultId,generationId,era,epoch,revision,searchProfile,sortProfile,filterHash,sort,limit,direction,boundary,startOrdinal,totalMatched`. La boundary es la tupla exacta emitida por SQL, no valores calculados por el browser. rank/bigint como strings; binary64 finito serializado roundtrip; clases BPM no finitas separadas. direction = forward/backward/first. Sin expiración temporal añadida en este MVP; revisión/época/perfil/generación y claves retiradas invalidan. Retirar key requiere tratamiento de cursor obsoleto documentado, no confundir firma falsa con keyId antiguo conocido.

filterHash = SHA256 de JSON canónico con state, q canónico, includeMode y conjuntos ordenados por bytes UTF8, conservando texto exacto. No normalizar tags para hash. Limit/sort vinculados por payload; filtros recibidos deben coincidir. tenant del token jamás sustituye auth. Token ajeno o filtro/sort/limit incongruente →400 CURSOR_INVALID genérico sin datos de otra cuenta. Token auténtico propio con revisión/era/epoch/generación/perfil viejo o clave retirada conocida →409 CURSOR_STALE. Lecturas normales obtienen contexto actual; mutaciones con época vieja →409 EPOCH_MISMATCH. 410 RESYNC_REQUIRED es del feed fuera de retención, no biblioteca vacía.

### 4.3 Tuplas y consulta

Tuplas finales (todos los campos NOT NULL en proyección; ID textual COLLATE C):

| Sort | Orden lógico |
| --- | --- |
| manual | manual_rank ASC, beat_id ASC |
| rating | rating_display DESC, manual_rank ASC, beat_id ASC |
| name, pendiente A1 | name_display COLLATE name-icu-und-v1 ASC, manual_rank ASC, beat_id ASC |
| bpm, pendiente A2 | bpm_class ASC, bpm_value ASC, manual_rank ASC, beat_id ASC |

Si rank único se mantiene, ID nunca cambia un empate visible; su presencia asegura forma de clave completa y detección de errores. ID/rank duplicados → STOP-DATA, no reparación. Para rating, condición after: rating menor, o igual y rank mayor, o iguales y ID mayor. No usar `>` sobre la tupla con rating DESC sin invertir la comparación. Para name todas las comparaciones de frontera/igualdad/ORDER BY usan **la misma colación**, también al retroceder.

Pseudocódigo, deliberadamente no ejecutable:

```text
BEGIN lectura corta, REPEATABLE READ, READ ONLY
  leer contexto por auth.user; comprobar autoridad y estado
  validar cursor y revisión contra ese snapshot
  base = catalog_beats WHERE user=auth.user AND generation=active_generation AND state=request.state
  base = base WHERE searchPredicate AND includedPredicate AND NOT excludedPredicate
  total = counter si sin filtros; COUNT(base) si includeTotal; o total firmado vigente
  page = base WHERE lexicographicAfter(boundary, sort) ORDER BY sort LIMIT limit+1
  si direction=backward: usar Before, ORDER BY inverso, limitar y revertir las <=limit filas
  si previous.startOrdinal=0: token first (primera página completa)
  serializar DTO acotado, calcular fronteras y firma fuera de la transacción
COMMIT antes de cualquier red externa
```

La revisión, total y filas deben pertenecer al mismo snapshot. Si hay mutación inmediatamente después, la respuesta sigue siendo coherente con su revisión; el siguiente cursor quedará stale. No abrir transacción entre páginas. Seleccionar únicamente columnas DTO y keys, nada de legacy_json; límite+1 solo para hasMore. Filtro tenant/generación precede lógicamente toda consulta, incluidos subqueries tags y conteos. Pruebas concurrentes deben comprobar que no se mezclan snapshot/revisión.

Anterior: desde ordinal ≥240 recuperar las240 filas previas y devolverlas en orden normal; desde ordinal entre1 y239 usar token first para conservar retorno a ventana inicial completa (puede solaparse, como hoy). Inicial ordinal0 →previousCursor null. Siguiente avanza por cantidad devuelta. En página final con menos240, anterior usa la frontera inicial, no cantidad de la página corta. No derivar posiciones a partir de número de ID.

## 5. B — transición de bgPage a navegación global

### 5.1 Experiencia aprobada y diferencia legacy pendiente

El [anexo B](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md), remoto `b585540`, aprueba una sola Gallery POSTGRES con scroll continuo, filas virtuales, DOM/caché acotados, rehidratación al volver y búsqueda/orden globales. No mostrar Previous/Next, números de página ni recargar el documento para avanzar. Mantener contenedor, apariencia LOCAL, auth y Playbar independiente de tarjetas. Las páginas100/240 de C5 son bloques internos.

Hoy bgPage es offset del manifest tras tombstones **antes** de buscar/ordenar. Ejemplo reducido a2: array `[A(rating1),B(1),C(5),D(5)]`, bgPage2 hoy muestra C,D; orden global rating posiciona A,B en ese offset. Una firma no elimina la diferencia. En manual sin filtros y sin cambios sí puede conservarse membresía. Resolver un enlace ahora carga un bloque y sitúa **ancla en el único scroll**, sin reponer pager.

La experiencia continua está aprobada; **B-legacy permanece pendiente**: límite10.000, copy del aviso, destino cuando no se resuelve y efecto de membresía. Se recomienda aviso explícito y acción elegible Ir al inicio si no puede resolverse acotadamente; no saltar silenciosamente ni afirmar compatibilidad total. Si se exige misma ventana legacy para todo link, STOP-DESIGN-B-LEGACY para alta capacidad. «Perfecto/ok» del anexo no acepta detalles que el propio anexo dejó abiertos.

### 5.2 Resolver acotado propuesto

Endpoint futuro autenticado `GET /catalog/v1/navigation/legacy?offset=240&sort=rating&limit=240`; solo ACTIVE, sin filtros, tamaño240. Una sola resolución por llegada a URL legacy; salida de bloque+resumeCursor+ancla para el scroll, no endpoint de paginación normal. Cota/copy/destinos de esta propuesta siguen pendientes B-legacy. Límite de conversión en rango **10.000**; timeout SQL1000 ms/total2000 ms. Capar claves descartadas/retornadas mediante OFFSET máximo10.000 y LIMIT241; no significa que el planner jamás examine más filas. T06/T20 exigen índice de orden, sin sort global ni lectura de DTO/raw para las filas descartadas, y publican filas/buffers reales. Si no cumple, no aumentar cota silenciosamente.

1. Auth antes de resolver contexto. Si biblioteca LEGACY, conservar navegación actual. Si POSTGRES, usar exclusivamente SQL. No aceptar vault/tenant de query.
2. Para **bgPage histórico** preservar parser actual Number + isInteger>=0 (incluidos 0xF0 y 1e9), primer parámetro duplicado; inválido/negativo/fracción→0. Rechazar valor numérico no seguro con `400 LEGACY_OFFSET_INVALID` y acción explícita primera página; documentar diferencia para entero redondeado, no intentar recuperar precisión perdida. API del resolver recibe decimal seguro canónico, sin parser permisivo propio.
3. URL con cursor y bgPage simultáneos →400 INPUT_INVALID. URL legacy con nuevos filtros catalog q/tags →400 INPUT_INVALID; ofrecer aplicar esos filtros desde primera página, sin adivinar precedencia. bgPage antiguo puro no traía filtros persistidos.
4. Leer contador N y revisión en snapshot. N=0 →página0 vacía, sin prev/next. Es vacío SQL certificado, no fallback.
5. offset≥N y N>0 →conservar comportamiento de rebasing a última página **del nuevo orden**. lastStart=floor((N−1)/240)*240; obtener N−lastStart (1…240) últimas filas con índice inverso y revertir, sin OFFSET profundo. Devolver resolvedOffset y `resolution=last`; aviso de ajuste. Esta vía también resuelve 1e9 fuera de rango sin recorrerlo.
6. 0≤offset<N y offset≤10.000 →obtener las claves de ese bloque con salto acotado; materializar como máximo240 DTO; firmar prev/next/resumeCursor con esa revisión. offset=1/239/241 no se redondea a múltiplo240. Se puede usar un único OFFSET acotado en esta compatibilidad, nunca en siguientes páginas.
7. 10.000<offset<N →`409 LEGACY_OFFSET_UNRESOLVABLE`, ningún recorrido por páginas ni falso vacío. Mostrar «No podemos abrir esa posición del enlace anterior» y acción **Ir al inicio** que el usuario elige; conservar URL hasta esa acción. Timeout →503 CATALOG_QUERY_TIMEOUT y botón reintentar/inicio, no salto silencioso. El límite es política nueva visible pendiente B.
8. Éxito devuelve bloque + contexto + resumeCursor para reabrir su inicio y ordinal del anchor. Reemplazar bgPage mediante history.replaceState por URL con bgAnchor, sin recargar audio ni mostrar pager. Si revisión cambia después, regla stale normal. No volver a resolver bgPage en cada next/prev.

El cursor de reapertura usa frontera inclusiva del primer elemento o modo first, diferenciada de next exclusivo; campo `direction`/`boundary.inclusive` debe ser firmado. T06 prueba ausencia de off-by-one. Para página vacía solo modo first. No fabricar una tupla anterior con ID sintético.

### 5.3 URL, scroll y estado del cliente — sustituye la navegación visual r2

Nombres nuevos: `bgAnchor` (resumeCursor opaco), `bgSort`, `bgQ`, `bgInclude`/`bgExclude` repetibles y `bgMode`. Los cursores next/previous de API son internos. El diseño detallado de queryGeneration, track por filas, cache seis bloques, scroll anchor, resize, foco, detalle y errores está en [plan B, secciones3–7](C12-B-INTEGRACION-Y-PLAN-20261107.md). Los budgets son objetivos por medir, no resultados existentes.

```text
/                                        -> Landing, sin montar Gallery/Direct
/?bgPage=240#player                       -> auth y /gallery con intención legacy
/gallery?bgSort=rating&bgQ=trap&bgMode=any -> inicio de resultados globales, scroll continuo
/gallery?bgSort=rating&bgAnchor=<token>    -> reabrir bloque/ancla vigente, no página visual
/login?bgPage=240 /signup?bgPage=240       -> auth existente y destino Gallery
```

Root con bgAnchor redirige a Gallery igual que bgPage; path/hash/parámetros ajenos se conservan. Token vinculado a tenant/era/epoch/revision/generación/filtros/sort; account switch cancela y descarta datos/token privados previos. Sort explícito manda sobre preferencia cache; default rating. Historia acotada en memoria, no token/lista de bloques de toda la sesión. Sin location.assign por cargar bloques.

Cambio q/tags/sort inicia query nueva, aborta pendientes, vuelve al inicio y conserva predicados.409 stale/410 feed no mezclan revisiones ni disparan fallback; restablecer contexto y primer bloque con aviso conservando draft/audio cuando sean válidos, máximo una recuperación automática por generación. ReturnAnchor se respeta al cerrar detalle si query/revision siguen vigentes. No prometer posición exacta tras mutaciones; si el reset frecuente impide recorrer, STOP-NAV con evidencia.

`beatgaler:web-library-navigation` y pager permanecen solo en LEGACY. POSTGRES usa estado propio de query/anchor/viewport/cursors/loading. No convertir un token en previousOffset ni mantener ambos pagers. Sin contexto resuelto no montar camino legacy por defecto.

Selección individual/edición/media viven fuera de BeatCards; evicción no elimina IDs ni libera audio. Select All, cola automática/shuffle y facetas/rename tienen alcance heredado de página: el plan B registra STOP-INTERACTION concretos para cerrarlos antes de activar esas interacciones, sin exigir nuevamente aprobación del infinite scroll. Reorder manual Web permanece false según capabilities reales.

## 6. Integridad, política y piloto

Se aceptan para el diseño aislado C1/C4/C5/C9/C10 con estas comprobaciones, sin alterar Access ni planes comerciales:

- `version` aumenta una vez por mutación efectiva del beat; expectedVersion obligatorio. Dos PATCH incompatibles: uno confirma, otro409 VERSION_CONFLICT con borrador conservado; no reintentar usando versión nueva a escondidas. epoch/era protegen autoridad y version protege entidad; una no sustituye la otra.
- Idempotencia durable por usuario+key y hash de comando/target/payload/version; repetir key/cuerpo devuelve resultado persistido, key distinta o cuerpo distinto no se confunden. Cambio de época impide replay mutante viejo; propietario puede leer resultado histórico. No promete idempotencia de Telegram después de respuesta perdida: G2 exige reconciliación real del SDK/sesiones.
- Tenant se obtiene de auth y todos los joins/FKs/locators se limitan a él. 404 para entidades ajenas,400 genérico para cursor ajeno; nunca confirmar existencia. Reservas, ACTIVE/TRASH/PURGING ocupan cuota según contrato, solo PURGED la libera; no modificar resolver Access para que pase benchmark.
- Default API100, máximo240, Gallery240; archivos paginados max100, feed240; batch50. 64 KiB/256 KiB/2 MiB son bytes UTF8 reales. Boundary exacta, +1 byte, caracteres multibyte y parser upstream se prueban. No usar límite global256kb como prueba de PATCH64 KiB.
- 14 días se conservan como purge_after/dato; no borrar al vencer. Cleanup=false durante MVP. Retención física mínima propuesta35 días desde retiro/intención, además de referencias vigentes, rollback y ventana efectiva de backups. Si PITR exige más, extender;35 no basta por definición para cualquier backup. Journal de purges y restore_hold antes de reactivar limpieza.
- Ventana reversible propuesta30 días desde corte y hasta cierre explícito G4; export actual≤15 MiB (15.728.640 bytes), debajo del máximo legacy16 MiB. Contabilizar bytes incrementalmente y probar `estimate >= actual`; impedir operación que excedería cota antes de confirmar, con409 ROLLBACK_CAPACITY_EXCEEDED. No truncar ni cortar revisión vigente para exportar.
- Catálogo y medios tienen cobertura distinta. `stored` no significa `backup_verified`; no se ha probado una segunda copia de bytes. Objetivos DB RPO≤5min/RTO≤60min pendientes T19/G4. No afirmar Multi-AZ, PITR, S3 ni configuración productiva existente por esta inspección.

**MVP de ensayo:** Web LOCAL auténtica, Cloud modular y worker, PostgreSQL desechable del arnés, transporte falso. Lecturas/metadata/trash/restore sin INDEX, MASTER ni sesión Direct lista. Transferencias normales por Direct; PROJECT conserva temporal Cloud→MASTER con coordinación durable. Playback conserva fuente/range/seek, intents y controles; obtiene referencias acotadas SQL. Startup máximo14 referencias elegibles, sin reconstruir routing global; account/era/epoch/beat/fileVersion en cache. Preconnect sigue montando dentro de Workspace autenticado; no reponerlo en main ni exigirlo para listar.

**Piloto real futuro:** una biblioteca explícita, snapshot/ledger/pin coherentes, mapa G1 y roundtrip completos, sin OPAQUE destructivo ni operación incierta, export bajo cota, clientes cercados y decisiones A/B aprobadas, G0–G4 y T21 PASS, autorización específica T23. Desktop suspendido/incompatible no accede a bibliotecas migradas; época HTTP no revoca una credencial Telegram ya emitida. T11 debe demostrar cercado de medios o detener el piloto. Nada de migración al arrancar ni pasar de LEGACY por error de lectura.

**Reversión manual:** freeze POSTGRES→drenar→exportar estado actualizado→verificar tamaño/lector/medios→publicar y verificar fuera de SQL→cambiar autoridad/época con punteros/proyección conciliados. Si cualquier fase falla, permanecer con autoridad conocida y writes congeladas; no restaurar INDEX viejo ni apagar flag para volver a legacy. Ensayo T18 incluye altas, ediciones, reemplazos y trash posteriores al corte; T19 cubre restaurar una DB anterior a un purge. MIGRACION R2/R3 conserva el procedimiento detallado.

## 7. Perfil de laboratorio acordado para medir, no resultado

Elección técnica: perfil `C11-LAB-v1`. Host aislado Linux x86_64 **8 vCPU,16 GiB RAM, SSD con al menos100 GiB libres**, con PostgreSQL limitado a4 vCPU/8 GiB, aplicación a2 vCPU/2 GiB, generador a2 vCPU/2 GiB; resto reservado al host. Sin co-tenants de carga. PostgreSQL con shared_buffers2 GiB, work_mem16 MiB y pool aplicación máximo20; guardar configuración efectiva completa relevante. No afirmar que el runner del probe cumple este perfil. Si no hay esos recursos, STOP-ENV para T20; no comprar ni desplegar desde este documento.

Fijar por manifiesto: SHA candidato, lockfiles, Node y Unicode/ICU de proyecciones, imagen/digest PG16.15 del probe o reemplazo aprobado, arquitectura, libc, ICU proveedor y collversion/actual version, extensión pg_trgm1.6, driver, CPU/modelo/cuotas, RAM, almacenamiento/filesystem/capacidad e IOPS observados, región/red de ensayo, índices/estadísticas y flags. Digest por sí solo no determina disco, CPU o latencia. T02 registra descriptor seguro/marker, T06 fija colación real, T20 rechaza descriptor incompleto.

Datasets C11 con semilla777: 1000×100,1000×1000 y1×100.000 beats,4 tags/3files promedio,10% trash; extremos y multipart en fixtures aparte. Un millón es total del perfil, no cuota comercial.20 clientes metadata y2 transferencias falsas con latencia controlada. Warmup2min + muestra10min por perfil, corrida fría separada, reportar cada una sin descartar outliers. El índice/proyección se construye antes de medir requests; registrar su costo por separado, incluido REINDEX y actualización de colación.

Criterios inalterados: metadata API p95≤250ms/p99≤1s; PATCH p95≤250ms; incremento memoria primera página1M frente100k≤20 MiB; respuesta≤2 MiB; cero conexión SQL retenida esperando red externa y cero llamadas Telegram para metadata/trash/restore. Reportar latencia cliente completa aparte. Medir pool wait/SQL/serialización, rows returned y examined, buffers, WAL, locks y RSS pico; sumar memoria de proceso comparable, no solo heap después de GC.

Escenarios obligatorios: primera página, keyset profundo, resolver legacy hasta10.000, último fuera de rango, filtros raros/frecuentes, q1/2 caracteres y puntuación sin trigramas, búsquedas sin matches, exact COUNT filtrado,20 escritores/lectores sobre misma biblioteca, invalidez frecuente de cursor y transferencia lenta. SLO se exige en perfiles requeridos; errores/timeouts no se cuentan como respuestas rápidas exitosas. Registrar tasa de error y reintentos; fallo→STOP-PERF con EXPLAIN y muestras. No disminuir dataset, alterar reglas ni aumentar hardware/SLO en silencio.

## 8. Matriz de pruebas futuras y gates

Nombres `C12-*` identifican casos a construir, **no tests existentes ni comandos ejecutables**. Evidencia mínima por caso: fixture/hash, esperado, observado, runtime/locale o DB/perfil, comando creado por tarea, exit, duración y skips. La caracterización de este encargo no da PASS a ninguna tarea.

| ID / tarea responsable | Entrada o fallo | Resultado exigido |
| --- | --- | --- |
| C12-U01 / T01 | Fixture de20 nombres del anexo + `Z,10,2,-,_,🌙,ß,ss`, nombre ausente/null/vacío, duplicados de nombre e ID | Registrar arrays Node/Chrome/Edge con locale efectivo; duplicates de nombre permanecen, IDs duplicados REVIEW; raw sin normalizar |
| C12-U02 / T01→T06 | NFC/NFD en ambos órdenes manuales; todos los pares de fixture, cuatro sorts y páginas limit1/2/240 | Matriz actual y candidata; SQL total sin saltos/duplicados, empates manuales; deltas A explícitos aprobados. No exigir falsa paridad universal |
| C12-N01 / T01→T06 | BPM `null,120,"120","", " ", "0x80","1e2","NaN","oops",±Infinity textual,−0`, extremos binary64 | Raw roundtrip, DTO compatible E03, clasificación A2 exacta; sin NaN en JSON. Infinity/rating clamp y nulos cubiertos |
| C12-F01 / T01→T06 | ANY/ALL, intersección include/exclude, sets vacíos, case/espacios/duplicados | Mismos predicados que selector real; ANY Web probado desde composition, no solo helper defaultALL |
| C12-F02 / T01→T06 | q `á/a+combining/i/İ/ß/ss/ΟΣ`, `%/_/\`, numeric/text/null BPM, match solo en beat241 | Literal substring global correcto; no cruce entre campos, sin unaccent; BPM case literal preservado |
| C12-D01 / T01→T04 | Todo C4, JSON desconocido, multipartes, source array≠sort_order, tags extra, escapes/NUL/surrogates | Roundtrip profundo sin pérdida; REVIEW explícito lo no representable; no DTO como importador |
| C12-Q01 / T06 | Índices manual/rating/name/bpm; keyset todos empates; reverse/first; 240/241 registros | Comparaciones consistentes con índice, vecinos exactos, no OFFSET normal ni INDEX; LIMIT+1 |
| C12-Q02 / T06 | Tenant A/B, token manipulado, filtros/limit/sort distintos, revisión concurrente | 400/409 sin fuga, snapshot consistente; replay de lectura no altera datos |
| C12-Q03 / T06→T08 | Cursor expirado por perfil/epoch,410 feed, DB caída, timeout, respuesta antigua | Errores explícitos, reset único, no fallback ni lista vacía falsa; borrador conservado |
| C12-B01 / T06→T08 | bgPage0/1/239/240/241/10.000/10.001/1e9; N0/1/240/241/100k; offset≥N | Algoritmo5.2 exacto; fuera de rango consulta final inversa; profundo en rango409; no navegación ilimitada |
| C12-B02 / T06→T08 | Negativo/fracción/nope/hex/exponente/no seguro/duplicados, cursor+offset, hash/params ajenos | Parser legacy y errores definidos, aviso B, URL preservada; ventana/resolvedOffset comprobados |
| C12-B03 / T08 | Cambiar filtro/sort en bloque posterior, back/forward/reload, logout/login, link raíz/login/signup | Página inicial según query, filtros persistentes y scroll según B-r3, auth/lazy intactos, no respuesta A en B |
| C12-L01 / T06/T07 | Default100/max240/241, batch50/51,64KiB/256KiB/2MiB y +1byte/multibyte | Rechazo correcto antes de mutación; no truncamiento; toda Gallery elegible cabe |
| C12-I01 / T05/T07/T10 | Dos versiones competidoras, reservas última plaza, key misma/diferente, transporte demorado | Un conflicto explícito, cuota correcta y replay durable; cero espera externa reteniendo cliente SQL |
| C12-P01 / T14 | Catálogo disponible y Direct desconectado/lento, startup14, cache vieja, cuenta nueva | Metadata disponible; play/seek/range/artwork/descarga siguen contrato; sin INDEX routing fallback |
| C12-P02 / T14 | Reemplazo mientras reproduce, trash/restore, multipart, response vieja a misma ID | Referencias por versión/owner, ningún medio ajeno/parte perdida; UI y Playbar LOCAL sin reemplazo |
| C12-M01 / T17 | SHA/descriptor/perfil incorrectos, sin aprobación A1/A2/B-legacy, generación no validada, dry-run repetido | Sin corte; informe STOP específico, nada destructivo ni reparación automática |
| C12-M02 / T17→T18 | Nuevas escrituras, export≤15MiB y >cota, checkpoint perdido, cursor antiguo tras rollback | Export actual íntegro o freeze; autoridad única, old cursor stale, CLI idempotente |
| C12-R01 / T19 | Restore anterior a purge, bytes únicos ausentes, journal incompleto | restore_hold, daño/block explícito, no resurrección falsa; RPO/RTO medidos |
| C12-X01 / T20 | Todos perfiles7 + rebuild colación | Métricas/SLO y costos reales; STOP si falta hardware/muestra/EXPLAIN o no cumple |

**G0/T00:** descriptor del probe y baseline histórico identificados; base real comparada; aceptaciones A1/A2/B-legacy e interacciones registradas (B-experiencia ya aprobada) y contrato sin decisiones visibles implícitas. G0 puede cerrar diseño antes de construir SQL: la paridad del algoritmo candidato corresponde T06, no se certifica anticipadamente. Si producto exige equivalencia universal navegador/SQL, A1 no puede aprobarse como está; requiere nueva decisión de alta capacidad. La diferencia Node/Chrome ya observada no sustituye PostgreSQL/Edge.

**G1:** T01 mapa exhaustivo más T04 roundtrip y delta autoritativo por campo/ref/estado; no basta conteo. T01 no puede «resolver» decisiones pendientes editando expected de fixtures. Datos reales solo con autorización, snapshot íntegro y evidencia; la cobertura sintética no certifica todas las bibliotecas.

**G2/G3/G4:** sin cambios de definición. G2 transporte real aislado y cercado; G3 concurrencia/fallos PostgreSQL; G4 restore/rollback/backups/performance medidos y operación autorizada. T14 verifica media/UI, T17 CLI, T20 capacidad: no confundirlos como en el acta antecedente.

## 9. Registro histórico de pendientes r3 — sustituido por r4

**B-experiencia: APROBADA** por anexo oficial, incluyendo consulta global, scroll infinito virtualizado, desmontaje, reset de filtros/sort y audio independiente de tarjetas. No volver a pedir esa aprobación. No equivale a implementación autorizada ni a aprobar todo r2.

| Código | Estado / decisión pendiente | Acción segura |
| --- | --- | --- |
| STOP-DESIGN-A1 | ICU und fijo todavía no aprobado; diferencias lingüísticas r2 conservadas | Decidir perfil3.2 o rediseñar, no fingir paridad universal |
| STOP-DESIGN-A2 | Orden BPM total NaN al final pendiente | Aprobar3.3 o elegibilidad explícita sin NaN; no corregir raw |
| STOP-DESIGN-B-LEGACY | Cota10.000, copy y destino no resoluble/membresía pendientes | Decidir política5.2 sobre ancla, sin pager ni barrido; Ir al inicio solo recomendación |
| STOP-INTERACTION-SELECTION/QUEUE/TAGS | Alcances que antes dependían de página; análisis y opciones en sección6 del plan B | Alta capacidad cierra conducta/contrato antes de V07/V08; no escoger scope cache por conveniencia |

Protocolo: registrar fecha, actor/instrucción, revisión C12-r3 y IDs aceptados; incorporar alternativa concreta sin silenciar diferencias. T00/G0 se revisa formalmente con baseline/base/descriptor/contrato e interacciones; no PASS automático. T01 requiere gate y autorización. Paridad PostgreSQL/Edge, layout real, SQL y performance corresponden a tareas futuras, nunca se certifican por aprobar una arquitectura.

```text
B-experiencia: APROBADA (anexo b585540)
A1 / A2 / B-legacy: PENDIENTES
Interacciones de selección/cola/facetas: STOP específico del plan B
STOP-TEST baseline histórico: RESUELTO, no rerun actual
STOP-ENV descriptor G0: RESUELTO, arnés T02 pendiente
C12: NO CERRADO; T00: NO PASS; G0: NO APROBADO
T01: BLOQUEADA; T02: NO INICIADA
```

El [plan B V00–V11](C12-B-INTEGRACION-Y-PLAN-20261107.md) es la descomposición obligatoria para futuras tareas; no renumera T00–T25. Hoy el ejecutor debe registrar STOP y volver a alta capacidad, sin iniciar T01. Entregar SHA/branch, decisión pendiente, fixture/trace, paths y resultados realmente observados. La copia r2 completa y los documentos remotos quedaron protegidos antes de reconciliar; la caracterización r2 permanece intacta.

Paths/resultados de esta integración se registran en ESTADO/EVIDENCIA y sección1 del plan B. Solo documentación; sin commit/push, runtime,tests,workflows,producción,AWS,Telegram o DB. No rastreados ajenos preservados.

## Transferencia normativa vigente C12-r4

[cierre C12-r4](C12-V00-CIERRE-20261107.md) integra las aprobaciones explícitas y sustituye pendientes/recomendaciones incompatibles r2/r3. A1 ICU fijo, A2 binary64/clase y B-legacy <=10.000 quedan aprobados. I1 selección global con aviso solo si había selección; I2 audio continuo, nuevo query y cola prioritaria, Shuffle sin repetición por ronda; I3 rename ACTIVE/TRASH sin modificar estado. Se descarta fijar permanentemente la búsqueda musical al pulsar Play.

Aplicar las dependencias, algoritmos, alternativas y STOP de sección 7 del cierre a T01/T03/T06/T07/T13/T14/T20 y V00–V11. Membresías SQL persistidas, selección CAS, facetas, journal y swaps Shuffle no son memoria global del cliente. T01/T06 deben producir inventario y contratos tipados completos en sus tareas futuras. T00 revisa formalmente base/descriptor/baseline/contrato, sin volver a solicitar las aprobaciones resueltas. T01 permanece bloqueada; ningún paso de implementación iniciado.
