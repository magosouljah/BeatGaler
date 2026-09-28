# Fase 2 — Task 2: puntero PostgreSQL del INDEX

## Corrida real

- Fecha: 2026-09-27
- Cuentas: cinco sesiones Web independientes.
- Web: build de producción servido con Vite preview.
- Cloud: proceso local administrado con PostgreSQL y migración `0014`.
- Evidencia: `tmp/phase2-task2/20260927-012103895/summary.json` y `attribution-raw.json`.

## Resultado

El Reload caliente usó el puntero en las cinco cuentas. No se observó
`getFullChat` ni `channels.getFullChannel` en la ruta de `get_index`.

| Métrica | Task 1 | Task 2 |
| --- | ---: | ---: |
| `get_index` p95 | 6862.6 ms | 11909.3 ms |
| `getFullChat` p95 | 6539 ms | no observado (0/5) |
| búsqueda directa por puntero p95 | no aplicaba | 10743 ms |

El objetivo `hot library p95 <= 5 s` no se cumple. La traza muestra que la
espera ahora está en `getMessages(chatId, index_message_id)`: 7661 ms, 1615
ms, 10743 ms, 5454 ms y 1617 ms. Las cuentas 01, 03 y 04 tuvieron una
reconexión MTProto durante esa lectura. No hubo reintentos explícitos de
`get_index` ni errores de cliente registrados.

## Garantías del puntero

`vault_index_pointers` contiene sólo un atajo por `vault_id`. El Worker
valida el documento INDEX obtenido dentro del `chat_id` de su sesión antes de
usarlo. Un compare-and-set, bajo bloqueo de la fila de vault, impide que un
writer que vio un valor antiguo retroceda el puntero. Telegram mantiene el pin
y el historial como mecanismos de reconstrucción.
