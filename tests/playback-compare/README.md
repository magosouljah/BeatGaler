# Comparación Test A / Test B

Usa la misma cuenta 03, mensaje 96 (`Stage1 Playback v2 03.mp3`), sesión y peer preparados, WARM del mensaje 96 más el competidor 101 diez milisegundos antes de `START`. Los dos harnesses usan el worker y mtcute de producción. A adopta el prefijo de su batch WARM y termina en PCM/FFmpeg; B usa el source manager de producción y termina cuando `<audio>.currentTime >= 0.5` en Chrome headless. El tope del prefijo es 64 KiB; el archivo 96 entrega 17 136 bytes. No se cambia código de producción.

Requiere `.env.stage1`, Cloud/PostgreSQL, FFmpeg y Chrome tal como describen los README de ambos harnesses. Ejecutar **secuencialmente**, para que las series no compitan por las mismas sesiones/conexiones:

```powershell
node scripts/run-playback-direct.mjs --runs 100 --mode warm-adopt --route prefetch --warm-message-ids 101 --warm-lead-ms 10 --out tmp/playback-compare/a-warm-adopt-100
node scripts/run-playback-b.mjs --runs 100 --mode warm --warm-message-ids 101 --warm-lead-ms 10 --out tmp/playback-compare/b-warm-100
node tests/playback-compare/report.mjs tmp/playback-compare/a-warm-adopt-100 tmp/playback-compare/b-warm-100 tmp/playback-compare/final
```

El reporte genera `comparison.json` con los 200 runs y `RESULTS.md` con tabla y timelines completos. Los percentiles de `upload.getFile` incluyen solo runs con envío físico del mensaje 96 y respuesta correlacionada; los hits de caché no se tratan como RPC de duración cero. Un prefijo listo antes de `START` tiene espera observada de 0 ms; el desplazamiento negativo bruto también está en JSON. El tramo común termina al llegar el prefijo inicial útil, antes de FFmpeg o MSE.

Las marcas `WebSocket send→respuesta` delimitan la espera observable en el cliente. No distinguen tiempo de red, procesamiento Telegram, MTProto o transporte interno.
