# T11 fase B — Resultados de la ejecución real en sandbox (2026-11-13)

**Estado:** ejecutado con autorización de GPT-6 (E2/E4/E5/E6/E8; **E7 omitido: el token de Bot20 no se tocó**). Recursos: Bot20 + chat de pruebas `testborrar`, identidad y miembros verificados por el preflight. **T11 NO PASS; G2 NOT_PROVEN** (E3 y E7 pendientes; veredicto de Sol). IDs abreviados; sin secretos en los informes (escaneo STOP-SECRET).

## Ejecuciones
| Run | Resultado |
| --- | --- |
| 1 | Abortó en E5 con `INPUT_FILTER_INVALID`. **Hallazgo real:** Telegram rechaza `messages.Search` con `from_id` + `InputMessagesFilterDocument`. Corregido a `InputMessagesFilterEmpty` (gateway, test y contrato). Quedaron 4 mensajes de prueba sin limpiar (ids 12–15 del chat; la limpieza no corre al abortar) → borrado manual pendiente del propietario. |
| 2 | Completa (E7 omitido). Limpieza: 22 pedidos, 22 verificados ausentes. E2_bot falló por un fallo del arnés (el cliente que descarta respuestas no resolvía el peer → `CHANNEL_INVALID`); corregido. |
| 3, 4 | Solo E2/E5 (+E6/E8 baratos), sin E4. Limpieza verificada en ambas. |

## Resultados por experimento
- **E6 PASS:** el recibo (tamaño, documento) coincide con la verificación del proveedor por bot y por MASTER; remitente distinto → `PROVIDER_SENDER_MISMATCH`; id inexistente → `PROVIDER_MESSAGE_NOT_FOUND`.
- **E2 PASS (bot y MASTER):** con la respuesta perdida tras el efecto real, hay exactamente 1 copia; la búsqueda de MASTER la encuentra (`ADOPT`). El bot **no puede** usar `messages.Search` (`BOT_METHOD_INVALID`), pero su sondeo de ids con `channels.GetMessages` también encuentra la copia (`ADOPT`). Conclusión: el bot reconcilia por sondeo de ids; MASTER por búsqueda.
- **E4 (run 2): `random_id` repetido nunca crea una copia** (bot: misma sesión, reconexión y auth key nueva; MASTER: misma sesión y reconexión; 0, 5 y 65 s): siempre `SAME_MESSAGE`, 1 copia (15/15 casos). No se probaron ventanas >65 s.
- **E5 NO PASS:** misma firma (`caption`+tamaño) con 2 mensajes distintos: el historial tiene 3 copias, pero la búsqueda devuelve 2 y de forma estable (>30 s) → `ADOPT` donde debería ser `AMBIGUOUS`. Nombre igual con tamaño distinto y otra parte sí se distinguen. **Implicación:** la búsqueda por marcador puede omitir mensajes, así que no basta para garantizar unicidad; la reconciliación debe verificarse (p. ej. con `verifyMessage` por id y contra el mapa físico) y tratar el resultado de búsqueda como no exhaustivo. Decisión de diseño para Sol; no se corrige el contrato aquí.
- **E8 — riesgo G2 CONFIRMADO:** el bot, sin derecho de borrado ni fijado, **puede editar y borrar sus propios mensajes**; no puede fijar (`CHAT_ADMIN_REQUIRED`) ni borrar los de MASTER (`MESSAGE_DELETE_FORBIDDEN`). Una sesión de bot antigua no revocada conserva acceso a lo que envió: la revocación depende de rotar el token (E7, no ejecutado).
- **E3 (FLOOD_WAIT) y E7 (rotación): sin ejecutar → pendientes.**

## Para el dictamen G2
Falta: E7 (efecto de rotar sobre sesiones abiertas y auth keys, requiere confirmar que producción no usa Bot20), E3, decisión sobre la limitación de búsqueda de E5 y la política ante E8. Siguiente paso más rápido: el propietario confirma el aislamiento de Bot20 y autoriza E7; en paralelo Sol decide la regla de reconciliación no exhaustiva.

