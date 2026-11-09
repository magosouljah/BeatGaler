# Ejecución por nivel de inteligencia — N1

Fecha: 2026-11-07. Ampliación documental del plan existente, sobre HEAD `a4462191aea29ffdae136f04e1fdc2e4024291d1`, rama `local/landing-gallery-unificada`. **No ejecuta T00, T01 ni T02, no emite PASS de tareas/gates y no autoriza implementación ni operaciones reales.**

## 1. Autoridad y uso

Leer [ESTADO](ESTADO.md), [CONTRATO](CONTRATO.md), [TAREAS](TAREAS.md), [MIGRACION](MIGRACION.md), [C12-r4](C12-V00-CIERRE-20261107.md) y la ficha asignada de [matriz T](MATRIZ-T-NIVELES-20261107.md) o [matriz V](MATRIZ-V-NIVELES-20261107.md). Las fichas amplían los pasos originales; no los sustituyen por un resumen. C12-r4 prevalece en producto/diseño sobre r2/r3. N1 prevalece exclusivamente en reparto de trabajo, escalamiento y descomposición de dependencias descritos aquí. Conserva todos los criterios técnicos originales, salvo instrucciones expresamente superadas por r4.

**Una tarea por encargo.** Los paquetes A/B/C de las matrices son entregas secuenciales dentro de su T/V; no son tareas T nuevas ni autorización para agentes paralelos. Un paquete parcial no permite declarar PASS al padre. Responsable principal significa quien integra y responde por el cierre; no significa que haga todos los pasos ni que supervise cada edición. IDE BAJA ejecuta los paquetes mecánicos cerrados, incluso en tareas cuyo principal es MEDIA/ALTA.

Los cuatro niveles son roles de ejecución definidos por el usuario, no nombres de modelos que se deban instalar/configurar. Chat normal = GPT-6 Sol, sin presumir acceso a Windows. Las revisiones de Sol se entregan como dictamen sobre evidencias; una IDE registra los resultados locales. No duplicar un dictamen de Sol con ALTA por rutina.

## 2. Distribución y secuencia recomendada

| Unidad contada | Chat normal | IDE BAJA | IDE MEDIA | IDE ALTA | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| T principales, propietario de cierre | 0 | 8 | 16 | 2 | 26 |
| V, subdivisiones ya incluidas en T | 1 | 3 | 8 | 0 | 12 |

T de BAJA: T00, T01, T04, T18, T20, T22, T24, T25. T de ALTA: T11 y T21. Las otras 16 T son de MEDIA. V de Chat: V00; de BAJA: V01, V09, V10; de MEDIA: V02–V08 y V11. **No sumar 26+12 como 38 implementaciones independientes**, ni contar paquetes de revisión como tareas nuevas. No se estima ahorro monetario/horas sin datos de ejecución.

La mayoría de las T aún requieren integración de varias capas: etiquetarlas BAJA completas ocultaría decisiones. El ahorro se obtiene asignando a BAJA los fixtures, casos negativos, adaptadores fijados, ejecución de ensayos, informes y cierre mecánico; MEDIA posee las integraciones delimitadas. ALTA interviene en cuatro lugares previstos, sin vigilancia continua: contrato ejecutable nuevo de T01-B, contratos nuevos de T06-A/V02-A, investigación de proveedor T11 y revisión crítica final T21-B. El diseño de Shuffle ya está elegido; no se vuelve a diseñar por defecto en T14.

Flujo:

