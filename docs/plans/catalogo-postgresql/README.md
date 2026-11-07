# Catálogo PostgreSQL por beat: plan de ejecución

Fecha: 7 de noviembre de 2026. Estado: **plan elaborado; implementación no iniciada**.

## Qué se pretende conseguir

Una biblioteca cuyo catálogo se consulte y modifique por registros en PostgreSQL. Telegram conserva los archivos. Abrir una página, editar metadatos, enviar a papelera y restaurar no debe descargar, reconstruir ni publicar el INDEX, ni necesitar una sesión Direct lista. Los archivos se transfieren cuando la operación los necesita.

La idea proporcionada por el usuario es contexto, no una especificación aprobada. Este paquete fija una propuesta concreta a partir del código inspeccionado. Sus decisiones nuevas están identificadas como propuestas; aprobar o ejecutar una tarea no certifica producción ni autoriza las siguientes operaciones sobre datos reales.

**Alcance inicial:** Web + Cloud + worker de catálogo. Desktop está suspendido según la documentación del repositorio: se impide su acceso incompatible a bibliotecas migradas, no se reescribe Tauri como parte de este trabajo. Studio no participa.

## Cómo entregar este trabajo a otra IA

1. Entregar este directorio completo, no un resumen de arquitectura.
2. Usar el prompt al final de este documento y asignar **una sola tarea** de [TAREAS.md](TAREAS.md).
3. La IA lee primero [ESTADO.md](ESTADO.md), [CONTRATO.md](CONTRATO.md) y su tarea. Consulta [EVIDENCIA.md](EVIDENCIA.md) para comprobar las premisas.
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
