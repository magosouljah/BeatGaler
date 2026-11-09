# Catálogo PostgreSQL por beat: plan de ejecución

**Rediseño nativo (2026-11-08, PROPUESTA pendiente de aprobación):** [NATIVO-POSTGRES-20261108.md](NATIVO-POSTGRES-20261108.md). Sin usuarios reales: las bibliotecas nacen en PostgreSQL, sin import, sombra, corte ni reversión a INDEX. Telegram queda solo para medios. Se redefinen las tareas y los gates T05–T25 (§9–§10). El estado vigente está en [ESTADO](ESTADO.md).

**Vigencia C12-r4 (2026-11-07):** [cierre C12-r4](C12-V00-CIERRE-20261107.md) integra el [acta I1/I2/I3 aprobada](C12-V00-INTERACCIONES-APROBADAS-20261107.md) de `c6d7b7cf4455623ab2da7bfbdadabb0b4b3e3b81` y las respuestas explícitas del usuario de este encargo. **A1/A2/B-legacy e I1/I2/I3 aprobados; decisiones C12/V00 cerradas para diseño.** Shuffle sin repetición por ronda, aviso de selección solo si existía y rename también en papelera sin alterar su estado. Las menciones pendientes r2/r3 quedan como antecedentes, sustituidas por r4. **T00/G0 no PASS; T01 bloqueada; T02 no iniciada.** No hay autorización de implementar.


Fecha: 7 de noviembre de 2026. Estado: **plan elaborado; implementación no iniciada**.

**Revisión vigente C12-r4:** [acta](C12-DECISION-RECORD.md), [cierre V00](C12-V00-CIERRE-20261107.md) y [plan V00–V11](C12-B-INTEGRACION-Y-PLAN-20261107.md). Decisiones aprobadas integradas; pruebas y revisión formal T00/G0 pendientes. HEAD sigue a446219; remoto documental c6d7b7c. Sin implementación.

## Qué se pretende conseguir

Una biblioteca cuyo catálogo se consulte y modifique por registros en PostgreSQL. Telegram conserva los archivos. Abrir una página, editar metadatos, enviar a papelera y restaurar no debe descargar, reconstruir ni publicar el INDEX, ni necesitar una sesión Direct lista. Los archivos se transfieren cuando la operación los necesita.

La idea proporcionada por el usuario es contexto, no una especificación aprobada. Este paquete fija una propuesta concreta a partir del código inspeccionado. Sus decisiones nuevas están identificadas como propuestas; aprobar o ejecutar una tarea no certifica producción ni autoriza las siguientes operaciones sobre datos reales.

**Alcance inicial:** Web + Cloud + worker de catálogo. Desktop está suspendido según la documentación del repositorio: se impide su acceso incompatible a bibliotecas migradas, no se reescribe Tauri como parte de este trabajo. Studio no participa.

## Cómo entregar este trabajo a otra IA

1. Entregar este directorio completo, no un resumen de arquitectura.
2. Usar el prompt al final de este documento y asignar **una sola tarea** de [TAREAS.md](TAREAS.md).
3. La IA lee primero [ESTADO.md](ESTADO.md), [CONTRATO.md](CONTRATO.md), el acta C12-r4, el cierre V00 y su tarea; si afecta Gallery, también el plan B V00–V11. Consulta [EVIDENCIA.md](EVIDENCIA.md) para comprobar las premisas.
4. Ejecuta únicamente si sus dependencias están `PASS` con evidencia. No interpreta `PENDIENTE`, `SKIP` ni “parece funcionar” como aprobación.
5. Termina con cambios, comandos, resultados y siguiente tarea habilitada. Si encuentra una condición de parada, entrega el expediente de escalamiento y se detiene.

No se permite a la IA ejecutora sustituir componentes, inventar una política de datos o eliminar una prueba para hacer avanzar el plan. Los cambios de contrato corresponden a una inteligencia de alta capacidad y quedan registrados antes de continuar.

## Lectura del paquete