1. Autorizar una revisión formal T00/G0: BAJA prepara base y evidencias; Sol contrasta requisitos y emite dictamen técnico si están demostrados. Si falta smoke u otra evidencia requerida, se registra pendiente; no se sustituye por el baseline histórico. T01 necesita autorización posterior.
2. T01: BAJA inventaría; ALTA cierra solo vacíos de esquema/invariantes r4 que el mapa haga concretos; BAJA completa mapa y fixtures. T02 MEDIA construye seguridad del arnés, BAJA verifica ataques negativos. T03 MEDIA implementa restricciones; T04 BAJA codec conforme al mapa cerrado.
3. T05–T10: MEDIA integra; T06-A recibe una intervención ALTA para contratos nuevos r4 antes de sus consumidores. BAJA ejecuta paquetes cerrados de pruebas y reportes. V01 en T01/T02; V02 en T06; V03–V05 en T08, solo fixture.
4. T11 ALTA investiga proveedor real únicamente en sandbox autorizado. Sin ese permiso entrega paquete de experimento y STOP-APPROVAL. T12 no hereda permiso; trabajo limitado a mocks necesita encargo explícito, no salta T11 PASS.
5. T12–T17 MEDIA: transferencias, clientes, playback/Shuffle, purge, integración y CLI. V07-A cierra en T13, V06 y V07-B en T14, V08/V09 en T16. BAJA implementa casos/ejecuta verificaciones ya fijadas.
6. T18 BAJA ensaya rollback; T19 MEDIA implementa/integra restore; T20 BAJA mide y produce expediente. Fallo de rendimiento no eleva automáticamente toda T20 a ALTA.
7. T21: BAJA empaqueta, ALTA hace una revisión crítica acotada. G1–G4 tienen dictámenes propios; ALTA no repite todas las suites. T22 BAJA opera sombra autorizada, T23 MEDIA ejecuta piloto, T24/T25 BAJA ejecutan runbooks cerrados con permisos independientes.

Ruta crítica: T01/T06 contratos → T11 cercado real → T14 garantías Shuffle → T15/T18/T19 integridad y recuperación → T20 capacidad → T21 candidato → autorizaciones reales. No se cambia el orden principal T00→T25. Se reduce espera preparando en cada tarea el contrato y los casos de su sucesora; no se implementa la sucesora sin encargo.

## 3. Dependencias y contradicciones reconciliadas

