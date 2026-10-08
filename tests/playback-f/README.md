# Test F · frontera de escritura MTProto

`@mtcute/core` conserva un `FramedWriter` por conexión. En `@fuman/io` 0.0.21, dos llamadas solapadas a `write()` podían codificar sobre el mismo `Bytes` antes de leerlo y vaciarlo. Test E confirmó que dos paquetes cifrados acababan en una sola llamada a `WebSocket.send()` y que ese caso coincidía con los tails de `upload.getFile`.

El parche versionado `patches/@fuman+io+0.0.21.patch` cambia las salidas ESM y CommonJS del writer: cada llamada crea su propio `Bytes`, espera el encode y entrega una copia `Uint8Array` con almacenamiento independiente. `postinstall` aplica el parche durante `npm ci`, también cuando se omiten dependencias de desarrollo. mtcute conserva la misma sesión, socket, cifrador CTR, política de recovery y RPC concurrentes. No se cambian timeouts, scheduler ni tamaño del prefijo.

## Regresión local

```powershell
npm ci
npm run test:playback:transport-boundary
```

`transport-boundary.test.mjs` usa un socket falso que captura `send()`. Solapa dos encodes con microtasks, prueba ambos órdenes de finalización y exige dos llamadas con tamaños y patrones exactos, buffers independientes y contenido estable tras mutar los payloads originales. No requiere Telegram ni sleeps. Sin el parche fallan las dos variantes en la aserción de una llamada `send()` por paquete; con él pasaron 25 ejecuciones consecutivas.

## Validación física

Con Cloud/PostgreSQL y `.env.stage1` preparados, ejecutar tandas **secuenciales** con directorios nuevos:

```powershell
node scripts/run-playback-direct.mjs --runs 50 --mode test-d-raw --test-d-mode observe --test-e-writer shared --test-e-message-ids 96,101 --out tmp/playback-f/e-prod-02
node tests/playback-f/analyze.mjs tmp/playback-f/e-prod-02 tmp/playback-f/e-prod-03 tmp/playback-f/e-prod-04 tmp/playback-f/e-prod-05
```

Repetir la primera línea con los otros tres directorios. `shared` significa que el harness deja en uso el writer instalado; no activa el reemplazo experimental `fresh` de Test E. `analyze.mjs` cuenta solo pares con ambos `rpc_result` correlacionados, dos paquetes separados, misma sesión/socket y ambos envíos anteriores a la primera respuesta. Falla si hay menos de 200 pares válidos, si los RPC dejan de ser concurrentes o si se juntan sus writes. Los directorios de salida y logs locales viven bajo `tmp/`.

## Transición de conexiones

La instalación del parche no modifica objetos `FramedWriter` ya cargados en procesos o pestañas abiertos. Al desplegar, reiniciar el proceso de la app y recargar una vez las pestañas Web activas; eso crea un Web Worker, `TelegramClient` y socket nuevos con el writer corregido. Los siguientes reconnects también recrean el writer. No hay reconexión por RPC ni reconexión periódica añadida. Una pestaña que permanezca con el bundle antiguo seguirá usando el writer antiguo hasta su recarga; esa recarga forma parte del rollout.

Ver [RESULTS.md](RESULTS.md) para los resultados y límites de esta implementación.
