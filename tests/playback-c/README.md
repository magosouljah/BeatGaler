# Test C · `msgs_state_req` y escalones de `upload.getFile`

Test C reutiliza el harness directo A y añade probes dentro de su **worker aislado**. No carga navegador, React, MSE ni audio, ni edita `node_modules` o código de producción. La cuenta es `03`, el mensaje `96` y el archivo verificado es `Stage1 Playback v2 03.mp3` (17 136 bytes). Sesión y peer se preparan antes de `START`. Cada run inicia WARM `[96, 101]` 10 ms antes de `START` y consume el prefijo del batch, igual que en la comparación A/B. El target necesita un RPC físico en aproximadamente la mitad de los runs; el resto son hits de rango y se excluyen de la distribución principal.

Requiere `.env.stage1`, Cloud/PostgreSQL y FFmpeg como Test A. Ejecutar las series **secuencialmente** y usar directorios nuevos:

```powershell
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-c-mode observe --out tmp/playback-c/normal-01
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-c-mode observe --out tmp/playback-c/normal-02
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-c-mode observe --out tmp/playback-c/normal-03
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-c-mode observe --out tmp/playback-c/normal-04
```

Solo tras guardar la serie normal, las variantes experimentales cambian **únicamente** el `getStateSchedule` del RPC 96 en ese worker: `suppress` impide sus state checks; `early` adelanta el primero a 100 ms. No cambian los 2500 ms de timeout, la descarga, el RPC ni los demás mensajes.

```powershell
node scripts/run-playback-direct.mjs --runs 20 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-c-mode suppress --test-c-warm-timeout-ms 15000 --out tmp/playback-c/suppress-01
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-c-mode early --test-c-early-ms 100 --out tmp/playback-c/early-01
node tests/playback-c/report.mjs --normal tmp/playback-c/normal-01,tmp/playback-c/normal-02,tmp/playback-c/normal-03,tmp/playback-c/normal-04 --suppress tmp/playback-c/suppress-01 --early tmp/playback-c/early-01 --out tmp/playback-c/final
```

Control adicional de concurrencia, también aislado: repetir WARM solo con el mensaje 96 y sin el competidor 101. No se mezcla con las 200 observaciones normales; se informa aparte.

```powershell
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-lead-ms 10 --test-c-mode observe --out tmp/playback-c/solo-01
node tests/playback-c/report.mjs --normal tmp/playback-c/solo-01 --out tmp/playback-c/solo-report
```

Para comprobar que la diferencia no se debe solo al paso del tiempo, repetir una tanda corta con el competidor después del control solo:

```powershell
node scripts/run-playback-direct.mjs --runs 40 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --test-c-mode observe --out tmp/playback-c/normal-return-01
node tests/playback-c/report.mjs --normal tmp/playback-c/normal-return-01 --out tmp/playback-c/return-report
```

Cada serie escribe `trace.jsonl`, `summary.json`, `runs.csv` y `report.md`. El reporte de C genera `physical-rpcs.json`, `summary.json` y `RESULTS.md`; su distribución cuenta exclusivamente requests `upload.getFile` físicos del mensaje 96. El join usa el `msg_id` de mtcute, incluso si `msgs_state_info` llega después de que el harness pasó al siguiente run. `C_SERVER_ACK` significa `mt_msgs_ack` recibido; `_onMessageAcked` dentro de `rpc_result` se registra por separado y no se presenta como ACK previo.

Las ocho trazas observadas para [RESULTS.md](RESULTS.md) permanecen localmente como JSONL crudo comprimido en `traces/`, con hash SHA-256 del contenido descomprimido en `traces/manifest.json`; Git conserva sólo el resumen revisado. Las copias sin comprimir permanecen en `tmp/playback-c/<serie>/trace.jsonl`.

La serie `suppress` tiene 20 intentos porque la ausencia de state checks podría dejar un RPC pendiente. El límite de 15 s es solo del harness: después marca la observación como censurada y detiene su worker; no es un retry ni un timeout nuevo de mtcute. Si hay censuras, el proceso sale con código 1 y `summary.json` indica `PARTIAL`; es un resultado experimental esperado, no un fallo de instalación. Un `upload.getFile` cuya respuesta llegó antes de que fallase el WARM competidor sigue contando como RPC físico respondido.

`C_STATE_REQ_CONNECTION_SEND` marca la llamada de mtcute a su transporte; `C_STATE_REQ_WEBSOCKET_SEND` confirma que el paquete codificado alcanzó `WebSocket.send`. Los timestamps se comparan con el primer frame de respuesta **correlacionado** al RPC. La ausencia de `msgs_state_info` antes de `rpc_result` no permite saber si el servidor había generado la respuesta en ese instante. Los bytes de estado se decodifican según la [documentación oficial de mensajes de servicio MTProto](https://core.telegram.org/mtproto/service_messages_about_messages).
