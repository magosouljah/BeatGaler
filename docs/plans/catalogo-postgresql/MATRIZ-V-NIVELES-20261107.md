# Matriz de subtareas V00–V11 por nivel — N1

Fecha: 2026-11-07. Complementa las fichas V00–V11 de [plan B §8](C12-B-INTEGRACION-Y-PLAN-20261107.md), sin omitir sus pasos ni casos, y se subordina a [C12-r4](C12-V00-CIERRE-20261107.md), a [CONTRATO](CONTRATO.md)/[MIGRACION](MIGRACION.md) y a las fichas T de [TAREAS](TAREAS.md). Reparto, escalamiento y STOP: [manual N1](EJECUCION-POR-NIVELES-20261107.md). Fichas T ampliadas: [matriz T](MATRIZ-T-NIVELES-20261107.md). **Documento de planificación: no ejecuta V00–V11, no emite PASS y no autoriza implementación ni acceso a servicios o datos reales.**

## 1. Convenciones comunes a las 12 fichas

- **Qué es una V.** Cada V subdivide una o varias T existentes; no es una T nueva, no abre gates y su PASS no da PASS a la T padre. Los paquetes A/B/C/D son entregas secuenciales dentro de su V; no son V nuevas ni autorizan agentes paralelos (N1 §1). Una V se entrega en el encargo de su T padre; recibir esta matriz no autoriza empezarla.
- **Estado de partida de todas las V:** NO INICIADA. Ningún archivo, endpoint, comando, suite o runner futuro citado aquí existe por haberlo nombrado. Comprobado el 2026-11-07 por listado de directorios: no existen `scripts/catalog-check.cjs`, `cloud-server/catalog/`, `src/features/catalog/` ni `src/features/library/catalog/`.
- **Entrada común EV:** encargo de la T padre con su autorización, Git/AGENTS (N1 §6.2), ESTADO y evidencias de dependencias con alcance PASS explícito, r4, plan B §§2–9, N1 §§3–5 y la ficha T padre de la matriz T. Nada de PASS implícito leyendo la palabra en otro documento.
- **Salida común SV:** handoff N1 §9 con la tabla `requisito → fixture/hash → test → esperado → observado → log`, diff acotado, lista de casos no ejecutados y su causa, y registro en ESTADO/EVIDENCIA; artefactos en `artifacts/catalog/<run-id>/` (TAREAS, reglas).
- **PASS común PV:** todos los pasos de la ficha original de plan B §8 y de esta matriz completos; 0 FAIL y 0 SKIP obligatorios; casos ejecutados contra el código/entorno identificado por SHA y hash; `git diff --check` más revisión de archivos nuevos sin seguimiento; ninguna salida fake presentada como evidencia de proveedor real (`PASS-AISLADO` cuando corresponda).
- **Comando futuro C(Txx):** `node scripts/catalog-check.cjs Txx`, `perf` o `all-local`, solo cuando T02 lo haya creado y el manifiesto de la T padre registre los casos de la V. Mientras no exista: la V registra sus casos aislados reales y los pendientes, y no informa PASS de grupo (plan B §9, último párrafo).
- **Fallo R/E y STOP:** expediente E, clasificación R y tabla de STOP de N1 §5; aquí solo se listan los STOP específicos. Nunca cambiar esperados, umbrales, N, budgets, fixtures o cobertura para pasar.
- **Permiso común A:** encargo de la T padre y entorno desechable identificado. Ninguna V autoriza main, producción, AWS, Telegram real, MASTER, bots, DESIGN ni bibliotecas de usuarios.
- **Diseño visible intacto:** ninguna V cambia el aspecto de BeatCards, Toolbar, Tag Bar, Playbar, Landing o Gallery LOCAL. Los ajustes de cleanup interno (por ejemplo timers de BeatCard, plan B V06) no alteran DOM visible ni CSS de diseño y se verifican con capturas V09.
- **Decisiones r4 cerradas:** A1, A2, B-experiencia, B-legacy, I1, I2, Shuffle e I3 (r4 §2) no se vuelven a someter a aprobación. Cualquier cita histórica «pendiente» de r2/r3/plan B/anexo B se lee como sustituida por r4 §1 (ver §2 de esta matriz).

## 2. Reconciliaciones nuevas detectadas al construir la matriz V

N1 §3 ya resuelve V00/V01/V07/V09/V10/V11 y las dependencias T↔V. Las siguientes son adicionales; se corrigen con la regla mínima indicada y se registran también en N1 §3.

| ID | Documentos en conflicto | Por qué hay conflicto y consecuencia | Corrección mínima | Gate / prueba que lo verifica |
| --- | --- | --- | --- | --- |
| RV1 | C12-DECISION-RECORD §5.2 paso 7 («No podemos abrir esa posición del enlace anterior») vs r4 §2 B-legacy («Este enlace antiguo no se puede abrir en esta posición.» + «Ir al inicio») | Dos textos visibles distintos para el mismo caso. Un ejecutor podría fijar el expected histórico y obtener un PASS sobre copy no aprobado | El texto visible y la acción salen exclusivamente de r4 §2. El código 409 `LEGACY_OFFSET_UNRESOLVABLE` y el resto del algoritmo r2 §5.2 se conservan | V02-C (respuesta servidor) y V09 caso C12-V-LEGACY comparan cadena exacta con r4 §2 y comprueban que no hay salto automático |
| RV2 | Plan B §6 «STOP-INTERACTION-QUEUE» (recomienda fijar query musical al iniciar play y un sampler SQL) vs r4 §2 I2/Shuffle y §5 | Si V06 sigue el plan B, Next/Previous usarían el query del momento del Play y otro algoritmo aleatorio; r4 lo descarta expresamente | V06 implementa I2 de r4 (Next/Previous sobre resultados vigentes, cola prioritaria) y consume el Fisher–Yates persistido de r4 §5 implementado en T14-B. La recomendación del plan B queda histórica | V06-E: cambiar filtros durante reproducción → audio sigue y Next toma el primer resultado del nuevo query; ningún RNG en cliente |
| RV3 | TAREAS T08 (archivos `src/features/catalog/*`) y matriz T T08 vs plan B §3 (módulos en `src/features/library/catalog/` y `src/features/playback/`) | Dos raíces propuestas para el cliente de catálogo; ninguna existe. BAJA podría crear módulos duplicados en ambas | La primera entrega de T08 (V03-A, MEDIA) fija **una** raíz para los módulos de plan B §3 y la registra en el handoff antes de que BAJA cree archivos. Mientras no se fije, BAJA no crea archivos de cliente catálogo | Handoff V03-A con la raíz; al cerrar V05, `rg --files src` muestra una sola raíz de cliente catálogo |
| RV4 | r4 §7 fila T08/V04–V05 («flags de selección por DTO, facetas acotadas») vs plan B §8 V04 («No Playbar ni selección dentro del store de ventana») | Parece pedir y prohibir selección en el store. Si se mezcla, una evicción podría alterar la selección; si se omite, faltan los flags de DTO de r4 §4 | El store de ventana solo transporta, como campo de solo lectura del DTO, el flag `selected` que devuelva el servidor junto con su `selectionVersion`. Token, count, excepciones y CAS viven en `catalogInteractionStore` (V07-A). El cache de facetas es una estructura acotada separada creada en V04-C y conectada a GalleryChrome en V07-A | V04-B: expulsar un DTO seleccionado no cambia count/token de selección; V07-A: seleccionado evictado sigue seleccionado |
| RV5 | Precondiciones históricas «A1/A2 pendientes» en plan B §8 V02/V11, anexo B §6, TAREAS tabla r3 fila V00 («Decisiones pendientes») | Un ejecutor podría bloquear V02/V11 o pedir aprobación otra vez | Leer como satisfechas por r4 §1 a nivel de decisión. Siguen exigiéndose las dependencias técnicas (T05 PASS para V02; G0–G4 y permisos para V11). V11 verifica trazabilidad de r4 en el candidato, no pide aprobación nueva | V00-A tabla D→C marca cada cita histórica como sustituida; V11-A checklist referencia r4 §1 |

## 3. Índice maestro V