| Archivo | Función |
| --- | --- |
| [EVIDENCIA.md](EVIDENCIA.md) | Base inspeccionada, hechos, fuentes, pruebas realizadas y límites del análisis. |
| [CONTRATO.md](CONTRATO.md) | Autoridad, tablas, API, operaciones, compatibilidad y reglas que la ejecución debe respetar. |
| [TAREAS.md](TAREAS.md) | Trabajo ordenado, archivos, verificaciones y condiciones de parada por tarea. |
| [MIGRACION.md](MIGRACION.md) | Sombra, corte, reversión, recuperación y puertas de lanzamiento. |
| [ESTADO.md](ESTADO.md) | Registro inicial de ejecución y formato para transferir el trabajo. |
| [C12-DECISION-RECORD.md](C12-DECISION-RECORD.md) | Decisiones técnicas, cambios visibles pendientes, contratos precisos y matriz para ejecutores. |
| [C12-CARACTERIZACION-20261107.md](C12-CARACTERIZACION-20261107.md) | Evidencia local/remota, callers y experimentos Node/Chrome; límites de lo verificado. |
| [C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md](C12-B-GALLERY-INFINITA-VIRTUALIZADA-20261107.md) | Aprobación de la experiencia continua y fronteras de lo no aprobado. |
| [C12-B-INTEGRACION-Y-PLAN-20261107.md](C12-B-INTEGRACION-Y-PLAN-20261107.md) | Reconciliación segura, arquitectura por filas, estado/memoria, tareas dependientes y pruebas. |
| [EJECUCION-POR-NIVELES-20261107.md](EJECUCION-POR-NIVELES-20261107.md) | Manual N1: reparto entre Chat normal, IDE BAJA/MEDIA/ALTA, gates, STOP, escalamiento y plantilla de handoff. |
| [MATRIZ-T-NIVELES-20261107.md](MATRIZ-T-NIVELES-20261107.md) | Ficha ampliada por nivel de cada tarea T00–T25: responsable, paquetes, orden, PASS, STOP y handoff. |
| [MATRIZ-V-NIVELES-20261107.md](MATRIZ-V-NIVELES-20261107.md) | Ficha ampliada por nivel de cada subtarea V00–V11 del plan B, con su T padre y reconciliaciones RV1–RV5. |

## Decisiones de esta propuesta

- Una aplicación modular y un worker PostgreSQL. Sin Redis, Kafka, microservicios ni cambios de motor.
- Nuevas tablas `catalog_*` para poder importar en sombra sin modificar el ledger activo. Tras el corte, esas tablas son autoridad; `library_beats` queda como proyección de compatibilidad actualizada en la misma transacción. No son dos fuentes de decisión.
- JSONB por entidad para conservar campos históricos; columnas y relaciones para los campos consultables. Nunca un JSONB mutable que contenga toda la biblioteca.
- API nueva `/catalog/v1`. El estado persistente por biblioteca elige la autoridad. Un error de PostgreSQL nunca activa fallback a INDEX.
- Versiones por beat, identidad durable de operación y época por biblioteca. Ediciones incompatibles producen un conflicto visible.
- Paginación del servidor, cambios incrementales y referencias de reproducción acotadas. Se elimina la dependencia del arranque respecto del INDEX y de Direct para consultar metadatos.
- Se conserva el transporte Web actual de PROJECT (temporal Cloud → MASTER) durante esta migración, adaptando su coordinación. Los medios normales siguen por Direct.
- Eliminación física desactivada inicialmente. Se habilita solo tras demostrar retención, referencias, restauración y seguridad frente a clientes antiguos.
- Reversión después de nuevas escrituras mediante exportación del catálogo **actual**, nunca mediante un INDEX viejo.

## Puertas que no puede resolver una IA ejecutora por su cuenta

**G0 — Base y contrato:** fijar rama de implementación, SHA, versión de PostgreSQL del entorno objetivo, pruebas base y decisiones de producto del contrato C12. No confundir `main` local con el remoto ni con producción.

**G1 — Datos:** aprobar mapa exhaustivo de campos y roundtrip; ninguna identidad, parte, referencia o campo desconocido puede desaparecer.

**G2 — Transporte:** demostrar en entorno Telegram aislado la reconciliación de respuesta perdida y el bloqueo de sesiones antiguas. Las comprobaciones HTTP y la época SQL no revocan por sí solas una credencial Telegram.

**G3 — Integridad:** pruebas reales de concurrencia en PostgreSQL aislado, fallos en cada frontera y cero esperas externas con conexión SQL retenida por la operación.

**G4 — Operación:** reversión con cambios nuevos, restore, retención, backups y rendimiento medidos. Autorización independiente para desplegar o tocar una biblioteca real.

Se puede construir y probar con dobles antes de G2; no se puede abrir un piloto real. Los datos que solo pueden obtenerse del entorno no se sustituyen por suposiciones.

## Prompt para la IA ejecutora