## Decisión del propietario sobre E5 — OPCIÓN A (2026-11-13), implementada
- `TRANSFER_RECONCILE` (`cloud-server/catalog/worker.js`) ya **no adopta** una coincidencia única por búsqueda: exige `transport.proveUniqueMatch(...) === true` (archivo correcto **y único**). Sin esa prueba → job `blocked` con `RECONCILE_REVIEW_REQUIRED` (no transitorio): no se crea recibo, no se encola commit, no se reenvía ni se borra. `>1` sigue siendo `RECONCILE_AMBIGUOUS`; `0` sigue siendo incierto (reintento acotado).
- El gateway real **no** ofrece `proveUniqueMatch` (no hay buscador exhaustivo), por lo que hoy toda reconciliación por búsqueda queda bloqueada para revisión manual. El envío normal con recibo y verificación no cambia.
- **Limitación conocida / mejora posterior al lanzamiento:** prueba de unicidad (p. ej. sondeo exhaustivo de ids) para reanudar automáticamente la reconciliación. E3, E7 y G2 siguen pendientes.
- Pruebas: `catalog-worker.test.cjs` (bloqueo sin prueba y con prueba negativa: 0 recibos/commits/borrados; adopción solo con prueba positiva). Integración PostgreSQL: el fake de transporte modela la prueba positiva; la ejecuta el CI.

## Fencing de leases (hallazgos GPT-6) — `1bc10a3`, CI `43496625720` (intento 2 PASS)
- `operations.failJob`: lectura y actualización en una sola transacción (`SELECT … FOR UPDATE` con el lease en el WHERE y UPDATE protegido por el mismo lease); un worker viejo recibe `LEASE_FENCED` sin tocar el job reasignado.
- `operations.putReceipt` acepta `lease` y lo valida dentro de la transacción de mutación (job bloqueado `FOR UPDATE`, antes del operation/part), conservando era/epoch; `TRANSFER_RECONCILE` lo pasa. La opción A de E5 no cambia.
- Pruebas PostgreSQL aislado (`catalog-worker.integration.cjs`, 7/7): reasignación (fail/complete/putReceipt con lease viejo → fenced sin efecto), carreras fail-vs-complete, y lease robado durante el efecto remoto → `fenced`, sin recibo ni commit.
- CI: intento 1 falló solo en T06 `catalog-queries-integration` (`CATALOG_QUERY_TIMEOUT` en paridad SQL/oráculo; una prueba tardó ~520 s en el runner), sin cambios en consultas; intento 2 PASS completo (T06 y T10 incluidos).

## E3 real (FLOOD_WAIT) y Bot20 en producción — 2026-11-13 (autorización del propietario)
**E3 PASS (sandbox `testborrar`, preflight de aislamiento OK, solo-ledger):** ráfaga secuencial de archivos de 600 B con `floodSleepThreshold=0`. Telegram rechazó el envío nº 6 (5 aceptados en 1,7 s) con `FLOOD_WAIT_4`. El gateway lo clasificó `REJECTED` / `RETRY_SAME_IDENTITY_AFTER_WAIT`, `retryAfterMs=4000`, `effectPossible=false`; el rechazo **no dejó mensaje** (0 copias fantasma). Tras esperar 4 s + 1,5 s, el reintento con la **misma identidad** (mismo `random_id`) produjo exactamente 1 copia. Limpieza: 6 pedidos, 6 borrados, 6 ausentes verificados; los ids históricos 12–15 no se tocaron. Límite: solo se observó una espera corta (4 s); esperas largas (minutos) siguen sin medirse. Runner: `--only e3` (tope 60 envíos, espera ≤ 120 s); prueba offline añadida (T11 16/16).

**Bot20 y producción — NO CONFIRMADO.** Evidencia de repo/config (sin AWS): el pool de bots se carga desde `TRANSPORT_BOTS_FILE` (`transport-bots.local.json`, ignorado por git; nunca versionado) y `MANAGER_BOT_TOKEN_1` es de entorno; el despliegue de producción está en NO-GO (`TASK-5.2-AWS-PRODUCTION-CONTRACT.md`: «Release state: NO-GO»); el pool local contiene solo Bot20 (`managed:false`) y el sandbox usa chats con solo MASTER + Bot20. Nada del repo prueba ni descarta que el pool/registro de producción en AWS (o el inventario de GalerBotFactory vinculado al gestor `@beatgalerbot`) arriende Bot20 a algún vault. Demostrar la negativa exige leer la configuración/secretos de AWS o la DB de producción: **autorización específica pendiente**. E7 sigue sin ejecutarse.