| V | Nombre original (plan B §8) | T padre | Dependencia / gate de entrada | Responsable principal / dificultad | Paquetes y otros niveles |
| --- | --- | --- | --- | --- | --- |
| V00 | Fijar contrato e interacciones | T00 (V00-A), T01 (V00-B) | V00-A: encargo T00/G0; V00-B: G0 formal + encargo T01 | CHAT NORMAL / baja-media de juicio | A0 BAJA prepara paquete; A Sol dictamen; B BAJA clasificación; vacíos técnicos → T01-B ALTA |
| V01 | Fixtures y arnés seguro | T01 (V01-A), T02 (V01-B/C) | V01-A: encargo T01; V01-B: T01 PASS + encargo T02 | IDE BAJA / media | A BAJA fixtures; B MEDIA arnés; C BAJA ataques negativos |
| V02 | Contrato de lectura y cursores | T06 | T05 PASS, V01 completa, descriptor T02 | IDE MEDIA / alta localizada | A ALTA (= T06-A) interfaces nuevas; B MEDIA lectura/cursores; C BAJA casos |
| V03 | Geometría pura y CSS fixture | T08 | T07 PASS, V01, V02 | IDE MEDIA / media | A MEDIA fixture y raíz de módulos; B BAJA medición; C BAJA funciones puras |
| V04 | Store acotado | T08 | V02, V03 | IDE MEDIA / media | A MEDIA store; B BAJA budgets/tests; C MEDIA facetas y flags DTO |
| V05 | Grid y navegación aislados | T08 | V04 | IDE MEDIA / media | A MEDIA grid/hook/navegación; B BAJA escenarios DOM; C MEDIA cierre |
| V06 | Separar playback/recursos | T14 | T13 PASS (incluye V07-A), V04, contrato musical T06-A | IDE MEDIA / alta de integración | A BAJA inventario recursos; B MEDIA PlaybackSession; C MEDIA comandos musicales; D BAJA recursos; E BAJA casos r4 |
| V07 | Selección/edición/drop/facetas | T13 (V07-A), T14 (V07-B) | V07-A: T12 PASS, V00, V04, contratos T06/T07; V07-B: V06 | IDE MEDIA / media-alta | A MEDIA+BAJA en T13; B MEDIA+BAJA en T14 |
| V08 | Integrar composición por autoridad | T16 | T15 PASS, V05, V06, V07 completas | IDE MEDIA / media-alta | A MEDIA providers; B BAJA spies/regresión; C MEDIA manifiesto V09 |
| V09 | Regresión navegador/accesibilidad | T16 (ejecución); T21 consume | V08 cerrada en fixture + manifiesto V08-C | IDE BAJA / media de ejecución | A BAJA entorno; B BAJA casos; C MEDIA revisión de fallos |
| V10 | Capacidad y leak soak | T20 | T19 PASS, V09 PASS, perfil C11-LAB-v1 disponible | IDE BAJA / media de medición | A BAJA manifiesto; B BAJA campañas; C MEDIA metodología/tuning; ALTA solo STOP-SHUFFLE-PERF/arquitectura |
| V11 | Candidato y migración | T21 (V11-A), T22 (V11-B), T23 (V11-C) | V10 + G1 sintético + G2 real + G3 + G4 laboratorio; luego permisos por fase | IDE MEDIA / media-alta operativa | A BAJA paquete; T21-B ALTA revisión; B BAJA/MEDIA G1 real; C MEDIA piloto; usuario permisos |

Recuento: CHAT 1 (V00), BAJA 3 (V01, V09, V10), MEDIA 8 (V02–V08, V11), ALTA 0 principales. Coincide con N1 §2. Intervenciones ALTA previstas dentro de V: V00 solo a través de T01-B (condicional), V02-A (= T06-A), V06/V10 solo ante STOP-SHUFFLE-PERF o contrato incompatible, V11 a través de T21-B. No se suman como tareas.

## V00 — Fijar contrato e interacciones

**1. ID y nombre:** V00 — Fijar contrato e interacciones (plan B §8, encabezado histórico «T00/T01, alta capacidad»; reparto vigente N1 §3).

**2. Objetivo concreto:** demostrar que el contrato visible r4 está completo, sin conflictos y trazado a casos futuros (V00-A), y clasificar cada consumidor actual del array de biblioteca dentro de T01 (V00-B). No define producto ni vuelve a pedir aprobación de A1/A2/B-legacy/I1/I2/I3/Shuffle.

**3. Tarea T:** T00 (V00-A, dentro de la revisión formal G0) y T01 (V00-B, inventario T01-A pasos 1–2).

**4. Dependencias y gate de entrada:** V00-A: encargo T00/G0 autorizado; ninguna V previa. V00-B: dictamen formal T00/G0 y encargo T01 (N1 §3: T01 solo necesita V00-A). Salida hacia G0 (V00-A) y G1 (V00-B vía T01/T04).

**5. Responsable principal y dificultad:** CHAT NORMAL (GPT-6 Sol); dificultad baja-media de juicio documental. Sol no ejecuta comandos Windows ni afirma haberlos ejecutado (N1 §8).

**6. Paquetes:**
- V00-A0 — IDE BAJA, dentro de T00-A: arma el paquete de revisión.
- V00-A — CHAT NORMAL: dictamen de consistencia por decisión.
- V00-B — IDE BAJA, dentro de T01-A: clasificación de consumidores; revisión de cobertura por IDE MEDIA en T01-C.
- Sin paquete ALTA propio: un vacío técnico demostrado se entrega a T01-B.

**7. Trabajo de IDE BAJA:** todo V00-A0 y V00-B. No decide si una regla basta: si duda, la incluye como pregunta en el paquete de Sol o como fila «sin regla» para T01-B.

**8. Intervenciones de ALTA:** solo si V00-B encuentra un consumidor o flujo sin contrato ejecutable. Pregunta tipo: «el consumidor `<path:símbolo>` necesita semántica global; ¿qué filas de membresía/selección/ronda/facetas/cola (r4 §3) y qué invariante de versión/lock lo cubren?». Alternativas a considerar: las de r4 §§3–6. Resultado: contrato versionado en el mapa T01-B con dueño de implementación. No elige producto.

**9. Archivos de entrada:** r4; [acta I1/I2/I3](C12-V00-INTERACCIONES-APROBADAS-20261107.md); [C12-DECISION-RECORD](C12-DECISION-RECORD.md) §§2–5 y 8; plan B §§2–8; [anexo B](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md); CONTRATO C1–C12 y C12-B; TAREAS T00/T01; N1; matriz T T00/T01; [caracterización](C12-CARACTERIZACION-20261107.md). V00-B además: `src/`, `cloud-server/` (sin `.env`), según el procedimiento de matriz T T01-A.

**10. Archivos de salida previstos:** V00-A: dictamen de Sol registrado por la IDE en un acta T00/G0 nueva (nombre lo fija el encargo T00) y en ESTADO/EVIDENCIA. V00-B: filas en los futuros `contract-map.json` y `consumer-map.md` de T01.

**11. Contratos e invariantes:** r4 §2 (8 decisiones) y los párrafos de r4 §2 posteriores a la tabla (currentBeat fuera del query, query vacío, filtros/sort y ronda); r4 §3 (el navegador nunca guarda el conjunto completo); plan B §3 (`windowItems`/`renderItems`/`visibleItems` no son globales); plan B V13 (reorder Web = false); C1 (una autoridad, sin fallback INDEX).

**12. Orden exacto:**
1. V00-A0: registrar rama, SHA, dirty paths y SHA256 de r4, acta I, C12-DECISION-RECORD, plan B, anexo B, N1, matriz T y esta matriz.
2. V00-A0: construir tabla D→C con una fila por decisión r4 §2 y por cada regla de los párrafos posteriores: cláusula fuente exacta, V/T consumidora, casos `C12-*` que la prueban, STOP aplicable.
3. V00-A0: listar todas las citas históricas que dicen «pendiente» (como mínimo: C12-DECISION-RECORD §5.1–5.2 y §9, plan B §§6, 7 y 10, anexo B §§3 y 6, tabla r3 de TAREAS fila V00) y marcarlas «sustituida por r4 §1»; incluir RV1, RV2 y RV5.
4. V00-A (Sol): por cada fila D→C, dictaminar CONSISTENTE o HALLAZGO con cláusula, impacto y destino (MEDIA, T01-B ALTA, usuario si y solo si cambia conducta visible aprobada).
5. V00-B: para cada aparición de `setBeats`, `windowItems`, `displayedBeats`, `filteredBeats`, `beats.find`, `selectedIds`, `queueIds`, `releaseFile`, `allTags`, `tagFrequency` y caches `localStorage` de biblioteca, asignar exactamente una clase: ventana, entidad, operación, global SQL, legacy-only o Desktop-only; más destino V/T y test propietario.
6. V00-B: todo consumidor que cuente, enumere o escriba sobre toda la biblioteca se clasifica «global SQL» y debe apuntar a contrato de servidor (r4 §§3–6). Si lee `windowItems` con semántica global → STOP-CONTRACT.

**13. Pruebas y fixtures:** V00-A es documental: no hay test ejecutable. V00-B se verifica con la cobertura bidireccional de T01-C y los fixtures V01-A de ventana/estado externo.

**14. Resultados esperados:** 8/8 decisiones r4 con cláusula, consumidor y caso; 0 conflictos sin destino; 100 % de apariciones productivas clasificadas; 0 consumidores globales sobre ventana sin contrato.

**15. PASS objetivo:** V00-A: dictamen de Sol CONSISTENTE o todos los hallazgos con destino y resolución trazada. V00 completa: V00-A + V00-B con 0 sin clasificar, revisado por MEDIA. No equivale a T00 PASS ni a G0.

**16. STOP específicos:** STOP-GATE si al paquete de Sol le falta un extracto o hash; STOP-CONTRACT si un consumidor global depende de ventana; STOP-DESIGN solo si dos reglas r4 se contradicen técnicamente (→ ALTA); conducta visible nueva → usuario. Nunca reabrir una aprobación por cita histórica.

**17. Recuperación segura:** solo lectura. Si el hash de r4 o del acta I difiere del registrado, STOP-BASE y comparar con copias versionadas; no editar r4.

**18. Escalamiento:** BAJA → MEDIA si no se puede trazar el caller hasta un entrypoint; MEDIA → ALTA (T01-B) si falta contrato; Sol → usuario solo por diferencia concreta respecto de r4.

**19. Autorizaciones:** V00-A dentro del encargo T00/G0; V00-B dentro del encargo T01. Ninguna operación real.

**20. Handoff:** a T01: tabla D→C con hashes y dictamen Sol. A T01-B: lista de vacíos con ejemplos. A V02/T06-A: interfaces que exigen las decisiones (conjuntos, selección, facetas, comandos musicales). A V06/V07: reglas I1/I2/I3/Shuffle trazadas.

