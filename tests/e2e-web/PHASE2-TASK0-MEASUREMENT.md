# Fase 2, Task 0: baseline Web de cinco cuentas

El modo Task 0 reutiliza login, observador de `get_index`, sesiones Direct y prueba de progreso de audio del E2E real de Stage 1. Tiene su propio recorrido y reporte. No entra al mixed soak ni ejecuta uploads, edición, downloads o los gates de Task 4. Requiere las pistas `Stage1 Playback v2 01` a `05` ya confirmadas en los cinco vaults; si falta alguna, la corrida es inválida y no se crea contenido para hacerla pasar.

`cloud-server/.env` debe contener la configuración PostgreSQL productiva de Stage 1. PostgreSQL, MASTER y Direct deben estar disponibles. El harness inicia Cloud desde este checkout con `node --env-file=.env server.js` y exige `/readyz` con `postgres=ready`. No debe existir otro Cloud en `127.0.0.1:4000`.

Para demostrar una corrida completa antes de las otras dos:

```powershell
node scripts/run-phase2-task0-measurements.mjs --runs 1
```

Cuando se decida completar la serie de tres corridas independientes:

```powershell
node scripts/run-phase2-task0-measurements.mjs --runs 3
```

El comando construye Web con `npm run build:web`, registra el SHA de Git y hashes de código y `dist`, y sirve el build con `vite preview`. Cada corrida abre perfiles Chrome nuevos para las cinco cuentas. El Cloud administrado por el harness y los reportes Stage 1 anteriores se restauran al terminar.

Cada cuenta realiza:

1. Apertura fría con perfil nuevo y login, hasta `get_index` completado y biblioteca autoritativa utilizable.
2. Reapertura caliente con sesión activa, hasta una nueva lectura autoritativa utilizable.
3. Cuatro Reload calientes, cada uno hasta una nueva lectura autoritativa utilizable.
4. Un Play después de cada Reload, sobre su pista ya confirmada, hasta estado de audio sonando con progreso.

Las cinco cuentas ejecutan cada paso concurrentemente. Las muestras guardan cuenta, ronda, timestamp inicial/final y referencia a la operación autoritativa o al progreso de audio. Una corrida sólo es `VALID` si las cinco cuentas terminan las cuatro condiciones con timestamps ordenados y prueba autoritativa: cinco muestras de apertura fría, cinco de reapertura caliente, veinte de Reload y veinte de Play. Un aborto, falta de `get_index`, ausencia de pista, error de reproducción o muestra incompleta deja `INVALID`.

Los reportes están en `tmp/phase2-task0/<id>/`: `run-XX-measurement-raw.json`, `run-XX-normalized.json` y `summary.json`. El resumen contiene condición, número de muestras, promedio, máximo, p95, errores, revisión y estado. Los p95 de 5 s para biblioteca caliente y 2 s para primer audio se registran como referencia; Task 0 no cambia ni usa presupuestos para declarar válida una corrida. Con `--runs 1`, una corrida válida produce `VALID_RUN`. Tres corridas válidas en una misma ejecución producen `BASELINE_COMPLETE`; los demás resultados son `INSUFFICIENT_EVIDENCE`.