| Evidencia del plan | Tratamiento normativo N1 | Comprobación / bloqueo restante |
| --- | --- | --- |
| LOCAL-BASELINE §4 pide mapa exhaustivo en G0, pero T01 lo produce | G0 valida contrato C4, alcance y obligación del mapa; mapa completo es salida T01 y entrada G1, no precondición circular de G0 | G0 no certifica inventario que todavía no existe; STOP-GATE si se exige tal certificación |
| G0 antiguo exige DB/arnés antes de T01; G0-AUDITORIA y TAREAS ya lo corrigen | G0 descriptor; T01 inventario; T02 guardas y DB efímera | Probe destruido no es DB disponible ni arnés T02 |
| T08 paso 2 dice UI anterior/siguiente; plan B y r4 prohíben pager POSTGRES | Botones siguen solo LEGACY; POSTGRES V03–V05 es fixture continua; activación en T16 | STOP-UX si se conecta pager o se activa T08 antes de V06–V09 |
| V00 encabezado asigna ALTA y contiene diseño T00 + inventario T01 | V00-A Sol verifica decisiones ya aprobadas en T00; V00-B BAJA clasifica consumidores dentro de T01; vacíos técnicos T01-B a ALTA | No depender de V00 completo para abrir T01: solo V00-A; no pedir aprobar A1/A2/I1–I3 otra vez |
| V01 pertenece T01→T02 | V01-A fixtures sin DB en T01; V01-B arnés ejecutable en T02 | T01 no depende del PASS de V01-B |
| V07 pertenece T13/T14 y V06 depende T13 | V07-A selección/editor/drop/facetas cierra T13; V07-B coexistencia con audio cierra T14 después de V06 | T13 no espera T14; V07 completo no es requisito de T13, sí de V08 |
| V09 figura T16/T21 y V10 antes T21 | V09 ejecución en T16; T21 consume evidencia y repite regresión afectada/candidato según manifiesto | Sin arista T20→T21→T20 |
| V11 figura T21→T23 tras G0–G4; G1 real aparece T22 | V11-A candidato consume G1 sintético y G2 real/G3/G4 de laboratorio representativo; V11-B adjunta G1 de biblioteca T22; V11-C exige todos para T23 | T21 no depende de T22; ningún ensayo local satisface G1 de biblioteca real |
| r4 requiere workers de membresía/bulk T06/T07; worker durable general es T10 | T06/T07 implementan transiciones y pasos de lote invocables bajo runner, sin iniciar servicio; T10 conecta scheduling/lease/recovery a esos pasos | No importar un worker futuro ni declarar jobs operativos en T06. Contrato de claim/checkpoint se cierra T01-B/T06-A; T10 verifica recuperación integral |
| T03 antecedente crea tablas; r4 añade membresías/rondas/journal | T01-B entrega mapa de DDL por fase: T03 base/membresía/facetas, T07 selección/bulk/events, T09/10 jobs/operaciones, T14 estado/ejecutor musical conforme contrato | Si una FK requiere tabla posterior, cerrar orden aditivo en T01-B; no introducir FK rota ni cambiar checksums. Solo estructura necesaria en cada fase |
| CONTRATO C5 cuenta opcional; r2 §4.1 exige total exacto de Gallery | Gallery pide includeTotal; count filtrado se mide, no se oculta | T06 cuenta coherente con snapshot; T20 mide frío |
| CONTRATO C3 conserva bpm_sort numeric, C6 no rename global; r4 modifica ambos | Proyección clase/binary64 separada de raw; rename metadata ACTIVE/TRASH con estado intacto, sin Desktop | No editar datos para hacerlos ajustarse al esquema antiguo |
| TAREAS/README mandan escalar todo STOP a alta capacidad | Aplicar §5, conservando el STOP y su evidencia | BAJA no cambia expectativas ni decide arquitectura; MEDIA resuelve integración; producto/operación al usuario |
| Runner T00 exige árbol tracked limpio; hoy hay docs locales modificados | No ejecutar el runner a ciegas ni quitar su guarda. Próximo encargo T00 prepara copia aislada verificable del estado autorizado y registra diferencias, o solicita encargo acotado para ajustar guard documental | No commit/stash/reset implícitos. Si no se acredita identidad de código/tests/runner, STOP-BASE; no atribuir 68/68 al checkout actual |
| Copy legacy no resoluble distinto en C12-DECISION-RECORD §5.2 paso 7 y r4 §2 (RV1 de [matriz V](MATRIZ-V-NIVELES-20261107.md) §2) | Texto visible y acción salen solo de r4 §2; código y algoritmo r2 §5.2 se conservan | V02-C y V09 C12-V-LEGACY comparan cadena exacta r4 |
| Plan B §6 recomienda fijar query musical al Play y sampler SQL; r4 I2/§5 lo sustituye (RV2) | V06 aplica I2 y consume Fisher–Yates persistido de T14-B; sin RNG en cliente | V06-E: filtro cambiado durante reproducción, Next sobre nuevo query |
| Raíz de módulos cliente: TAREAS T08 `src/features/catalog/*` vs plan B §3 `src/features/library/catalog/`; ninguna existe (RV3) | V03-A (MEDIA) fija una sola raíz en handoff antes de que BAJA cree archivos | Al cerrar V05, una sola raíz de cliente catálogo en `rg --files src` |
| r4 §7 pide flags de selección en stores de ventana; plan B V04 prohíbe selección en el store (RV4) | Store de ventana transporta solo flag `selected`+`selectionVersion` del DTO; token/count/CAS en InteractionStore V07-A; facetas en cache acotado separado V04-C | V04-B: evicción no altera count/token; V07-A: seleccionado evictado sigue seleccionado |
| Citas «A1/A2 pendientes» y fila r3 V00 «Decisiones pendientes» (RV5) | Satisfechas por r4 §1 a nivel de decisión; siguen exigidas dependencias técnicas y permisos | V00-A tabla D→C y checklist V11-A |

Estas divisiones no suprimen criterios de los padres. Cualquier dependencia adicional descubierta se registra con productor, consumidor, artefacto y gate; si crea ciclo no continuar hasta separar contrato, implementación y activación. No convertir la necesidad de un endpoint futuro en permiso para inventarlo en UI.

## 4. Gates: preparación, comprobación, dictamen y permiso