## V01 — Fixtures y arnés seguro

**1. ID y nombre:** V01 — Fixtures y arnés seguro (T01→T02).

**2. Objetivo concreto:** crear los datos sintéticos y oráculos que usan V02–V10 (V01-A, sin base de datos) y el arnés aislado de navegador y servidor fake con contadores (V01-B), demostrando con casos negativos que no puede tocar DB ajena ni red externa (V01-C).

**3. Tarea T:** T01 (V01-A) y T02 (V01-B, V01-C).

**4. Dependencias y gate de entrada:** V01-A: encargo T01 (tras T00/G0). V01-B/C: T01 PASS y encargo T02. N1 §3: T01 no depende del PASS de V01-B.

**5. Responsable principal y dificultad:** IDE BAJA (contenido de fixtures y cierre de V01); dificultad media. Límites de seguridad del arnés: IDE MEDIA como propietario de T02.

**6. Paquetes:**
- V01-A — IDE BAJA (T01): fixtures y oráculos.
- V01-B — IDE MEDIA (T02): servidor/transporte fake, reloj controlable, contadores y harness de navegador.
- V01-C — IDE BAJA (T02): pruebas negativas del arnés y del aislamiento.

**7. Trabajo de IDE BAJA:** V01-A completo y V01-C completo. En V01-B puede escribir los contadores y helpers que MEDIA haya fijado con firma exacta.

**8. Intervenciones de ALTA:** ninguna prevista. Solo si el modelo de aislamiento de T02 no puede impedir conexión a un destino dudoso (matriz T T02: «ALTA solo cambio del modelo de aislamiento»).

**9. Archivos de entrada:** plan B §§4–5 y §9; r4 §§3–6; C4; mapa T01 en construcción; `src/app/AppShell.tsx`, `src/features/design/GALLERY/product-gallery.css`, `gallery.css`, `src/components/BeatCard.tsx` (solo lectura, para que los fixtures cubran sus estados); descriptor G0 histórico solo como referencia, no como DB.

**10. Archivos de salida previstos:** V01-A: fixtures en `cloud-server/tests/fixtures/catalog/` (ruta de matriz T T01) con manifiesto por fixture: id, generador, versión, semilla, SHA256, N, oráculo esperado y si el esperado es «actual» o «candidato r4». V01-B: los archivos futuros de T02, hoy inexistentes (`scripts/catalog-check.cjs`, `cloud-server/tests/helpers/catalog-test-db.cjs`, `catalog-fake-transport.cjs`, manifiesto de suites) y el harness de navegador en la ruta que registre ese manifiesto.

**11. Contratos e invariantes:** sin auth real, Telegram, MASTER ni Cloud reales; sin `.env` heredado; los datasets grandes se generan en el servidor fake, nunca como array prop del cliente (plan B §9); oráculos independientes del código bajo prueba; IDs y nombres sintéticos, sin datos de usuarios.

**12. Orden exacto:**
1. V01-A: fixtures de ventana: N = 0, 1, 239, 240, 241; bloques de 240 en ambas direcciones con boundary y ordinal esperados; ancho de 1, 2, 3, 4, 5, 6 y 7 columnas.
2. V01-A: metadata larga (nombres, tags, BPM) que ejerza límites C5/C12-L01 sin superar 2 MiB por bloque; artwork con retardo declarado (2 s) y con error.
3. V01-A: estado externo: currentBeat fuera de la ventana, selección y borrador offscreen, cola con IDs no cargados, cuenta A→B con datos distinguibles.
4. V01-A: generador determinista con semilla 777 para 100.000 y 1.000.000 beats que produzca bloques bajo demanda y un digest incremental esperado de la secuencia completa (para V10), sin materializar listas de N IDs en memoria del cliente.
5. V01-B: servidor fake de catálogo y transporte fake que lanza error si se le llama para metadata; reloj controlable; contadores de fetch, mount/unmount, listeners, timers, observers y blob URLs.
6. V01-B: harness de navegador que monta la Gallery LOCAL con dobles, sin auth/Telegram reales; registra navegador, viewport, DPR, zoom y fuentes.
7. V01-C: casos negativos: entorno contaminado, URL de DB ajena, marker/ownership falso, suite inexistente o con skip, cleanup de recurso ajeno, intento de red externa; cada uno debe fallar con exit ≠ 0 y contador de acceso 0.

**13. Pruebas y fixtures obligatorios:** tests del propio arnés de T02; pruebas de reproducibilidad (mismo SHA256 en dos generaciones con semilla 777); V01-C completo. Prohibido usar `postgres-live.integration.cjs` o el probe G0 como sustituto.

**14. Resultados esperados:** cada fixture reproducible por hash; oráculos que separan actual/candidato; arnés que rechaza todo destino no asignado antes de conectar; contadores de red externa = 0 en unit.

**15. PASS objetivo:** V01-A: fixtures y oráculos completos según los 4 primeros pasos, revisados en T01-C. V01 completa: además V01-B/V01-C con PV y logs de aislamiento y cleanup solo de recursos creados por el run.

**16. STOP específicos:** STOP-ENV si el arnés no está aislado o el destino es dudoso (cero escrituras); STOP-DATA si un fixture necesita un campo cuyo raw no está en el mapa; STOP-TEST si un negativo pasa por motivo no demostrado.

**17. Recuperación segura:** regenerar fixture desde semilla y comparar hash; nunca editar el oráculo para que coincida con la salida; borrar solo DB/recursos con marker propio verificado.

**18. Escalamiento:** BAJA → MEDIA para guardas/subprocess del arnés; MEDIA → ALTA solo por cambio de modelo de aislamiento.

**19. Autorizaciones:** encargo T01 (V01-A) y encargo T02 con entorno desechable concreto (V01-B/C). Ningún AWS ni proveedor real.

**20. Handoff:** catálogo de fixtures con hashes y oráculos; contrato del fake (qué devuelve, qué rechaza); nombres reales de contadores; comandos del manifiesto T02 realmente creados y grupos futuros marcados pendientes; para V02: fixtures 240/241/bordes; para V03: anchos y columnas; para V10: generador y digest.

## V02 — Contrato de lectura y cursores

**1. ID y nombre:** V02 — Contrato de lectura y cursores (T06, después de T05).

**2. Objetivo concreto:** extender la lectura T06 con `resumeCursor` inclusivo, ordinal/count del mismo snapshot, before/after internos, `edge=last` con lectura inversa y resolver legacy r2 §5.2 con salida a ancla, y cerrar antes de cualquier cliente las interfaces nuevas de conjuntos, selección, facetas y comandos musicales.

**3. Tarea T:** T06.

**4. Dependencias y gate de entrada:** T05 PASS; V01 completa; descriptor real ICU/versión registrado por T02 (matriz T T06 exige verificar ICU real, no la colación por defecto del probe). A1/A2 aprobadas en r4 (RV5).

**5. Responsable principal y dificultad:** IDE MEDIA; alta localizada en contratos nuevos r4.

**6. Paquetes:**
- V02-A — IDE ALTA (es la intervención T06-A; no es una tarea adicional): contratos nuevos.
- V02-B — IDE MEDIA: implementación de lectura y cursores.
- V02-C — IDE BAJA: casos y EXPLAIN.

**7. Trabajo de IDE BAJA:** V02-C completo: casos parametrizados con fixtures V01, EXPLAIN ANALYZE/BUFFERS sobre sintéticos y tabla de resultados. Puede escribir validadores de esquema JSON de respuesta ya fijados por V02-A/B.

**8. Intervenciones de ALTA (V02-A):** preguntas concretas, cada una con resultado versionado (request, response, errores 400/409/503, auth/era/revision, CAS, idempotencia, ejemplos y contraejemplos):
- Q1 Conjuntos: create/status/cancel de `catalog_query_sets` con `BUILDING → READY | STALE | FAILED | CANCELLED`, lease y reuso por owner/predicado/revisión (r4 §3). Alternativas: recurso de conjuntos propio o creación implícita por los comandos de selección/Shuffle.
- Q2 Selección: CAS, rangos inclusivos de membresía, excepciones y precedencia de la última operación confirmada (r4 §4); flags `selected` en DTO.
- Q3 Facetas: keyset por frecuencia desc / nombre A1 / clave binaria, activos por identidad aparte del bloque (r4 §6).
- Q4 Comandos musicales: next/previous/sorteo/cola con sequence CAS y resultado idempotente (r4 §5 paso 1 y 4).
- Q5 Reanclaje: tras revisión nueva, ¿reanclar por ID (con coste SQL/COUNT y timeout demostrados por EXPLAIN de V02-C) o aplicar stale? Plan B §5 permite ambos; por defecto stale.
ALTA no rediseña Fisher–Yates, sort, UX ni el alcance aprobado.

**9. Archivos de entrada:** C5; C12-DECISION-RECORD §§3.2, 3.3, 3.4, 4 y 5.2; plan B §§5 y 7 (Home/End, `edge=last`); r4 §§2–6; mapa T01 y DDL T03; fixtures V01; resultados T05.

**10. Archivos de salida previstos:** `cloud-server/catalog/queries.js` y `routes.js` (futuros, matriz T T06), migración de índices aditiva con el siguiente número libre, manifiesto de API tipado registrado por T01, tests de queries/HTTP con los nombres que fije el manifiesto T02, informe EXPLAIN en artifacts.

