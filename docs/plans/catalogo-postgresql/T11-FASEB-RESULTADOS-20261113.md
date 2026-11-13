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
