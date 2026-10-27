# BeatGaler — guía flexible hacia V1 Web + Cloud

> **Una guía de dirección, no un plan de ejecución ni un calendario.** Cada frente se investigará y tendrá su propio plan cuando el responsable decida trabajarlo. Evitar miles de tareas, documentos de transición, listas duplicadas y compromisos prematuros. Un problema concreto → un diagnóstico → un plan corto → pruebas → PR.

## Qué queremos conseguir antes de ampliar funcionalidades

La V1 de Web + Cloud debe **verse profesional, sentirse profesional y soportar crecimiento real**, sin comprometer archivos ni datos de usuarios.

- **Experiencia premium:** landing page pública antes de login, identidad visual coherente, UX sencilla, diseño responsive y feedback claro de cualquier operación.
- **Velocidad medible:** cargas rápidas de biblioteca, reproducción que empieza pronto, subidas/descargas eficientes y una interfaz fluida. Medir tiempos reales en dispositivos y redes representativos antes de fijar objetivos numéricos o rediseñar.
- **Fiabilidad:** operaciones recuperables e idempotentes, errores bien manejados, nada de perder datos o dejar al usuario bloqueado; ensayar fallos, reintentos, sesiones, uploads parciales y recuperación.
- **Presentación limpia:** ningún rastro visible de Telegram como infraestructura interna en la UI, textos o errores públicos; retirar `console.log`/debug ruidoso del cliente de producción, **sin eliminar la observabilidad segura del backend**. No confundir ocultar implementación con sustituir el transporte subyacente.
- **Código que entendemos:** responsabilidades claras, menos duplicación, nombres consistentes, dependencias conocidas, pruebas que documenten contratos y eliminación de código muerto solo tras comprobar que ya no se usa.
- **Escala y concurrencia demostradas:** no basta con que funcione para una persona. Diseñar y medir operaciones simultáneas, aislamiento por usuario, límites de Telegram/transporte, Cloud, PostgreSQL, colas, tiempos de espera, coste y puntos únicos de fallo. La actual EC2 `t3.micro` y RDS `db.t4g.micro` **no constituyen prueba** de capacidad para muchos usuarios.

## Frentes posibles (sin orden obligatorio ni planes congelados)

| Frente | Preguntas a resolver cuando se elija |
| --- | --- |
| Landing y marca | ¿Qué verá el visitante antes de iniciar sesión? ¿Cómo explicar BeatGaler y llevarlo con confianza a signup/login? |
| UX y responsive | ¿Dónde se siente lenta, confusa, inconsistente o frágil la Web? ¿Qué pasa en móvil y pantallas pequeñas? |
| Upload y playback | ¿Cuánto tarda cada fase desde el click hasta subir/escuchar? ¿Qué parte está en cliente, red, transporte o servidor? |
| Robustez | ¿Qué ocurre ante mensajes/archivos faltantes, caídas, timeouts, carga parcial, renovaciones y sesiones simultáneas? |
| INDEX / MASTER / Transport Bot | **Auditar primero la ruta realmente activa de Web + Cloud:** la arquitectura Direct contempla que el transport bot asignado gestione el INDEX desde el cliente y reserva MASTER para aprovisionamiento/recuperación excepcional; existe también código Cloud con operaciones de INDEX vía MASTER. **No decidir aún migración:** medir rutas activas, cargas, permisos, ownership, bloqueo y riesgo de borrado concurrente, sin comprometer integridad del INDEX ni aislamiento. |
| Escalabilidad | Pruebas graduales de concurrencia y carga en entorno aislado; observar cuellos de botella, throughput, p95/p99, límites de terceros y estrategias de escalado/backpressure. |
| Seguridad, datos y billing | Autenticación, aislamiento entre cuentas, permisos, quotas, pagos, recuperación, backups y migraciones seguras. |
| Limpieza de código | Auditoría de módulos, duplicados, dependencias, logs, contratos, nombres y pruebas; refactors mínimos y verificables. |
| Producción y observabilidad | Alertas, recuperación, rollback, disponibilidad, RDS, costes y capacidad cuando corresponda. |
| Marketing en paralelo | Empezar investigación, guiones, estilo, assets y pilotos desde el repositorio independiente [MarketingBeatGaler](https://github.com/magosouljah/MarketingBeatGaler). No exagerar características ni lanzar campañas grandes antes de una landing y una experiencia validada. La Fase 0 del sistema de video ya está definida allí. |

**Principio:** estabilidad, rendimiento, claridad y seguridad **antes** de añadir más features. No hacer una reescritura total sin evidencia.

## Cómo se inicia un frente cuando llegue su momento

Solo cuando se elija un tema: (1) observar el comportamiento actual y obtener medidas, (2) definir problema y alcance, (3) escribir **su** plan específico y criterio de aceptación, (4) implementar en cambios pequeños y aislados, (5) probar regressiones/carga donde aplique, y (6) decidir despliegue por separado. Esta guía no asigna fechas ni obliga a seguir un orden fijo.

## Estado y restricciones (27-10-2026)

- **Web + Cloud en producción:** `v0.9.0-beta.2` / `release/0.9.0-beta.2` / `a8418223527f88e9d34db8e05abb10216942013c`; no desplegar cambios de `main` sin autorización explícita.
- En `main`, PR #144 y #145 quitaron el regalo automático de siete días a nuevas cuentas, preservando los grants históricos hasta su vencimiento. Son cambios **no publicados** mientras no exista despliegue autorizado.
- **Seguridad de pruebas:** [Issue #133](https://github.com/magosouljah/BeatGaler/issues/133) — aislar la DB de tests; antes de pruebas destructivas o con escrituras, verificar explícitamente el entorno.
- **Incidente EC2 27-10-2026:** [registro operativo](OPERATIONS/INCIDENT-2026-10-27-EC2-NETWORK.md). Recuperado, causa inicial incierta; **se deja en observación** por decisión del responsable, sin tarea inmediata. Reactivar si se repite.
- **Desktop/Tauri pausado.** Prioridad exclusiva de ingeniería: Web + Cloud.
- No tocar datos, infraestructura, credenciales, billing real ni release en producción como consecuencia de esta guía. Cualquier cambio de ese tipo necesita autorización y recuperación/rollback comprobables.

Para el estado real consultar [CURRENT-STATE.md](CURRENT-STATE.md); para la visión completa de producto, [V1.md](V1.md). GitHub Issues/PRs y código/test/runtime prevalecen sobre documentación histórica.