La columna «dictamen» emite PASS técnico **solo sobre alcance/evidencia explícitos**. BAJA comprueba existencia, hashes, cobertura y resultados; no basta leer la palabra PASS en otro documento. Revisor verifica procedencia, SHA, perfil, casos negativos y límites. Registrar `NO-GO` si falta cualquiera. Ningún nivel concede autorización humana de datos/servicios.

| Gate real | Prepara / verifica mecánicamente | Juicio y dictamen técnico | Evidencia indispensable | Autorización y salida |
| --- | --- | --- | --- | --- |
| G0 Base y contrato | BAJA T00: Git, instrucciones, baseline, descriptor, trazabilidad r4 y smoke exigido | Sol: congruencia de contrato/base y cobertura; MEDIA investiga un fallo local moderado; ALTA solo contradicción arquitectónica nueva | SHA/diff preservado, suites whitelist con logs/0 skips y alcance, descriptor G0 probado, aprobaciones r4, baseline funcional requerido o falta explícita; perfil C11 fijado | G0 no abre T01 sin encargo. No certifica SQL, ICU ni proveedor. Estado actual NO APROBADO |
| G1 Datos | BAJA T01/T04; BAJA T22 para biblioteca autorizada | MEDIA coteja mapa/codec y lector independiente, emite G1 sintético o G1 real identificado | Cada JSON path/ref/estado/caller con destino/fixture; roundtrip profundo, delta SQL-only explícito, límites, inválidos bloqueados; real: snapshot final verificable/hash/ledger/pin | G1 sintético no habilita biblioteca real. Captura/import de biblioteca requiere permiso específico, M2 y nuevo snapshot M4 |
| G2 Transporte | MEDIA arma harness según experimento ALTA T11; BAJA recoge logs en sandbox autorizado | ALTA T11: incertidumbre SDK y alcance físico de credenciales, dictamen una vez por combinación probada | Versiones/locks, send aceptado/respuesta perdida, reconnect/random_id/receipts, Direct y MASTER PROJECT, auth key vieja y mensajes propios/ajenos, fencing real sin secretos | Mocks no pasan G2. Usuario autoriza sandbox; cambio de identidad/revocación/bots reales necesita permiso separado y ensayo previo |
| G3 Integridad | BAJA consolida T05–T16, MEDIA verifica matrices/rutas y fallos | MEDIA emite dictamen basado en concurrencia real aislada y cercado completo; Sol puede revisar la trazabilidad sin duplicar ejecución | Dos conexiones/procesos, tenant/era/version, idempotencia/crash, cuotas/locks, 0 cliente SQL retenido en espera remota, startup/legacy/unknown fail-closed, V08/V09, consumer-map actualizado | Acredita candidato y entorno declarados, no revoca sesiones físicas ni autoriza corte. G2 sigue separado |
| G4 Operación | BAJA ensayos T18/T20 y reportes; MEDIA T19/CLI runbook | MEDIA emite dictamen con restore/rollback/rendimiento y límites de cobertura; ALTA solo daños, estrategia de recuperación nueva o STOP-SHUFFLE-PERF | Export actual tras escrituras, restore previo a purge/journal/era, hashes/partes/backups y RPO≤5min/RTO≤60min medidos, retención coherente, C11 y V10 completos, CLI ensayada, contención | G4 local se etiqueta como tal. G4 para real exige entorno representativo demostrado y permisos de operación; T21 no sustituye aprobación por biblioteca. Retirar restore_hold/cleanup/ventana reversible se autoriza aparte |

Cada gate incluye smoke de Landing/Gallery/Playbar aplicable conforme LOCAL-BASELINE/MIGRACION. Reusar artefacto idéntico por SHA de código, tests, lockfiles, config y entorno con justificación de no impacto; **si el gate exige ejecución nueva, se ejecuta**. No trasladar evidencia fake a proveedor ni generalizar muestra real a todas las bibliotecas. T21 mantiene `all-local`, typecheck y build del candidato: no se elimina para ahorrar.

## 5. Protocolo STOP y recuperación