**11. Contratos e invariantes:** cursor `base64url(payload).base64url(HMAC)` con campos de C12-DECISION-RECORD §4.2 y `direction`/`boundary.inclusive` firmados; reabrir con `GET /catalog/v1/beats?...&cursor=<resumeCursor>` — **no crear endpoint alternativo**; `cursor` + `edge` → 400 `INPUT_INVALID`; token ajeno 400 `CURSOR_INVALID`, propio viejo 409 `CURSOR_STALE`; `includeTotal` exacto del snapshot; sin OFFSET salvo el único OFFSET acotado ≤10.000 del resolver legacy; copy legacy de r4 §2 (RV1); lectura Gallery SQL directa sin esperar membresía (r4 §3).

**12. Orden exacto:**
1. V02-A: ALTA responde Q1–Q5 y publica contrato versionado; MEDIA lo registra en el manifiesto de API distinguiendo interfaces entregadas en T06 de implementaciones de T07/T10/T14.
2. V02-B: añadir `resumeCursor` inclusivo a la respuesta de lista y aceptar su reapertura por la misma ruta; devolver bloque de 240 con `startOrdinal` y count del mismo snapshot.
3. V02-B: before/after internos con LIMIT+1 y tupla completa; `edge=last` con índice inverso y reversión del bloque, count consistente.
4. V02-B: resolver legacy r2 §5.2 pasos 1–8; salida bloque + contexto + `resumeCursor` + ordinal del anchor.
5. V02-B: pasos de preparación de membresía ≤240 invocables por el arnés y publicación READY validada (scheduling durable queda en T10).
6. V02-C: ejecutar casos de §13 y EXPLAIN sobre 100k y 1M sintéticos; registrar filas examinadas/devueltas y buffers.

**13. Pruebas y fixtures obligatorios:** C12-Q01, Q02, Q03, B01, B02, L01 (y U02/N01/F01/F02 en T06); vuelta a un bloque evictado por `previousCursor` de frontera y por `resumeCursor`; fronteras parciales (último bloque 1…240); tenant A/B y revisión cambiada; `edge=last` con N = 0/1/240/241; `cursor`+`edge`; bgPage 0/1/239/240/241/10.000/10.001/1e9 con copy r4; 100k/1M sin recorrer cursores ni OFFSET normal; casos r4 de conjuntos (STALE/READY/crash/retry/cancel/contexto).

**14. Resultados esperados:** vecinos exactos sin saltos ni duplicados; ordinal y count iguales entre bloques del mismo snapshot; respuestas de error según §11; 0 llamadas a transporte aunque Telegram esté caído.

**15. PASS objetivo:** PV + EXPLAIN y casos correctos + contratos V02-A completos antes de cualquier consumidor. La V02 PASS es parte de T06; T06 necesita además su ficha completa.

**16. STOP específicos:** STOP-CONTRACT si falta una forma de V02-A; STOP-DESIGN-A si el proveedor ICU no reproduce A1; STOP-PERF si count, seek o `edge=last` no cumplen con EXPLAIN; STOP-INTEGRITY si un ordinal devuelve IDs distintos en el mismo snapshot.

**17. Recuperación segura:** reproducir en DB efímera nueva del arnés; conservar EXPLAIN y payloads (sin tokens completos en logs); no relajar validación de revisión.

**18. Escalamiento:** BAJA → MEDIA (bug de query/índice); MEDIA → ALTA solo con E que pruebe que la estrategia de cursor/contexto es insoluble o que falta una forma de V02-A.

**19. Autorizaciones:** encargo T06 y entorno desechable del arnés.

**20. Handoff:** a V03–V05 y T08: tipos de respuesta, ejemplos y errores; a V04: reglas de validación append/prepend y cursores conservables; a V07-A: contratos de selección/facetas/rename preview; a V06/T14: comandos musicales; a T20/V10: EXPLAIN base.

## V03 — Geometría pura y CSS fixture

**1. ID y nombre:** V03 — Geometría pura y CSS fixture (T08, V01/V02).

**2. Objetivo concreto:** medir en navegador la geometría real del layout LOCAL de Gallery y producir funciones puras de filas/columnas/origen/anchor y overscan cuyo coste no dependa de N, sin modificar diseño.

**3. Tarea T:** T08.

**4. Dependencias y gate de entrada:** T07 PASS (entrada de T08); V01 completa (harness de navegador); V02 PASS dentro de T06.

**5. Responsable principal y dificultad:** IDE MEDIA; media.

**6. Paquetes:**
- V03-A — IDE MEDIA: fixture DOM de la Gallery LOCAL con dobles y raíz única de módulos cliente (RV3).
- V03-B — IDE BAJA: protocolo de medición y tabla de resultados.
- V03-C — IDE BAJA: `catalogRowGeometry` puro y sus tests con las fórmulas de plan B §4.

**7. Trabajo de IDE BAJA:** V03-B y V03-C completos: las fórmulas están cerradas en plan B §§4–5, no requieren decisión.

**8. Intervenciones de ALTA:** solo si la medición desmiente la altura fija de tarjeta (plan B §3: STOP-LAYOUT para alta capacidad, no improvisar otro motor).

**9. Archivos de entrada:** `src/app/AppShell.tsx` (contenedor `data-library-scroll`), `src/features/design/GALLERY/product-gallery.css`, `gallery.css`, `src/features/design/shared/beatCard.css`, `src/components/BeatCard.tsx`, plan B §§3–5, fixtures V01. Todos de solo lectura.

**10. Archivos de salida previstos:** `catalogRowGeometry.ts` y su test bajo la raíz fijada en V03-A; fixture de medición; tabla de medidas en artifacts. Si hace falta CSS, solo `catalog-gallery.css` con selectores `.bg-product-gallery[data-catalog-mode=postgres]` (plan B §3), sin tocar tokens ni DESIGN.

**11. Contratos e invariantes:** C columnas leídas de `grid-template-columns` resuelto (no duplicar breakpoints en JS); H medida en border-box sin transform de hover; P = H + G; fila `floor(i/C)`, columna `i % C`; top de fila `(globalRow − originRow) × P` + padding del track; track = intervalo residente con a lo sumo un placeholder antes y uno después; sin `ceil(N/C)×P`; overscan `O = min(8, max(2, ceil(ceil(V/P)/2)))`; DOM ≤ `C × (ceil(V/P) + 2O + 2 + 1)`; 239/160 px declarados solo como estimación inicial.

**12. Orden exacto:**
1. V03-A: fijar raíz de módulos (RV3) y montar fixture con la CSS actual, sin auth/Cloud.
2. V03-B: esperar `document.fonts.ready`; medir con getComputedStyle del track `.lab-gallery-grid`: columnas efectivas, columnGap, rowGap, padding y ancho útil; medir altura de BeatCard por ResizeObserver borderBoxSize; registrar viewport, DPR, zoom, fuentes y barra de scroll.
3. V03-B: repetir en anchos 375, 768 y 1440, y en cada breakpoint 359/590/750/940/1160/1400 ±1 px, con zoom 100 % y 200 %.
4. V03-C: implementar funciones puras de fila/columna/top/rango/overscan/DOM máximo, originRow móvil y cálculo de delta de anchor para prepend, evict, resize y cambio de columnas (plan B §4 «Anchor y operaciones» pasos 1–6).
5. V03-C: tests con N = 0/1/239/240/241/100.000/1.000.000 como números, C = 1…7, y última fila parcial alineada a las mismas columnas.
6. V03-A: comparar medidas con funciones; cerrar o STOP.

**13. Pruebas y fixtures obligatorios:** C12-V-GEOM completo (parte geométrica); prueba de que el número de objetos geométricos creados para un viewport es igual con N = 1.000 y N = 1.000.000.

**14. Resultados esperados:** track width, altura y gaps idénticos a LOCAL en cada ancho; deriva del anchor ≤1 CSS px tras prepend/evict/resize sin acción del usuario; sin repeticiones ni huecos de ordinal.

**15. PASS objetivo:** PV + C12-V-GEOM con tabla de medidas reales adjunta. No es PASS de T08 ni activación de producto.

**16. STOP específicos:** STOP-LAYOUT ante columnas 0/NaN, ancho insuficiente, alturas dispares >1 CSS px o discrepancia no explicada; STOP-UX si para pasar hace falta cambiar CSS de diseño.

**17. Recuperación segura:** repetir medición con el mismo manifiesto de navegador; corregir solo aritmética demostrada; no recortar contenido ni cambiar CSS base.

**18. Escalamiento:** BAJA → MEDIA si la medición y la fórmula difieren; MEDIA → ALTA si la altura fija no se sostiene.

**19. Autorizaciones:** encargo T08; navegador local aislado sin sesión autenticada real.

**20. Handoff:** a V04/V05: raíz de módulos, firmas de geometría, tabla H/C/G/padding por ancho y zoom, fórmula de overscan validada y casos de anchor.

## V04 — Store acotado

**1. ID y nombre:** V04 — Store acotado (T08, V02/V03).

**2. Objetivo concreto:** crear `catalogQueryStore` por Workspace/cuenta con a lo sumo seis bloques residentes, cursores de frontera, singleflight/abort, generaciones, evicción solo en extremos, prefetch acotado y descarte de respuestas obsoletas, sin convertir nunca la biblioteca en un array completo del navegador.

**3. Tarea T:** T08.

**4. Dependencias y gate de entrada:** V02 (tipos y validaciones de T06) y V03 (geometría).

**5. Responsable principal y dificultad:** IDE MEDIA; media.