> Ejecuta únicamente la tarea T__ del plan `docs/plans/catalogo-postgresql/`. Lee README, ESTADO, CONTRATO y la tarea completa. Verifica SHA, dependencias y alcance antes de editar. Las instrucciones de la conversación y AGENTS.md aplicables prevalecen. No cambies el contrato ni toques producción, AWS, Telegram real o datos reales salvo autorización expresa para esa tarea y ese entorno. Usa únicamente comandos existentes o los creados y verificados por la tarea. Si falta una premisa, aparece una condición STOP o una prueba falla por causa no demostrada, no improvises: registra código STOP, evidencia sin secretos, estado de archivos y próxima decisión; detente para revisión por una inteligencia de alta capacidad. No hagas commit, push ni despliegue salvo que se te haya pedido. Al cerrar, actualiza ESTADO con PASS/STOP, comandos y artefactos. No empieces la siguiente tarea.


## Actualización de base LOCAL (2026-11-07)

<!-- BG-PG-LOCAL-BASELINE-20261107 -->
Este plan se ejecutará sobre BeatGaler **LOCAL**, verificando la rama y `HEAD` del checkout real; no se ejecutará sobre `main` ni PROD. La integración Landing/Gallery auditada es `31861e6406ac10073d368aa5d8a4edcb5dfd2d2b`. Consultar [LOCAL-BASELINE-20261107.md](LOCAL-BASELINE-20261107.md) antes de G0/T01. El anexo prevalece para rutas, UI y versión base; el contrato del catálogo existente permanece vigente. No se renumeran las 26 tareas.

## Resultado de revisión G0 (2026-11-07)

[G0-AUDITORIA-20261107.md](G0-AUDITORIA-20261107.md) registra la revisión estática, riesgos, decisiones pendientes y correcciones. **G0 no aprobado; T00 pendiente y T01 bloqueada.** El descriptor seguro de PostgreSQL se aprueba en T00; las bases efímeras del arnés se crean en T02, no antes de T01. No se modificaron Landing, Gallery ni Playbar.

## T00 — Base congelada y pruebas limitadas

Se inició T00 por instrucción del usuario tras actualizar la rama LOCAL. [T00-REVISION-20261107.md](T00-REVISION-20261107.md) contiene la evidencia estática y sus bloqueos. [T00-BASELINE-READONLY.ps1](T00-BASELINE-READONLY.ps1) ejecuta solo pruebas previamente inspeccionadas con variables sensibles retiradas del proceso de prueba. No ejecuta la base real, AWS, Telegram ni pruebas destructivas. **T00 sigue sin PASS** hasta registrar su salida y cerrar STOP-ENV/STOP-TEST/STOP-DESIGN; T01 permanece bloqueada.

## Transferencia normativa vigente C12-r4

[cierre C12-r4](C12-V00-CIERRE-20261107.md) integra las aprobaciones explícitas y sustituye pendientes/recomendaciones incompatibles r2/r3. A1 ICU fijo, A2 binary64/clase y B-legacy <=10.000 quedan aprobados. I1 selección global con aviso solo si había selección; I2 audio continuo, nuevo query y cola prioritaria, Shuffle sin repetición por ronda; I3 rename ACTIVE/TRASH sin modificar estado. Se descarta fijar permanentemente la búsqueda musical al pulsar Play.

Aplicar las dependencias, algoritmos, alternativas y STOP de sección 7 del cierre a T01/T03/T06/T07/T13/T14/T20 y V00–V11. Membresías SQL persistidas, selección CAS, facetas, journal y swaps Shuffle no son memoria global del cliente. T01/T06 deben producir inventario y contratos tipados completos en sus tareas futuras. T00 revisa formalmente base/descriptor/baseline/contrato, sin volver a solicitar las aprobaciones resueltas. T01 permanece bloqueada; ningún paso de implementación iniciado.

## Reparto por nivel de inteligencia (N1)

- **Para ejecutar una tarea:** la ficha original de [TAREAS.md](TAREAS.md) (y, para Gallery, la V de [plan B](C12-B-INTEGRACION-Y-PLAN-20261107.md) §8) más su ficha ampliada en [matriz T](MATRIZ-T-NIVELES-20261107.md) o [matriz V](MATRIZ-V-NIVELES-20261107.md). Las fichas ampliadas no sustituyen a las originales.
- **Para repartir trabajo entre inteligencias:** [manual N1](EJECUCION-POR-NIVELES-20261107.md) §§2 y 5–8 (quién posee cada T/V, qué paquetes hace IDE BAJA, cuándo interviene IDE ALTA y cómo se escala un STOP).
- Recuento: 26 T (BAJA 8, MEDIA 16, ALTA 2) y 12 V que subdividen T existentes (Chat 1, BAJA 3, MEDIA 8). No suman 38 implementaciones. Ninguna T/V tiene PASS por existir estas matrices; T00/G0 siguen pendientes de revisión formal.