Expediente mínimo **E** para cualquier STOP: tarea/paquete/paso; fuente C/M/r4; esperado/observado; fixture y hash; SHA+diff+descriptor sin secretos; comando exacto y exit; logs/trace; resultado durable último conocido; efectos externos en vuelo o ninguno; hipótesis separadas de hechos; acciones seguras ya realizadas; decisión concreta y siguiente responsable. Adjuntar coverage de pruebas pendientes, sin editar esperados para pasar.

Clasificación común **R**: BAJA puede resolver typo, import/ruta equivocada dentro del alcance, fixture mal conectada respecto de contrato cerrado o cleanup de test con causa demostrada; hace corrección mínima y repite casos afectados. No eleva por una única aserción roja. MEDIA recibe errores de integración/carreras locales con contrato cerrado. ALTA recibe contradicción de invariantes, diseño ausente, fracaso de estrategia o riesgo irreversible sin procedimiento. Usuario decide producto y permisos reales. Al emitir STOP no inicia otra tarea; diagnóstico read-only permitido no equivale a reanudar efectos.

| STOP (incluye variantes) | Diagnóstico adicional a E | Acciones seguras permitidas | Destino / condición para retomar |
| --- | --- | --- | --- |
| STOP-BASE | Base observada vs autorizada, paths/diff y ancestros | Leer/comparar/copiar a destino nuevo; preservar dirty/untracked | MEDIA si simple reconciliación documental verificable; ALTA si rebase del plan altera arquitectura. Reanudar con base explícita e impacto revisado |
| STOP-GATE | Requisito faltante, gate productor, evidencia que se intentó usar | Completar checklist y paquete, no simular test | Revisor del gate §4; usuario si falta encargo. Solo dictamen y autorización abren paso |
| STOP-ENV | Host/puerto/rol/marker/digest esperados vs descriptor seguro (sin credenciales) | Inspección de config; probar rechazo con dobles, cero escrituras al destino dudoso | MEDIA para guard/arnés; usuario para asignar entorno. Revalidar aislamiento antes de conectar |
| STOP-TEST | Primera aserción causal, control/base, cobertura de caso, skips | R; no borrar test, subir timeout/umbral arbitrario ni cambiar fixture a otra menos exigente | MEDIA si causa multicomponente/no demostrada; ALTA solo si revela contrato insoluble. Repetir el caso y regresiones afectadas |
| STOP-DATA | JSON paths anonimizados, tipos/ausencia/null, refs, diff semántico | Conservar raw; fixture sintética mínima; no reparar biblioteca | MEDIA si defecto codec contra mapa inequívoco; ALTA si campo/ref no representable. Usuario autoriza muestras reales o cambio visible |
| STOP-CONTRACT / STOP-DESIGN (A/A1/A2/B/B-LEGACY incluidos) | Interfaz/invariante que falta o dos reglas en conflicto, productores/consumidores | Preparar ejemplos request/response y contraejemplo, sin endpoint inventado | ALTA cierra contrato técnico; usuario solo si cambia producto aprobado. Las aprobaciones r4 no se reabren por cita histórica |
| STOP-TRANSPORT | Identidad de intento, dispatch/receipt conocido, versión SDK, permisos probados | Inspeccionar journal y evidencia permitida; conservar BLOCKED/RECONCILE, sin reenviar | ALTA T11 si reconciliación/fencing no demostrados; usuario para permiso/identidades. Retomar con protocolo probado, nunca con nuevo random_id intuitivo |
| STOP-INTEGRITY | Tenant/era/estado/ref/counter esperados vs observados, último commit seguro | Detener pasos siguientes; contención solo ya autorizada; conservar artefactos | MEDIA corrige bug local demostrado; ALTA ante autoridad incierta, datos dañados o cambio de invariantes. No rollback masivo por intuición |
| STOP-LAYOUT / STOP-NAV | Medidas CSS/viewport/foco/anchor, query/revisión, trace de saltos | Reproducir fixture y corregir aritmética demostrada sin cambiar UI | MEDIA integración; ALTA si altura fija/track móvil/revisiones no satisfacen contrato. Producto nuevo al usuario |
| STOP-BUDGET / STOP-PERF | Perfil, semilla, series crudas, heap/RSS/DOM/disco/WAL, EXPLAIN, carga fría/caliente | BAJA recoge; MEDIA ajusta un índice/consulta o fuga demostrada y remide comparables | ALTA si requiere nueva arquitectura o writers impiden READY. No reducir N, excluir outliers, aumentar RAM/budget ni eliminar artwork |
| STOP-SHUFFLE / STOP-SHUFFLE-PERF | Ronda/remaining/swaps/inverso/consumidos, secuencia RNG sintética, comandos y revisión; preparación fría separada | Prueba exhaustiva pequeña y reproducción aislada; preservar resultado idempotente | MEDIA bug de algoritmo cerrado; ALTA estrategia/perf fallida conforme r4. No permitir repetición para obtener PASS |
| STOP-PLAYBACK | Propietario de fuente/refcount, evento autoritativo vs eviction, sequence/cola/repeat | Fixture de audio aislada y cleanup mínimo propio | MEDIA; ALTA solo si contrato de versiones/recursos incompatible. No reiniciar Player por scroll |
| STOP-INTERACTION (-SELECTION/-QUEUE/-TAGS) / STOP-UX | Gesto/copy/alcance y cláusula r4, capturas/lector/foco/IDs afectados | Comparar contra r4, reproducir; arreglar wiring sin cambiar semántica | MEDIA si implementación; ALTA contrato técnico ausente; usuario solo nueva conducta. No sustituir selección global por ventana |
| STOP-APPROVAL | Paquete listo, comandos existentes exactos, target/efecto/contención y permiso faltante | Finalizar preparación y dry-run ya autorizado; ningún efecto real | Usuario, no ALTA ni Sol. Permiso debe identificar entorno/biblioteca/operación; no deducirlo de PASS |