**6. Paquetes:**
- V04-A — IDE MEDIA: núcleo del store.
- V04-B — IDE BAJA: instrumentación de budgets y matriz de tests.
- V04-C — IDE MEDIA: cache acotado de facetas y flags de selección en DTO de solo lectura (RV4).

**7. Trabajo de IDE BAJA:** V04-B completo con los budgets de plan B §5 como esperados fijos.

**8. Intervenciones de ALTA:** ninguna prevista. Solo si viewport + overscan no cabe en seis bloques en un viewport soportado y la única salida es cambiar la estrategia (STOP-BUDGET).

**9. Archivos de entrada:** plan B §§3, 5 y 7 (tabla de errores); r4 §§3–4 y 6; contratos V02; geometría V03; `src/features/library/webLibraryWindow.ts` y `useLibraryState.ts` solo para no reutilizarlos (plan B §5: WebLibraryWindowConsumer queda en LEGACY).

**10. Archivos de salida previstos:** `catalogQueryStore.ts` y tests bajo la raíz de V03-A; contadores de residencia/bytes/inflight.

**11. Contratos e invariantes:** `useSyncExternalStore` con snapshots inmutables estables; store por Workspace/cuenta, no singleton global; bloque interno 240; máximo 6 bloques / 1.440 DTO + ≤ 2(C−1) DTO de borde; ≤ 12 MiB de metadata serializada; máximo 2 peticiones en vuelo, una por dirección; ≤ 2 respuestas entrantes de 2 MiB contabilizadas; historial ≤ 16 entradas + 1 returnAnchor; antes de publicar append/prepend validar tenant, era, epoch, generation, revision, query hash, sort profile, startOrdinal, IDs y fronteras; LRU solo en extremos; evicción ≠ eliminación; sin Playbar ni estado de selección dentro del store.

**12. Orden exacto:**
1. V04-A: estructura de bloques contiguos con cursores de sus dos extremos; queryGeneration y requestGeneration; una promesa por cursor/query.
2. V04-A: append/prepend validados; dedupe de DTO de borde por contexto+ordinal+ID con versión igual.
3. V04-A: evicción del extremo más antiguo fuera de la protección viewport+overscan; liberar referencias al confirmar.
4. V04-A: prefetch que empieza a 2 viewports del borde, ajustable entre 1 y 3 según velocidad/latencia observadas; un bloque vecino por vez.
5. V04-C: cache de páginas de facetas con su propio límite y flag `selected` + `selectionVersion` como campos del DTO; nada de token/count.
6. V04-B: contadores y tests de §13; teardown completo por cambio de cuenta.

**13. Pruebas y fixtures obligatorios:** C12-V-SCROLL y C12-V-BORDER (parte de store); C12-V-QUERY (descartes por generación); C12-V-AUTH (teardown A→B); expulsar un DTO seleccionado no cambia el count/token de selección (RV4); un ID distinto para el mismo ordinal/revisión dispara STOP-INTEGRITY en test.

**14. Resultados esperados:** máxima residencia, bytes e inflight instrumentados y dentro de budget; vuelta atrás por cursor de frontera; ningún índice global de 1M IDs; respuestas tardías descartadas aunque abort no las impida.

**15. PASS objetivo:** PV + todos los budgets medidos y dedupe exacto en fixture.

**16. STOP específicos:** STOP-BUDGET si el cache necesita crecer para avanzar; STOP-INTEGRITY por ordinal repetido incompatible; STOP-CONTRACT si falta un campo de validación en V02.

**17. Recuperación segura:** reproducir con fake de latencia controlada; no aumentar budgets sin registro y remedición.

**18. Escalamiento:** BAJA → MEDIA (bug de store); MEDIA → ALTA solo por estrategia de ventana insuficiente.

**19. Autorizaciones:** encargo T08.

**20. Handoff:** a V05: API del store, eventos y estados de carga/error; a V07-A: contrato del flag de selección y cache de facetas; a V06: garantía de que la evicción no emite eventos de borrado; a V10: contadores.

## V05 — Grid y navegación aislados

**1. ID y nombre:** V05 — Grid y navegación aislados (T08, V04).

**2. Objetivo concreto:** renderizar la Gallery virtualizada en fixture con scroll continuo, desmontaje real de tarjetas fuera de vista, placeholders de frontera, anclas y navegación sin paginación visual; activación de producto fuera de T08.

**3. Tarea T:** T08.

**4. Dependencias y gate de entrada:** V04.

**5. Responsable principal y dificultad:** IDE MEDIA; media.

**6. Paquetes:**
- V05-A — IDE MEDIA: `CatalogVirtualGallery.tsx`, `useCatalogVirtualRows.ts` y `catalogNavigation.ts`.
- V05-B — IDE BAJA: escenarios DOM y contadores.
- V05-C — IDE MEDIA: cierre de V05 y frontera de composición apagada.

**7. Trabajo de IDE BAJA:** V05-B completo con fixtures V01 y servidor fake.

**8. Intervenciones de ALTA:** solo si el track móvil o las revisiones no satisfacen el contrato (STOP-LAYOUT/NAV con E).

**9. Archivos de entrada:** plan B §§3–7; geometría V03; store V04; `src/app/AppShell.tsx`, `src/app/WebGalleryWorkspace.tsx`, `src/features/library/webLibraryNavigation.ts` y `WebLibraryPagination.tsx` (solo lectura: pager LEGACY intacto); `src/features/cloud/useCloudLibraryEvents.ts`.

**10. Archivos de salida previstos:** los tres módulos citados bajo la raíz V03-A; tests DOM; capturas de fixture.

**11. Contratos e invariantes:** un solo scroller (`data-library-scroll`), sin segundo contenedor; claves de tarjeta `(tenant, beatId)` y de fila `(queryGeneration, C, globalRowIndex)`; `overflow-anchor` desactivado solo en el scroller/track POSTGRES; compensación en layout effect antes de paint, sin smooth; sin pager POSTGRES; `bgAnchor` opaco, `replaceState` con debounce 300 ms al estabilizar, `pushState` solo para cambios deliberados, popstate cancela generación; sin `location.assign` por bloques; sin re-sort/filtro local; eventos de catálogo separados de los LEGACY; no `content-visibility`/`visibility:hidden` como sustituto de desmontaje; estructura feed/article con `aria-posinset`/`aria-setsize`.

**12. Orden exacto:**
1. V05-A: hook con un ResizeObserver de geometría, listener scroll pasivo y rAF; calcula rango con V03.
2. V05-A: grid que monta solo filas de rango; placeholders en frontera con reintento contextual sin controles de página.
3. V05-A: ancla y retorno de detalle (un returnAnchor, rehidratar por cursor si fue expulsado); foco según plan B §7.
4. V05-A: navegación URL y bgPage → resolver V02 → ancla; LEGACY sin cambio.
5. V05-B: escenarios §13 con contadores.
6. V05-C: comprobar flags apagados, ninguna rama de producto montada y ninguna llamada INDEX.

**13. Pruebas y fixtures obligatorios:** C12-V-SCROLL, C12-V-BORDER, C12-V-QUERY (coincidencias solo después de 240, ANY+exclusión, sort desde SQL mock), C12-V-FOCUS en jsdom/fixture (la versión real con lector es V09), C12-V-LEGACY en fixture; T08 C(T08): offline/401/503/empty/no-results, evento perdido/410, cursor stale y una recuperación por generación, cuenta A→B.

**14. Resultados esperados:** unmount real contado; scroll infinito en ambos sentidos sin duplicados ni huecos; cero llamadas INDEX y cero re-sort local (spies); placeholders con retry en error; pager visible solo en LEGACY.

**15. PASS objetivo:** PV + casos §13 en fixture. Pruebas de T08 con feature apagada **no** equivalen a lanzamiento; la rama de producto no se habilita hasta V06–V09.

**16. STOP específicos:** STOP-NAV ante saltos/anclas inestables; STOP-LAYOUT; STOP-UX si aparece pager POSTGRES o se activa la rama antes de V06–V09.

**17. Recuperación segura:** reproducir con trace de scroll y medidas; corregir wiring sin cambiar UI.

**18. Escalamiento:** BAJA → MEDIA; MEDIA → ALTA solo por fallo de diseño de track móvil.

**19. Autorizaciones:** encargo T08.

**20. Handoff:** a V08: componentes y su API para AppShell, eventos y estados; a V09: lista de casos de fixture ya cubiertos y pendientes de navegador real; a T08: frontera de composición apagada.

## V06 — Separar playback/recursos

**1. ID y nombre:** V06 — Separar playback/recursos (T14, depende T13 y V04).

**2. Objetivo concreto:** separar la sesión musical del ciclo de vida de las tarjetas: Playbar, cola, seek, repeat y referencias de audio siguen aunque la tarjeta o el DTO se expulsen; los recursos (URLs, promesas, observers, artwork, timers) se liberan por su propio dueño y con límites.

**3. Tarea T:** T14.

**4. Dependencias y gate de entrada:** T13 PASS (incluye V07-A); V04; contrato musical V02-A/T06-A; servidor Shuffle de T14-B para la parte de Shuffle.

**5. Responsable principal y dificultad:** IDE MEDIA; alta de integración con algoritmo ya decidido.

**6. Paquetes:**
- V06-A — IDE BAJA: inventario de liberación de recursos.
- V06-B — IDE MEDIA: `catalogPlaybackSession.ts`, currentBeat desde la sesión, manager de media con refcount.
- V06-C — IDE MEDIA: cliente de comandos musicales (Next/Previous/cola/Shuffle) sobre contrato T06-A.
- V06-D — IDE BAJA: límites de recursos y pruebas de fuga.
- V06-E — IDE BAJA: casos r4 de I2/Shuffle desde el cliente.