Si una parada combina códigos, prevalece la protección más restrictiva. Tres intentos a ciegas no son diagnóstico; no hay obligación de agotar un número de retries. Cambiar un expected solo es admisible para reflejar una decisión **ya aprobada y trazada**, con revisión del nivel que posee el contrato y prueba independiente; jamás para convertir rojo en verde. No borrar capacidades, filtros, casos extremos ni requisitos de seguridad.

## 6. Manual de IDE BAJA

1. Recibir ID/paquete y permiso concreto; leer ficha original y ampliación. Verificar dependencias por artefactos, no por memoria de conversación. Sin contrato ejecutable cerrado, STOP-CONTRACT antes de tocar implementación.
2. Registrar Git, AGENTS aplicables y cambios preexistentes; usar copia verificable si hace falta. No pull, reset, stash, clean, cambio de rama, commit o push implícitos. No modificar DESIGN, main ni datos reales.
3. Delimitar entradas/salidas de la ficha. Convertir cada paso y cada caso del original/r4 en checklist `requisito → fixture → test → esperado`. No empezar código antes de saber cómo se comprobará el resultado.
4. Ejecutar el paquete en el orden de la ficha. Solo archivos permitidos; si necesita modificar otro componente justificarlo dentro del alcance o STOP. Nunca usar windowItems para enumerar selección/cola/rename global.
5. Resolver fallos rutinarios con R; mantener evidencia del fallo inicial y del arreglo. Escalar a MEDIA cuando requiere depuración cruzada; no invocar ALTA para errores de import o matcher. Si hay ambigüedad de datos/producto, detener implementación y preparar E.
6. Validar con runner existente auditado. Comprobar que el manifiesto incluye **todos** los casos requeridos y que el runner falla por suite ausente/skip. Leer logs, counts y hashes. Un exit 0 sin casos esperados no es PASS.
7. Handoff §9: estado real, evidencias y pendientes. No iniciar sucesor automáticamente. Baja puede cerrar autónomamente paquetes y T asignadas si todos sus criterios y revisiones requeridas se cumplen; no necesita supervisión permanente.