**7. Trabajo de IDE BAJA:** V06-A, V06-D y V06-E. V06-A es procedimiento cerrado: `rg` de `releaseFile`, `revokeObjectURL`, filtros por `liveIds`/presencia en `beats`, `disconnect`, `setTimeout` sin handle, `Map` de promesas; cada aparición con path:línea, dueño actual y dueño propuesto según plan B §6.

**8. Intervenciones de ALTA:** solo si el contrato de versiones/recursos es incompatible (STOP-PLAYBACK) o si T14-B escala STOP-SHUFFLE-PERF. No rediseña Fisher–Yates.

**9. Archivos de entrada:** `src/features/playback/usePlaybackQueue.ts`, `usePlaybackController.ts`, `webVisiblePlaybackPrefetch.ts`, `src/features/state/useBeatRuntimeRegistry.ts`, `src/hooks/useAudio.ts`, `src/platform/webAdapter.ts`, `src/features/artwork/useArtworkHydration.ts`, `src/features/startup/useLibraryReveal.ts`, `src/components/BeatCard.tsx`, `src/app/useBeatGalerComposition.ts`; plan B §6 y referencias V02, V03, V06–V09 de plan B §2; r4 §§2 y 5.

**10. Archivos de salida previstos:** `src/features/playback/catalogPlaybackSession.ts` (plan B §3) y tests; adaptaciones de controller/queue/registry/prefetch en la rama POSTGRES; inventario V06-A en artifacts.

**11. Contratos e invariantes:** currentBeat desde PlaybackSession, no `windowItems.find`; `useAudio` montado en composición estable; ningún `releaseFile` ni revocación por evicción; refcount por consumidor grid/player/editor y liberación solo con refcount 0; cola explícita por identidad/versión sin `filter(liveIds)`; I2: audio sigue al cambiar filtros/sort/columnas, Next/Previous usan resultados vigentes, cola prioritaria en Next/ended, Previous con progress > 0,05 hace seek(0) y no consume cola; currentBeat fuera del query: Next empieza por el primero y Previous por el último; Shuffle sin RNG en cliente (RV2); startup ≤14 referencias; artwork 4 concurrentes, LRU objetivo 32 MiB; teardown explícito en logout/cambio de cuenta.

**12. Orden exacto:**
1. V06-A: inventario completo antes de tocar código.
2. V06-B: sesión y manager de media; mover currentBeat y selección de fuente fuera del grid.
3. V06-B: reemplazar pruning por presencia por eventos autoritativos de T14 (reemplazo/trash/denegación).
4. V06-C: comandos musicales con sequence CAS; consumir sorteos de T14-B; respuesta idempotente reintentable.
5. V06-D: limitar caches/promesas/routing; observers por nodo con registro y retirada; cleanup de timers de BeatCard sin cambio visual.
6. V06-E: casos §13; integrar con V07-B.

**13. Pruebas y fixtures obligatorios:** C12-V-MEDIA; C12-V-RESOURCES (10.000 ciclos mount/unmount con menús/artwork/hover y StrictMode); C12-P01/P02 de T14; play + seek mientras tarjeta y DTO se expulsan; scroll inverso; cambio de cuenta con media en vuelo; cambio de filtros durante reproducción (RV2); query vacío no interrumpe; cola con IDs no cargados.

**14. Resultados esperados:** Player/engine siguen montados; 0 URLs activas revocadas indebidamente; contadores de timers/listeners/observers/blob URLs vuelven a baseline acotado; ninguna fuente de otra cuenta.

**15. PASS objetivo:** PV + §13. La garantía de no repetición por ronda la prueba T14-B en servidor; V06 prueba que el cliente no introduce repetición ni consumo doble.

**16. STOP específicos:** STOP-PLAYBACK ante interrupción por evicción, pérdida de IDs de cola o fuente de otra cuenta; STOP-SHUFFLE si el cliente observa repetición dentro de ronda; STOP-INTEGRITY por doble consumo.

**17. Recuperación segura:** fixture de audio aislada; cleanup mínimo propio; no reiniciar Player por scroll.

**18. Escalamiento:** BAJA → MEDIA; MEDIA → ALTA solo por incompatibilidad de contrato de versiones/recursos.

**19. Autorizaciones:** encargo T14; transporte fake o, si T12 ya lo permite, sandbox autorizado aparte.

**20. Handoff:** a V07-B: API de sesión; a V08: provider de sesión por autoridad; a V09: casos de media en navegador; a V10: contadores de recursos.

## V07 — Selección/edición/drop/facetas

**1. ID y nombre:** V07 — Selección/edición/drop/facetas (T13/T14, V00/V04).

**2. Objetivo concreto:** selección global (I1), edición fuera de ventana, lotes, drop sobre identidad estable, facetas globales estables y renombrado global ACTIVE+TRASH (I3), sin que ninguna acción dependa de los bloques que sigan en cache; sin drag-reorder Web.

**3. Tarea T:** V07-A en T13; V07-B en T14 (N1 §3).

**4. Dependencias y gate de entrada:** V07-A: T12 PASS (entrada de T13), V00 completa, V04, contratos T06 (V02-A) y comandos T07. V07-B: V06. T13 no espera a T14.

**5. Responsable principal y dificultad:** IDE MEDIA; media-alta.

**6. Paquetes:**
- V07-A — IDE MEDIA integra, IDE BAJA implementa casos DOM (T13).
- V07-B — IDE MEDIA integra coexistencia con audio, IDE BAJA casos (T14).

**7. Trabajo de IDE BAJA:** casos DOM parametrizados de §13 con fixtures V01 y oráculo del arnés; componentes de reporte de lote con estados ya definidos por T07.

**8. Intervenciones de ALTA:** ninguna prevista: el contrato viene de V02-A. Si falta una forma, STOP-CONTRACT a ALTA (T06-A), no diseño en UI.

**9. Archivos de entrada:** `src/features/selection/useBeatSelection.ts`, `src/features/tags/useTagRename.ts`, `tagSelectors.ts`, `src/features/design/GALLERY/GalleryChrome.tsx`, `TagNavigation.tsx`, `src/components/Drawer.tsx`, `src/features/edit/webBeatEdit.ts`, `src/features/dragdrop/*`, `src/platform/capabilities.ts`, `src/features/library/useLibraryReorder.ts`; r4 §§2, 4 y 6; plan B §6; contratos V02-A y T07.

**10. Archivos de salida previstos:** `catalogInteractionStore.ts` (plan B §3) y adaptaciones de bulk/drawer/tagRename/GalleryChrome en la rama POSTGRES; tests DOM.

**11. Contratos e invariantes:** Select All = todos los resultados exactos del query/revisión con count; selección individual sobrevive a la evicción; cambiar búsqueda/include/exclude limpia selección y muestra «Selección borrada al cambiar los filtros» solo si el count anterior > 0; sort conserva selección y reinicia solo el ancla Shift; Shift por beatId/ordinal/revisión; revisión externa deja selección en conflicto y deshabilita comandos; bulk en lotes ≤50 con reporte total/confirmados/no ejecutados/conflicto/cancelados y COMPLETED solo si todo confirmado; un editor activo con draft dirty y versión de origen, 409 conserva texto; drop captura beatId/version al inicio y cancela si el target se desmonta; facetas ACTIVE globales estables durante scroll, activos aunque no estén en el bloque; rename sobre ACTIVE y TRASH sin cambiar status/fechas/referencias ni bytes; `manualLibraryReorder` Web = false y ningún SortableContext con todos los IDs.

**12. Orden exacto:**
1. V07-A: InteractionStore por cuenta con token/count/flags de servidor (RV4).
2. V07-A: Select All/individual/Shift/deseleccionar todo/aviso condicional/sort.
3. V07-A: editor y returnAnchor; bulk desde Drawer con reporte por lote.
4. V07-A: drop por identidad estable; facetas desde T06 + cache V04-C en GalleryChrome sin cambio visual.
5. V07-A: rename preview (counts ACTIVE/TRASH) → confirmación → operación durable → progreso; nunca bucle en navegador.
6. V07-B: con audio activo y evicción, repetir casos de selección/edición/drop/rename; teardown por cuenta.

**13. Pruebas y fixtures obligatorios:** C12-V-INTERACTION; casos T13 (conflicto preserva draft, retry misma operación, reload, cuenta, cuota, stale bloquea, operación evictada no se pierde, rename parcial nunca éxito total); casos r4 §4 (respuesta perdida, cancelación, conflicto después del lote 2, excepciones, Shift remoto); capability reorder false.

**14. Resultados esperados:** IDs/versión correctos fuera de ventana; ninguna acción global procesa solo `windowItems`; aviso solo cuando había selección; status TRASH intacto tras rename; `get_index`/`replace_index` = 0 en POSTGRES.

**15. PASS objetivo:** V07-A PASS cierra la parte de T13; V07 completa requiere V07-B PASS en T14. V08 exige V07 completa.

**16. STOP específicos:** STOP-INTERACTION(-SELECTION/-TAGS) si el comportamiento difiere de r4; STOP-CONTRACT si falta manifest; STOP-INTEGRITY por selección parcial presentada como completa o estado TRASH alterado; STOP-UX si un test requiere eliminar una capacidad.

**17. Recuperación segura:** reproducir con oráculo del arnés; no sustituir selección global por ventana.