Comandos de inspección existentes, desde raíz (solo lecturas):

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git diff --name-only
git diff --check
rg --files -g AGENTS.md -g '!node_modules' -g '!target' .
rg --files src cloud-server tests scripts
```

Leer también AGENTS de ancestros. `git diff --check` no cubre archivos nuevos sin seguimiento: validarlos por separado. No imprimir `.env` ni valores de variables sensibles. `npm run test:typecheck` y `npm run build:web` existen en package.json leído; ejecutar solo cuando la ficha lo pide, entorno de hijo saneado y configuración/imports auditados. Build no despliega.

**Runner futuro:** `node scripts/catalog-check.cjs Txx`, `unit`, `perf` y `all-local` son comandos definidos por T02, hoy ausentes. Antes de invocar: archivo existe, contrato/manifiesto aprobado, suites requeridas registradas y descriptor seguro. T02 no puede certificar su propio aislamiento exclusivamente con un test que se limita a leer su código: requiere casos de rechazo y counters de acceso. No utilizar `cloud-server npm test` (placeholder), `npm test`/agregadores sin auditoría, ni `postgres-live.integration.cjs` con variables heredadas.

T00 tiene un script existente, `T00-BASELINE-READONLY.ps1`, que **rechaza este árbol dirty**. No se proporciona una orden para saltar esa guarda. El próximo encargo T00 debe resolver identidad/copia segura antes de ejecutarlo. Preparar navegador aislado para smoke no equivale a reutilizar sesión autenticada real.

## 7. Manual de IDE MEDIA

Recibe mapa, contratos fijados, fixtures/manifest, fallo reproducible y handoff. Confirma productor/consumidor y propiedad del estado antes de adaptar código. Cambia una frontera por vez (repositorio → API → adaptador → composición), preservando LEGACY. Puede resolver locks/índices/cleanup dentro del orden C1 y contratos ya fijados, no inventar protocolo de transporte ni alterar semántica r4.

Entrega a BAJA paquetes con firmas/tipos exactos, paths, casos/expected y comando seguro; no «implementa algo parecido». Tras integrar, compara DTO/API, aliases, eventos tardíos, versionado y cancelación con pruebas cruzadas. Devuelve diff acotado, cobertura y diagnóstico; si no puede explicar causa, STOP-TEST. Escala a ALTA solo pregunta arquitectónica concreta con opciones y reproducción, no repo completo sin objetivo.

MEDIA puede emitir G1/G3/G4 conforme §4, pero debe inspeccionar evidencia primaria y distinguir fake/proveedor/real. Una nueva estrategia de seguridad, reparación de daños o variación de UX no se acepta por conveniencia técnica. No necesita revisión ALTA para cada módulo marcado MEDIA.

## 8. Manual de IDE ALTA y protocolo de GPT-6 Sol

**ALTA, intervenciones previstas:**

- T01-B: convertir inventario nuevo r4 en contrato de filas, FKs, invariantes, locks, revisiones y reparto de migraciones; resolver vacíos demostrados antes de DDL. No efectuar el inventario repetitivo.
- T06-A/V02-A: fijar interfaces aún no especificadas de conjuntos/selección/rangos/facetas/operaciones musicales y cola, errores y ownership; modelo de exclusiones/rangos y orden vs membresía; contratos verificables antes de clientes. No rediseñar Fisher–Yates ni seleccionar scope de producto.
- T11: hipótesis/experimentos y decisión de proveedor/fencing; este riesgo permanece abierto aunque metadata esté bien documentada.
- T21-B: revisar candidato concreto, seguridad/autoridad, roundtrip, fallos y recuperación; emitir GO/NO-GO técnico por puerta. No repetir manualmente toda la ejecución de tests.

Fuera de esas ventanas, solo E que prueba necesidad de nueva arquitectura/invariante o riesgo crítico. ALTA devuelve una decisión versionada con precondiciones, firmas, ejemplos, pruebas y dueño de implementación; el trabajo rutinario vuelve a BAJA/MEDIA. Una duda de producto se presenta al usuario con diferencia concreta respecto de r4; ALTA no aprueba cambios visibles por él.

**GPT-6 Sol:** revisión independiente del contrato consolidado G0/V00-A, del paquete de entrega y de informes/alternativas cuando haya pregunta conceptual. Puede cuestionar un PASS y emitir NO-GO por evidencia ausente. No declara haber corrido comandos Windows, inspeccionado DB o medido browser si solo recibió un informe.

Paquete mínimo para Sol: objetivo de revisión en una frase; T/V/gate; SHA+hash del árbol documental local (los nuevos MD pueden faltar en GitHub); extractos completos de las cláusulas relevantes y r4; diff acotado; tablas requisito→caso→resultado; logs/resúmenes sin secretos con hashes y manifiesto; limitaciones y pregunta exacta. Adjuntar los documentos locales al paquete, no dar únicamente URL remota vieja. Si falta evidencia, pide ese artefacto a la IDE; no repite implementación ni asume acceso al PC. Su salida: hallazgo verificable/cláusula/impacto, evidencia suficiente o faltante, decisión técnica o derivación a MEDIA/ALTA/usuario, sin permisos productivos.

## 9. Plantilla obligatoria de handoff e informe final

Guardar resumen en ESTADO y evidencia en EVIDENCIA; artefactos de ejecución en `artifacts/catalog/<run-id>/` conforme TAREAS. Los archivos de contrato/mapa propuestos por las matrices son futuros, no existentes por haberlos nombrado.

```text
ID T/V / paquete / fecha / nivel responsable / revisor requerido:
Encargo y autorización (referencia; entorno/operaciones incluidas):
Base: rama, SHA completo, dirty paths y hashes, AGENTS leídos:
Fuentes normativas/versiones (C, M, r4, N1) y decisiones aprobadas:
Dependencias: ID, alcance PASS, SHA/config/artefacto/hash; faltantes:
Entrada y salida: paths, símbolos, firmas/API/schema y versión de contrato:
Cambios: qué y por qué; invariantes preservados; archivos ajenos intactos:
Entorno: descriptor seguro, proveedor fake/aislado/real, recursos, flags:
Comandos exactos ejecutados, cwd, exit, manifest/hash; nunca secretos:
Tabla requisito → fixture/hash → test → esperado → observado → log:
Totales: ejecutados/PASS/FAIL/SKIP; pruebas no ejecutadas y causa:
Medidas si aplican: frío/caliente, muestras/picos, perfil; sin estimaciones como datos:
Estado durable: autoridad/era/epoch/revisión, checkpoint, efectos inciertos o ninguno:
Dictamen: PASS | PASS-AISLADO | PARCIAL | STOP-código; alcance exacto:
Revisión técnica: autor/nivel/fecha, hallazgos resueltos/abiertos:
Permisos faltantes: operación concreta, paquete preparado, autoridad humana:
Para sucesor: contrato y fixtures a consumir, comando seguro, no repetir qué y por qué:
Siguiente tarea autorizable (no ejecutarla); decisión pendiente si existe:
```

Reuso: una misma evidencia puede satisfacer varios requisitos con referencias cruzadas si el hash/código/config/entorno y alcance son iguales. Retest por cambio en dependencia, contrato, perfil o fallo nuevo. T21 conserva su ejecución completa obligatoria; V09 no se repite entero por mera transferencia de chat si su código no cambió y el manifiesto candidato lo admite. No sumar múltiples ejecuciones del mismo caso como cobertura nueva.

## 10. Estado real y próximo encargo autorizable

Decisiones C12/V00 cerradas para diseño por r4; baseline whitelist histórico 68/68 y 25/25 mutaciones sobre `5b19916`, descriptor G0 histórico registrado en el probe, no reejecutados aquí. **T00 global NO PASS; G0 NO APROBADO; T01 BLOQUEADA; T02 NO INICIADA.** No se borra la etiqueta histórica STOP-DESIGN; su motivo de producto quedó resuelto y resta dictamen formal y cobertura vigente de gate.

Próximo encargo autorizable: revisión formal T00/G0 sobre base real, r4 y evidencia primaria; BAJA prepara, Sol dictamina, MEDIA investiga solo faltantes funcionales. Debe explicitar smoke pendiente y validez del baseline del código actual. Si alguna prueba necesaria requiere acceso no autorizado, STOP-APPROVAL con paquete concreto. Solo tras T00/G0 y autorización se puede asignar T01-A; esta mejora documental no la inicia.