**18. Escalamiento:** BAJA → MEDIA (wiring); MEDIA → ALTA (contrato ausente); usuario solo por conducta nueva.

**19. Autorizaciones:** encargos T13 y T14.

**20. Handoff:** a V08: InteractionStore y API; a V09: casos de foco/lector de selección, aviso y conflictos; a V10: coste de preparación de selección global para medir.

## V08 — Integrar composición por autoridad

**1. ID y nombre:** V08 — Integrar composición por autoridad (T16, V05/V06/V07 y T15).

**2. Objetivo concreto:** LEGACY conserva su ruta actual; POSTGRES usa catálogo y Gallery virtualizada; autoridad desconocida falla cerrada; ningún error activa fallback silencioso a INDEX.

**3. Tarea T:** T16.

**4. Dependencias y gate de entrada:** T15 PASS; V05, V06 y V07 completas.

**5. Responsable principal y dificultad:** IDE MEDIA; media-alta.

**6. Paquetes:**
- V08-A — IDE MEDIA: providers LEGACY/POSTGRES con API común para AppShell.
- V08-B — IDE BAJA: spies y regresión LEGACY.
- V08-C — IDE MEDIA: verificación de cobertura y manifiesto de casos y comandos para V09.

**7. Trabajo de IDE BAJA:** V08-B: spies de todas las rutas y auth, regresiones LEGACY con runner auditado, búsqueda de nuevas entradas en el consumer-map.

**8. Intervenciones de ALTA:** solo si no existe frontera segura para separar providers (STOP-INTEGRITY sin punto de cercado).

**9. Archivos de entrada:** `src/app/AppShell.tsx`, `WebGalleryWorkspace.tsx`, `WebExperience.tsx`, `useBeatGalerComposition.ts`, `src/features/library/useLibraryState.ts`, `useLibraryReload.ts`, `libraryPresentationCache.ts`, `librarySelectors.ts`; consumer-map T01/T16; salidas V05–V07.

**10. Archivos de salida previstos:** providers/componentes de composición por autoridad (nombres fijados por V08-A en handoff); tests de composición; manifiesto V09.

**11. Contratos e invariantes:** hooks estables por provider (no hooks condicionales en el mismo componente); cambio de autoridad = remontaje controlado tras invalidación; en POSTGRES excluidos selector local, cache global de beats, reload/reconcile INDEX y pager; flags apagados por defecto; contexto unknown no monta camino LEGACY; auth/lazy y rutas conservadas; no tocar main/DESIGN ni reemplazar Playbar.

**12. Orden exacto:**
1. V08-A: extraer API común; provider LEGACY con el comportamiento actual intacto.
2. V08-A: provider POSTGRES con V05–V07; WebGalleryWorkspace monta pager solo en LEGACY.
3. V08-A: estado unknown → carga/error, nunca LEGACY.
4. V08-B: spies y regresiones; Direct desconectado no bloquea metadata.
5. V08-C: revisar cobertura y entregar manifiesto V09 con casos, navegadores, viewports y comandos existentes.

**13. Pruebas y fixtures obligatorios:** dos bibliotecas LEGACY/POSTGRES en el mismo arnés; spies de rutas y auth; regresión LEGACY; C12-V-AUTH y C12-V-LEGACY a nivel de composición; reinicio cloud/worker y Telegram caído (casos T16).

**14. Resultados esperados:** cero recuperación INDEX en POSTGRES; LEGACY sin regresión; unknown fail-closed.

**15. PASS objetivo:** PV + §13 y manifiesto V09 aprobado por MEDIA. El dictamen G3 es de T16, no de V08.

**16. STOP específicos:** STOP-INTEGRITY si autoridad/contexto unknown activa camino LEGACY o una ruta queda sin fence; STOP-CONTRACT por provider mezclado; STOP-UX por función perdida.

**17. Recuperación segura:** volver a flags apagados del arnés; no tocar producción.

**18. Escalamiento:** BAJA → MEDIA; MEDIA → ALTA solo por ausencia de frontera segura.

**19. Autorizaciones:** encargo T16; sin despliegue.

**20. Handoff:** a V09: manifiesto; a T16: matriz de providers y spies; consumer-map actualizado.

## V09 — Regresión navegador/accesibilidad

**1. ID y nombre:** V09 — Regresión navegador/accesibilidad (T16/T21, V08).

**2. Objetivo concreto:** ejecutar en navegadores reales los casos de plan B §9 aplicables a UI (todos menos C12-V-PERF) y las pruebas r4 de T16/V08–V09, con teclado, foco, lector de pantalla, scroll, responsive y comparación visual contra LOCAL.

**3. Tarea T:** ejecución en T16; T21 consume la evidencia y repite lo afectado según el manifiesto del candidato (N1 §3).

**4. Dependencias y gate de entrada:** V08 cerrada en fixture y manifiesto V08-C.

**5. Responsable principal y dificultad:** IDE BAJA; media de ejecución.

**6. Paquetes:**
- V09-A — IDE BAJA: preparar y registrar entorno.
- V09-B — IDE BAJA: ejecutar casos y recoger evidencia.
- V09-C — IDE MEDIA: diagnosticar fallos multicomponente (solo si hay STOP-TEST/UX).

**7. Trabajo de IDE BAJA:** V09-A y V09-B completos; correcciones R (fixture mal conectada, selector de test, cleanup) con causa demostrada.

**8. Intervenciones de ALTA:** ninguna prevista.

**9. Archivos de entrada:** manifiesto V08-C; plan B §§7 y 9; r4 §§2 y 7; capturas de referencia LOCAL tomadas con el mismo SHA de CSS/DESIGN (no de main).

**10. Archivos de salida previstos:** capturas, logs, contadores y tabla de resultados en artifacts; informe V09.

**11. Contratos e invariantes:** sin suites reales ni sesiones autenticadas reales; capturas comparadas con LOCAL; lector de pantalla real (jsdom no valida accesibilidad); copy exacto de r4 (RV1 y aviso de selección).

**12. Orden exacto:**
1. V09-A: registrar navegador exacto/flags/UA, SO, CPU/RAM/GPU, refresco, DPR, viewport, zoom, fuentes, headful/headless y red (plan B §9), y el lector de pantalla disponible.
2. V09-A: Chrome y Edge; anchos 375/768/1440 y breakpoints ±1 px; zoom 100 %/200 %; touch donde exista; reduced-motion.
3. V09-B: C12-V-GEOM, SCROLL, BORDER, FOCUS, MEDIA, RESOURCES, INTERACTION, QUERY, AUTH y LEGACY.
4. V09-B: r4 T16/V08–V09: preparación de conjunto (estado y cancelación), aviso condicional de selección, conflictos y vuelta atrás.
5. V09-B: regresión de pruebas originales pertinentes auditadas.
6. V09-B: consolidar 0 skips obligatorios o STOP.

**13. Pruebas y fixtures obligatorios:** las 10 filas de §12 paso 3, las del paso 4 y las regresiones auditadas; fixtures V01.

**14. Resultados esperados:** foco nunca cae en body; Tab/Shift+Tab, PageUp/PageDown, Home/End, Escape de menú y retorno de detalle según plan B §7; geometría y UI iguales a LOCAL; copy exacto r4.

**15. PASS objetivo:** todos los casos, 0 skips obligatorios, capturas y contadores adjuntos (plan B §8 V09).

**16. STOP específicos:** STOP-UX si se pierde una interacción o lectura accesible; STOP-ENV si falta navegador o lector de pantalla (no sustituir por jsdom); STOP-TEST por fallo sin causa demostrada.

**17. Recuperación segura:** repetir caso con el mismo manifiesto; no cambiar umbrales ni capturas de referencia.

**18. Escalamiento:** BAJA → MEDIA (V09-C) por fallo multicomponente; MEDIA → ALTA solo si revela contrato insoluble.

**19. Autorizaciones:** encargo T16; navegadores locales aislados.

**20. Handoff:** a T16 (G3 por MEDIA): resultados; a V10: manifiesto de navegador; a T21/V11: evidencia con hashes y lista de casos a repetir si cambia código afectado.

## V10 — Capacidad y leak soak

**1. ID y nombre:** V10 — Capacidad y leak soak (T20, V09 y T19).

**2. Objetivo concreto:** medir con datos reales servidor + navegador a 100.000 y 1.000.000 beats sintéticos: memoria, DOM, red, scroll, concurrencia, imágenes, preparación de Shuffle y selección global, sin cifras estimadas.

**3. Tarea T:** T20.

**4. Dependencias y gate de entrada:** T19 PASS; V09 PASS; perfil C11-LAB-v1 disponible con recursos de C12-DECISION-RECORD §7 (8 vCPU, 16 GiB, SSD ≥100 GiB libres y cuotas por proceso).

**5. Responsable principal y dificultad:** IDE BAJA; media de medición.

**6. Paquetes:**
- V10-A — IDE BAJA: manifiesto de perfil y datasets.
- V10-B — IDE BAJA: campañas y cálculo de series.
- V10-C — IDE MEDIA: verificación de metodología y, si falla, un ajuste por cambio con remedición comparable.

**7. Trabajo de IDE BAJA:** V10-A y V10-B completos: los procedimientos y umbrales están fijados en r2 §7, plan B §9 y r4 §5.

**8. Intervenciones de ALTA:** solo STOP-SHUFFLE-PERF (preparación/disco/WAL/reconstrucciones incumplen) o si la corrección exige nueva arquitectura o los writers impiden READY (N1 §5).

**9. Archivos de entrada:** C12-DECISION-RECORD §7; plan B §9; r4 §§3 y 5; generador V01; manifiesto V09; futuro `scripts/catalog-benchmark.cjs` (matriz T T20).

**10. Archivos de salida previstos:** reporte por perfil con series crudas, percentiles, traces, EXPLAIN, heap/RSS/DOM/disco/WAL y hashes en artifacts.

**11. Contratos e invariantes:** dataset servidor: 1000×100, 1000×1000 (1.000.000 total) y 1×100.000, semilla 777; fixture UI 1×1M solo como stress, no cuota; el cliente de prueba nunca carga N IDs; recorrido completo en orden y reversa con count + digest incremental; frío y caliente separados; warmup 2 min + muestra 10 min; 20 clientes metadata y 2 transferencias fake; ningún outlier descartado; errores/timeouts no cuentan como respuestas rápidas.

**12. Orden exacto:**
1. V10-A: verificar recursos/digest/config del perfil; registrar índices, membresía, disco, WAL y rebuild ICU por separado.
2. V10-B: servidor: todas las queries/filtros/count/legacy/deep/contención de r2 §7.
3. V10-B: navegador: recorrido completo y vuelta atrás a 100k y 1M; salto al último bloque; volver de detalle con cache fría; red 50/250/1000 ms; artwork 2 s y error; respuestas invertidas; fallos 500.
4. V10-B: soak ≥20 min con backtracking; picos antes de GC y tendencia tras GC controlado.
5. V10-B: Shuffle y conjuntos: preparación fría/caliente, p95 de sorteos, coste de disco/WAL por miembro/ronda, ronda completa 100k/1M; selección global y facetas; limpieza ≤240 filas por transacción; escritores concurrentes.
6. V10-C: revisar metodología; si hay fallo, un cambio por vez y remedición comparable.

**13. Pruebas y fixtures obligatorios:** C12-V-PERF; C12-X01 (T20); r4 §5 y §7 fila T20/V10.

**14. Resultados esperados (umbrales fijados, no resultados):** API metadata p95 ≤250 ms / p99 ≤1 s; PATCH p95 ≤250 ms; respuesta ≤2 MiB; incremento de memoria primera página 1M frente 100k ≤20 MiB; mismo techo de bloques/DOM a 100k y 1M; heap/RSS de estado estable atribuible a N ≤20 MiB; frames p95 ≤16,7 ms y p99 ≤50 ms a 60 Hz sin tareas >200 ms repetidas; artwork cache propia ≤32 MiB; 0 SQL retenido esperando red y 0 llamadas Telegram para metadata.

**15. PASS objetivo:** solo métricas reales que cumplen todos los perfiles obligatorios, sin skips. PV.

**16. STOP específicos:** STOP-PERF/BUDGET ante leak, pendiente de memoria, pausas o carga ilimitada; STOP-SHUFFLE-PERF; STOP-ENV si falta hardware o el descriptor está incompleto.

**17. Recuperación segura:** conservar crudos; repetir con mismas condiciones. Prohibido bajar dataset, aumentar budgets/RAM, desactivar artwork, excluir outliers o medir con un script puro sin navegador.

**18. Escalamiento:** BAJA → MEDIA (fuga/índice demostrado); MEDIA → ALTA (nueva estrategia o STOP-SHUFFLE-PERF); usuario solo para nuevos recursos.

**19. Autorizaciones:** encargo T20 y host de laboratorio identificado; no comprar ni desplegar recursos desde este documento.

**20. Handoff:** a T20 (G4 por MEDIA) y a V11/T21: reporte por perfil, primer target frío/caliente, coste O(N) de disco explícito y lista de incumplimientos sin rebaja.

## V11 — Candidato y migración

**1. ID y nombre:** V11 — Candidato y migración (T21→T23, V10 y G0–G4).

**2. Objetivo concreto:** consolidar evidencias, flags, compatibilidad LEGACY, rollback con escrituras, puertas y permisos para un candidato y para la preparación del piloto, sin que un PASS de laboratorio autorice acceso a una biblioteca real.

**3. Tarea T:** T21 (V11-A), T22 (V11-B), T23 (V11-C).

**4. Dependencias y gate de entrada:** V11-A: V10, G1 sintético, G2 real en sandbox, G3 y evidencia G4 de laboratorio representativo (no depende de T22). V11-B: T21 + permiso de captura/import de biblioteca concreta. V11-C: T22 + G0–G4 + permiso de corte.

**5. Responsable principal y dificultad:** IDE MEDIA coordina; media-alta operativa.

**6. Paquetes:**
- V11-A — IDE BAJA empaqueta y ejecuta comprobaciones (T21-A); revisión crítica **T21-B por IDE ALTA**; correcciones delimitadas por MEDIA (T21-C).
- V11-B — IDE BAJA ejecuta M1–M2 autorizados; IDE MEDIA emite G1 real (T22).
- V11-C — IDE MEDIA ejecuta piloto y diagnóstico; IDE BAJA observación (T23).

**7. Trabajo de IDE BAJA:** índice de evidencias G0–G4 con hashes y alcance; C(all-local), `npm run test:typecheck`, `npm run build:web`, `git diff --check`; regresiones afectadas y V09 según manifiesto; comprobación de que la CLI T17/T18 valida perfil, rutas y guardas vigentes; observación/métricas en T23.

**8. Intervenciones de ALTA:** únicamente T21-B: revisar contrato, mapa, esquema, fallos, aislamiento, rollback y Shuffle del candidato concreto y emitir GO/NO-GO técnico por puerta. No repetir toda la ejecución de tests.

**9. Archivos de entrada:** paquete T21; ESTADO/EVIDENCIA; MIGRACION M0–M6, R1–R3 e informe de puerta; reportes V09/V10; G1–G4; CLI T17 y ensayo T18.

**10. Archivos de salida previstos:** paquete candidato (SHA, hash de dirty si no hay commit, migraciones, flags, versiones puente, manifiestos, CLI/runbooks, diferencias respecto del desplegado observado); informe G1 real por biblioteca (T22); informe piloto (T23).

**11. Contratos e invariantes:** PASS de documentos o de laboratorio no autoriza deploy, DB, Telegram ni AWS; cada fase requiere permiso independiente identificado (entorno/biblioteca/operación); B-legacy de r4 implementado y probado; rollback con escrituras (T18) y restore (T19) presentes; fencing G2 real; ningún G1 sintético habilita biblioteca real.

**12. Orden exacto:**
1. V11-A: BAJA arma índice de evidencias desde artefactos primarios, no desde resúmenes.
2. V11-A: BAJA ejecuta comprobaciones del candidato.
3. V11-A: ALTA T21-B revisa y dictamina; MEDIA corrige hallazgos; BAJA repite afectados; un contrato cambiado reabre su gate.
4. V11-A: si falta permiso → STOP-APPROVAL con paquete listo.
5. V11-B: con permiso, sombra M1–M2 y G1 real de esa biblioteca.
6. V11-C: con permiso, piloto M3–M5 y observación según manifiesto (ventana fijada antes de empezar, no se reduce durante la ejecución).

**13. Pruebas y fixtures obligatorios:** todas las suites requeridas por T21; regresión V09 afectada; checks M1–M5 reales autorizados; smoke autorizado.

**14. Resultados esperados:** GO/NO-GO por puerta con hallazgos críticos cerrados; G1 real de la biblioteca concreta; una sola autoridad, reversión actual disponible y cero alertas de integridad en observación.

**15. PASS objetivo:** V11-A PASS = paquete completo + dictamen T21-B sin críticos abiertos; V11-B y V11-C según T22/T23. Ninguno concede permisos.

**16. STOP específicos:** STOP-APPROVAL ante cualquier paso real sin permiso; STOP si faltan restores o fencing; STOP-INTEGRITY/TRANSPORT en sombra o piloto; STOP-GATE si un gate se apoya en evidencia no primaria.

**17. Recuperación segura:** contención solo autorizada y con precondiciones MIGRACION; nunca rollback a snapshot viejo ni limpieza automática.

**18. Escalamiento:** BAJA → MEDIA (fallo de test/runbook); MEDIA → ALTA (riesgo irreversible, estrategia nueva); usuario para cada permiso.

**19. Autorizaciones:** T21 sin operación real; T22 permiso puente/expansión y captura/import de biblioteca específica; T23 permiso de corte por user/vault/era/epoch.

**20. Handoff:** a T22: comandos existentes con target/efecto/contención y permisos faltantes; a T23: G1 real, manifest/hash/era/epoch; a T24: informe piloto y capacidad de rollback.

## 4. Cobertura y criterios de uso de esta matriz

- IDs: 12 fichas (V00–V11), cada una con una o varias T padre existentes: V00→T00,T01; V01→T01,T02; V02→T06; V03–V05→T08; V06→T14; V07→T13,T14; V08→T16; V09→T16 (T21 consume); V10→T20; V11→T21,T22,T23.
- Gates: G0 (V00-A), G1 (V00-B/V01 vía T01/T04; V11-B real), G2 (consumido por V11-A), G3 (V08/V09 vía T16), G4 (V10 vía T20; consumido por V11-A).
- Para ejecutar una V se usan: su ficha de plan B §8, esta ficha y la ficha T padre de la matriz T. Para repartir trabajo entre niveles se usa N1 §§2 y 5–8.
- Esta matriz no reduce pruebas ni STOP de plan B, r4, TAREAS o la matriz T; donde haya diferencia, prevalece el orden normativo de N1 §1 y de §2 de esta matriz.
