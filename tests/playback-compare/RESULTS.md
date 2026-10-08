# Test A vs Test B · cuenta 03, mensaje 96

Condición: sesión y peer preparados; WARM del 96 y competidor 101 iniciado 10 ms antes de START; tope de prefijo de 64 KiB (este archivo entrega 17 136 bytes); mismo worker de producción. A usa Worker Thread/Node y decodificación FFmpeg; B usa Web Worker/navegador, source manager, MSE y audio.

Los percentiles usan nearest rank. El tramo común es START→prefijo inicial útil del mensaje 96; se registra como 0 ms si el WARM lo completó antes de START. La métrica de red usa solo RPC físicos del 96 con send y respuesta correlacionados; los runs de caché sin RPC no entran en su percentil.

| Métrica | Test A | Test B |
|---|---:|---:|
| Runs válidos | 100/100 | 100/100 |
| START→prefijo p50 | 0 ms | 5.9 ms |
| START→prefijo p95 | 9182.8 ms | 6696.4 ms |
| START→prefijo max | 9367.5 ms | 6721 ms |
| START→prefijo ≥3 s | 24 | 16 |
| START→prefijo ≥6 s | 16 | 8 |
| RPC físicos target 96 (runs) | 50 | 50 |
| getMessages batch (runs) | 1 | 1 |
| Cache descriptor 96 (runs) | 99 | 99 |
| Cache rango 96 (runs) | 50 | 50 |
| Shared range 96 (runs) | 0 | 0 |
| Retry / error RPC 96 (runs) | 0/0 | 1/0 |
| Abort 96 (runs) | 0 | 0 |
| getFile WebSocket send→respuesta p95 | 9207.4 ms | 6696.5 ms |
| getFile WebSocket send→respuesta max | 9368.9 ms | 6705.4 ms |
| START→PCM / currentTime>=0.5s p50 | 154.5 ms | 827.5 ms |
| START→endpoint p95 | 9263.1 ms | 7503.9 ms |
| START→endpoint max | 9439.5 ms | 7521.3 ms |

En esta serie, A reprodujo 16 tails y B 8 tails ≥6 s hasta el prefijo. En todos ellos el RPC físico del mensaje 96 también tardó ≥6 s entre WebSocket send y el primer frame de respuesta correlacionado. Por tanto MSE/audio no son necesarios para que aparezca el tail. La frecuencia y p95 difieren entre las dos series secuenciales; esta muestra no permite atribuir esa diferencia al runtime Node o navegador.

Los 44 intentos anteriores de A usaron otras condiciones de WARM/repetición; esta comparación añade `warm-adopt` al harness A para consumir el prefijo del mismo batch previo al START, sin una segunda solicitud foreground. La espera de socket observada todavía engloba red, MTProto, Telegram y transporte: no localiza internamente cuál causó la pausa.

## Runs

| Test | Run | Estado | START→prefijo | getMessages | lane wait 96 | send→respuesta 96 | START→endpoint | RPC 96 | bytes prefijo | bytes red 96 | cache rango 96 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | warm-adopt-001 | OK | 274.9 | 113.9 | 0 | 162.4 | 350.1 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-002 | OK | 0 | — | 0 | — | 83.9 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-003 | OK | 86.7 | — | 0 | 88 | 165.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-004 | OK | 0 | — | 0 | — | 76.6 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-005 | OK | 166.6 | — | 0 | 166.5 | 233.6 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-006 | OK | 0 | — | 0 | — | 68.3 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-007 | OK | 1669.9 | — | 0 | 1668.6 | 1740.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-008 | OK | 0 | — | 0 | — | 176.4 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-009 | OK | 4195.8 | — | 0 | 4181.2 | 4264.4 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-010 | OK | 0 | — | 0 | — | 84.3 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-011 | OK | 6681.1 | — | 0 | 6688 | 6781.6 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-012 | OK | 0 | — | 0 | — | 119.2 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-013 | OK | 6728.9 | — | 0 | 6685.1 | 6800.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-014 | OK | 0 | — | 0 | — | 70.8 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-015 | OK | 79.4 | — | 0 | 86.3 | 154.5 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-016 | OK | 0 | — | 0 | — | 73.7 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-017 | OK | 98.1 | — | 0 | 97.7 | 171.7 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-018 | OK | 0 | — | 0 | — | 72.1 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-019 | OK | 1678 | — | 0 | 1680.4 | 1750.6 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-020 | OK | 0 | — | 0 | — | 72.2 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-021 | OK | 4161.3 | — | 0 | 4164.9 | 4238.9 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-022 | OK | 0 | — | 0 | — | 72.6 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-023 | OK | 6763.8 | — | 0 | 6768.4 | 6835.8 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-024 | OK | 0 | — | 0 | — | 74.7 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-025 | OK | 9367.5 | — | 0 | 9368.9 | 9439.5 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-026 | OK | 0 | — | 0 | — | 78.1 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-027 | OK | 84.8 | — | 0 | 86.7 | 168.2 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-028 | OK | 0 | — | 0 | — | 71.5 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-029 | OK | 89 | — | 0 | 96.1 | 162.4 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-030 | OK | 0 | — | 0 | — | 82.2 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-031 | OK | 1675.9 | — | 0 | 1661.2 | 1873.9 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-032 | OK | 0 | — | 0 | — | 100.3 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-033 | OK | 4182.7 | — | 0 | 4170.8 | 4365.7 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-034 | OK | 0 | — | 0 | — | 90.8 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-035 | OK | 6851.1 | — | 0 | 6851.9 | 7059.5 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-036 | OK | 0 | — | 0 | — | 73.7 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-037 | OK | 9200.6 | — | 0 | 9207.4 | 9422.4 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-038 | OK | 0 | — | 0 | — | 73.7 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-039 | OK | 81.9 | — | 0 | 83.6 | 156.5 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-040 | OK | 0 | — | 0 | — | 92.9 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-041 | OK | 117.5 | — | 0 | 118.9 | 195 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-042 | OK | 0 | — | 0 | — | 78.6 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-043 | OK | 1668.5 | — | 0 | 1677.7 | 1760 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-044 | OK | 0 | — | 0 | — | 76.1 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-045 | OK | 4176.7 | — | 0 | 4185.5 | 4263 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-046 | OK | 0 | — | 0 | — | 83.2 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-047 | OK | 6686.7 | — | 0 | 6695.5 | 6766.5 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-048 | OK | 0 | — | 0 | — | 80.9 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-049 | OK | 9182.6 | — | 0 | 9190.5 | 9256.7 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-050 | OK | 0 | — | 0 | — | 86.8 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-051 | OK | 270 | — | 0 | 270.7 | 382.5 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-052 | OK | 0 | — | 0 | — | 117.1 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-053 | OK | 107.7 | — | 0 | 114.4 | 220.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-054 | OK | 0 | — | 0 | — | 74.2 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-055 | OK | 1672.7 | — | 0 | 1669 | 1769.6 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-056 | OK | 0 | — | 0 | — | 74 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-057 | OK | 4172.6 | — | 0 | 4178 | 4245.9 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-058 | OK | 0 | — | 0 | — | 91.3 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-059 | OK | 6705.9 | — | 0 | 6694.3 | 6779.2 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-060 | OK | 0 | — | 0 | — | 71.9 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-061 | OK | 9210.4 | — | 0 | 9217 | 9285.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-062 | OK | 0 | — | 0 | — | 74.8 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-063 | OK | 74.4 | — | 0 | 83.3 | 154.7 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-064 | OK | 0 | — | 0 | — | 74.8 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-065 | OK | 130.9 | — | 0 | 132 | 203.4 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-066 | OK | 0 | — | 0 | — | 74.3 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-067 | OK | 1672.7 | — | 0 | 1675.5 | 1750.9 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-068 | OK | 0 | — | 0 | — | 81.4 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-069 | OK | 4165.8 | — | 0 | 4174.8 | 4241.9 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-070 | OK | 0 | — | 0 | — | 74.7 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-071 | OK | 6675.5 | — | 0 | 6677.8 | 6748.4 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-072 | OK | 0 | — | 0 | — | 74.9 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-073 | OK | 9195.6 | — | 0 | 9199.3 | 9269.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-074 | OK | 0 | — | 0 | — | 73.4 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-075 | OK | 84 | — | 2.5 | 85.9 | 159.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-076 | OK | 0 | — | 0 | — | 70.7 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-077 | OK | 111.4 | — | 0 | 116.4 | 184.6 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-078 | OK | 0 | — | 0 | — | 76 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-079 | OK | 1670.8 | — | 0 | 1675.7 | 1747.1 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-080 | OK | 0 | — | 0 | — | 76 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-081 | OK | 4166.3 | — | 0 | 4175.2 | 4243.8 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-082 | OK | 0 | — | 0 | — | 97.1 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-083 | OK | 6675.1 | — | 0 | 6682.3 | 6749.4 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-084 | OK | 0 | — | 0 | — | 72.9 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-085 | OK | 9195.7 | — | 0 | 9200.1 | 9278.7 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-086 | OK | 0 | — | 0 | — | 73.9 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-087 | OK | 159.6 | — | 0 | 164.5 | 288.4 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-088 | OK | 0 | — | 0 | — | 91.7 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-089 | OK | 241.5 | — | 0 | 173 | 328.4 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-090 | OK | 0 | — | 0 | — | 113.5 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-091 | OK | 1672 | — | 0 | 1672.6 | 1775.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-092 | OK | 0 | — | 0 | — | 87.6 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-093 | OK | 4194.7 | — | 0 | 4194.4 | 4292.3 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-094 | OK | 0 | — | 0 | — | 87.4 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-095 | OK | 6673.2 | — | 0 | 6676.3 | 6752.8 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-096 | OK | 0 | — | 0 | — | 84.3 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-097 | OK | 9182.8 | — | 0 | 9191.1 | 9263.1 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-098 | OK | 0 | — | 0 | — | 77.2 | 0 | 17136 | 0 | 1 |
| A | warm-adopt-099 | OK | 198.4 | — | 0 | 200.1 | 273.9 | 1 | 17136 | 17136 | 0 |
| A | warm-adopt-100 | OK | 0 | — | 0 | — | 77.5 | 0 | 17136 | 0 | 1 |
| B | warm-001 | OK | 286.4 | 99.9 | 0.1 | 164.4 | 1090.8 | 1 | 17136 | 17136 | 0 |
| B | warm-002 | OK | 2 | — | 0 | — | 802.2 | 0 | 17136 | 0 | 1 |
| B | warm-003 | OK | 174.3 | — | 0.1 | 163.8 | 968.1 | 1 | 17136 | 17136 | 0 |
| B | warm-004 | OK | 0 | — | 0 | — | 808.1 | 0 | 17136 | 0 | 1 |
| B | warm-005 | OK | 268.1 | — | 0 | 255.3 | 1067.6 | 1 | 17136 | 17136 | 0 |
| B | warm-006 | OK | 0 | — | 0 | — | 798.1 | 0 | 17136 | 0 | 1 |
| B | warm-007 | OK | 1667.1 | — | 0 | 1659.4 | 2470 | 1 | 17136 | 17136 | 0 |
| B | warm-008 | OK | 0 | — | 0 | — | 793.4 | 0 | 17136 | 0 | 1 |
| B | warm-009 | OK | 4038 | — | 0 | 4030 | 4832 | 1 | 17136 | 17136 | 0 |
| B | warm-010 | OK | 0 | — | 0 | — | 807.6 | 0 | 17136 | 0 | 1 |
| B | warm-011 | OK | 6687.2 | — | 0 | 6678 | 7487.6 | 1 | 17136 | 17136 | 0 |
| B | warm-012 | OK | 0.8 | — | 0 | — | 796.1 | 0 | 17136 | 0 | 1 |
| B | warm-013 | OK | 178.7 | — | 0 | 170.7 | 969.8 | 1 | 17136 | 17136 | 0 |
| B | warm-014 | OK | 0 | — | 0 | — | 794.5 | 0 | 17136 | 0 | 1 |
| B | warm-015 | OK | 181.1 | — | 0 | 170.7 | 982.9 | 1 | 17136 | 17136 | 0 |
| B | warm-016 | OK | 0 | — | 0 | — | 791.5 | 0 | 17136 | 0 | 1 |
| B | warm-017 | OK | 1687.7 | — | 0 | 1676.4 | 2479.9 | 1 | 17136 | 17136 | 0 |
| B | warm-018 | OK | 1.2 | — | 0 | — | 795.2 | 0 | 17136 | 0 | 1 |
| B | warm-019 | OK | 2777 | — | 0 | 2768.2 | 3573.2 | 1 | 17136 | 17136 | 0 |
| B | warm-020 | OK | 0 | — | 0 | — | 806 | 0 | 17136 | 0 | 1 |
| B | warm-021 | OK | 4188.7 | — | 0.1 | 4175.8 | 4988 | 1 | 17136 | 17136 | 0 |
| B | warm-022 | OK | 0 | — | 0 | — | 799.3 | 0 | 17136 | 0 | 1 |
| B | warm-023 | OK | 171.9 | — | 0 | 162.8 | 969 | 1 | 17136 | 17136 | 0 |
| B | warm-024 | OK | 0 | — | 0 | — | 805.9 | 0 | 17136 | 0 | 1 |
| B | warm-025 | OK | 203.6 | — | 0 | 189.2 | 1002.3 | 1 | 17136 | 17136 | 0 |
| B | warm-026 | OK | 0 | — | 0 | — | 798.5 | 0 | 17136 | 0 | 1 |
| B | warm-027 | OK | 1731.4 | — | 0 | 1727.2 | 2529.7 | 1 | 17136 | 17136 | 0 |
| B | warm-028 | OK | 0 | — | 0 | — | 801.8 | 0 | 17136 | 0 | 1 |
| B | warm-029 | OK | 2846.6 | — | 0 | 2833.8 | 3646.4 | 1 | 17136 | 17136 | 0 |
| B | warm-030 | OK | 2.4 | — | 0 | — | 810.8 | 0 | 17136 | 0 | 1 |
| B | warm-031 | OK | 6700.6 | — | 0 | 6694.9 | 7494.5 | 1 | 17136 | 17136 | 0 |
| B | warm-032 | OK | 2.1 | — | 0 | — | 807.8 | 0 | 17136 | 0 | 1 |
| B | warm-033 | OK | 2089.3 | — | 0.2 | 2080.6 | 2891 | 2 | 17136 | 17136 | 0 |
| B | warm-034 | OK | 0 | — | 0 | — | 795.9 | 0 | 17136 | 0 | 1 |
| B | warm-035 | OK | 171.7 | — | 0 | 163.2 | 971 | 1 | 17136 | 17136 | 0 |
| B | warm-036 | OK | 0 | — | 0 | — | 791.8 | 0 | 17136 | 0 | 1 |
| B | warm-037 | OK | 203.6 | — | 0 | 189 | 999.4 | 1 | 17136 | 17136 | 0 |
| B | warm-038 | OK | 2.4 | — | 0 | — | 812.4 | 0 | 17136 | 0 | 1 |
| B | warm-039 | OK | 1699.7 | — | 0 | 1677.8 | 2509.9 | 1 | 17136 | 17136 | 0 |
| B | warm-040 | OK | 1.1 | — | 0 | — | 799.8 | 0 | 17136 | 0 | 1 |
| B | warm-041 | OK | 4059.8 | — | 0 | 4040.7 | 4868.2 | 1 | 17136 | 17136 | 0 |
| B | warm-042 | OK | 1.8 | — | 0 | — | 812.6 | 0 | 17136 | 0 | 1 |
| B | warm-043 | OK | 6721 | — | 0 | 6705.4 | 7521.3 | 1 | 17136 | 17136 | 0 |
| B | warm-044 | OK | 0 | — | 0 | — | 794.8 | 0 | 17136 | 0 | 1 |
| B | warm-045 | OK | 190.3 | — | 0 | 175.8 | 996.7 | 1 | 17136 | 17136 | 0 |
| B | warm-046 | OK | 0 | — | 0 | — | 801.7 | 0 | 17136 | 0 | 1 |
| B | warm-047 | OK | 186.4 | — | 0 | 175.3 | 989.9 | 1 | 17136 | 17136 | 0 |
| B | warm-048 | OK | 0 | — | 0 | — | 792.2 | 0 | 17136 | 0 | 1 |
| B | warm-049 | OK | 1686.2 | — | 0 | 1666.8 | 2493.3 | 1 | 17136 | 17136 | 0 |
| B | warm-050 | OK | 0 | — | 0 | — | 794.9 | 0 | 17136 | 0 | 1 |
| B | warm-051 | OK | 4082.7 | — | 0 | 4070.1 | 4891.7 | 1 | 17136 | 17136 | 0 |
| B | warm-052 | OK | 2 | — | 0 | — | 800.4 | 0 | 17136 | 0 | 1 |
| B | warm-053 | OK | 6696.4 | — | 0 | 6681.2 | 7503.9 | 1 | 17136 | 17136 | 0 |
| B | warm-054 | OK | 1.4 | — | 0 | — | 819.8 | 0 | 17136 | 0 | 1 |
| B | warm-055 | OK | 172.5 | — | 0.1 | 163.8 | 968.8 | 1 | 17136 | 17136 | 0 |
| B | warm-056 | OK | 4.6 | — | 0 | — | 811.6 | 0 | 17136 | 0 | 1 |
| B | warm-057 | OK | 187 | — | 0 | 175.7 | 989.6 | 1 | 17136 | 17136 | 0 |
| B | warm-058 | OK | 2.4 | — | 0 | — | 814.1 | 0 | 17136 | 0 | 1 |
| B | warm-059 | OK | 1695.6 | — | 0 | 1678.5 | 2492.7 | 1 | 17136 | 17136 | 0 |
| B | warm-060 | OK | 0 | — | 0 | — | 794.9 | 0 | 17136 | 0 | 1 |
| B | warm-061 | OK | 4065.6 | — | 0 | 4055.2 | 4862 | 1 | 17136 | 17136 | 0 |
| B | warm-062 | OK | 4.5 | — | 0 | — | 811.5 | 0 | 17136 | 0 | 1 |
| B | warm-063 | OK | 6703.1 | — | 0 | 6694.7 | 7506.4 | 1 | 17136 | 17136 | 0 |
| B | warm-064 | OK | 3.1 | — | 0 | — | 801.6 | 0 | 17136 | 0 | 1 |
| B | warm-065 | OK | 171 | — | 0 | 161 | 985.6 | 1 | 17136 | 17136 | 0 |
| B | warm-066 | OK | 4.8 | — | 0 | — | 820.5 | 0 | 17136 | 0 | 1 |
| B | warm-067 | OK | 189.7 | — | 0 | 177 | 990.9 | 1 | 17136 | 17136 | 0 |
| B | warm-068 | OK | 0 | — | 0 | — | 803.7 | 0 | 17136 | 0 | 1 |
| B | warm-069 | OK | 1690.2 | — | 0 | 1681.4 | 2492.6 | 1 | 17136 | 17136 | 0 |
| B | warm-070 | OK | 0 | — | 0 | — | 795.4 | 0 | 17136 | 0 | 1 |
| B | warm-071 | OK | 4066.7 | — | 0 | 4056.6 | 4874.2 | 1 | 17136 | 17136 | 0 |
| B | warm-072 | OK | 0 | — | 0 | — | 800.7 | 0 | 17136 | 0 | 1 |
| B | warm-073 | OK | 6710.3 | — | 0 | 6696.5 | 7519.8 | 1 | 17136 | 17136 | 0 |
| B | warm-074 | OK | 5.6 | — | 0 | — | 805.2 | 0 | 17136 | 0 | 1 |
| B | warm-075 | OK | 182.7 | — | 0 | 166.6 | 977.9 | 1 | 17136 | 17136 | 0 |
| B | warm-076 | OK | 0 | — | 0 | — | 815.1 | 0 | 17136 | 0 | 1 |
| B | warm-077 | OK | 182.9 | — | 0 | 169 | 980.2 | 1 | 17136 | 17136 | 0 |
| B | warm-078 | OK | 3.2 | — | 0 | — | 814.6 | 0 | 17136 | 0 | 1 |
| B | warm-079 | OK | 1696.3 | — | 0 | 1677 | 2499.1 | 1 | 17136 | 17136 | 0 |
| B | warm-080 | OK | 0 | — | 0 | — | 800.1 | 0 | 17136 | 0 | 1 |
| B | warm-081 | OK | 4050.6 | — | 0 | 4039.6 | 4858.3 | 1 | 17136 | 17136 | 0 |
| B | warm-082 | OK | 2.4 | — | 0 | — | 813.5 | 0 | 17136 | 0 | 1 |
| B | warm-083 | OK | 6712.9 | — | 0 | 6697.2 | 7515.2 | 1 | 17136 | 17136 | 0 |
| B | warm-084 | OK | 1.4 | — | 0 | — | 798.4 | 0 | 17136 | 0 | 1 |
| B | warm-085 | OK | 190.9 | — | 0 | 174.2 | 997.6 | 1 | 17136 | 17136 | 0 |
| B | warm-086 | OK | 0 | — | 0 | — | 796.2 | 0 | 17136 | 0 | 1 |
| B | warm-087 | OK | 219.2 | — | 0.1 | 197.8 | 1021.3 | 1 | 17136 | 17136 | 0 |
| B | warm-088 | OK | 0 | — | 0 | — | 801 | 0 | 17136 | 0 | 1 |
| B | warm-089 | OK | 1689.6 | — | 0 | 1677.7 | 2513.1 | 1 | 17136 | 17136 | 0 |
| B | warm-090 | OK | 5.9 | — | 0 | — | 805.8 | 0 | 17136 | 0 | 1 |
| B | warm-091 | OK | 4066.1 | — | 0 | 4049.2 | 4881.4 | 1 | 17136 | 17136 | 0 |
| B | warm-092 | OK | 2.6 | — | 0 | — | 806.6 | 0 | 17136 | 0 | 1 |
| B | warm-093 | OK | 6694.5 | — | 0.1 | 6679 | 7506 | 1 | 17136 | 17136 | 0 |
| B | warm-094 | OK | 1.1 | — | 0 | — | 811.7 | 0 | 17136 | 0 | 1 |
| B | warm-095 | OK | 174.6 | — | 0 | 165.8 | 973.3 | 1 | 17136 | 17136 | 0 |
| B | warm-096 | OK | 1 | — | 0 | — | 804.2 | 0 | 17136 | 0 | 1 |
| B | warm-097 | OK | 186.5 | — | 0 | 173.8 | 975.9 | 1 | 17136 | 17136 | 0 |
| B | warm-098 | OK | 2 | — | 0 | — | 808.2 | 0 | 17136 | 0 | 1 |
| B | warm-099 | OK | 1692.7 | — | 0 | 1675.6 | 2497.2 | 1 | 17136 | 17136 | 0 |
| B | warm-100 | OK | 5 | — | 0 | — | 827.5 | 0 | 17136 | 0 | 1 |

## Tails ≥6 s (tramo común, RPC 96 o endpoint)

| Test / run | send 96 | primer frame 96 | prefijo | MSE primer rango | playing | endpoint |
|---|---:|---:|---:|---:|---:|---:|
| A warm-adopt-011 | -11.1 | 6676.9 | 6681.1 | — | — | 6781.6 |
| A warm-adopt-013 | 40.1 | 6725.2 | 6728.9 | — | — | 6800.3 |
| A warm-adopt-023 | -8.3 | 6760.1 | 6763.8 | — | — | 6835.8 |
| A warm-adopt-025 | -5.1 | 9363.8 | 9367.5 | — | — | 9439.5 |
| A warm-adopt-035 | -10 | 6841.9 | 6851.1 | — | — | 7059.5 |
| A warm-adopt-037 | -11.3 | 9196.1 | 9200.6 | — | — | 9422.4 |
| A warm-adopt-047 | -12.8 | 6682.7 | 6686.7 | — | — | 6766.5 |
| A warm-adopt-049 | -12.1 | 9178.4 | 9182.6 | — | — | 9256.7 |
| A warm-adopt-059 | 8.2 | 6702.5 | 6705.9 | — | — | 6779.2 |
| A warm-adopt-061 | -12.5 | 9204.5 | 9210.4 | — | — | 9285.3 |
| A warm-adopt-071 | -6.3 | 6671.5 | 6675.5 | — | — | 6748.4 |
| A warm-adopt-073 | -7 | 9192.3 | 9195.6 | — | — | 9269.3 |
| A warm-adopt-083 | -11 | 6671.3 | 6675.1 | — | — | 6749.4 |
| A warm-adopt-085 | -8 | 9192.1 | 9195.7 | — | — | 9278.7 |
| A warm-adopt-095 | -6.7 | 6669.6 | 6673.2 | — | — | 6752.8 |
| A warm-adopt-097 | -11.6 | 9179.5 | 9182.8 | — | — | 9263.1 |
| B warm-011 | 5.6 | 6683.6 | 6687.2 | 6691.8 | 6704.5 | 7487.6 |
| B warm-031 | 1 | 6695.9 | 6700.6 | 6705.8 | 6717.2 | 7494.5 |
| B warm-043 | 6 | 6711.4 | 6721 | 6732.8 | 6753.6 | 7521.3 |
| B warm-053 | 6.2 | 6687.4 | 6696.4 | 6711.4 | 6728.8 | 7503.9 |
| B warm-063 | 3.5 | 6698.2 | 6703.1 | 6716 | 6737.1 | 7506.4 |
| B warm-073 | 4.4 | 6700.9 | 6710.3 | 6729.2 | 6745.3 | 7519.8 |
| B warm-083 | 8.6 | 6705.8 | 6712.9 | 6726.4 | 6749.4 | 7515.2 |
| B warm-093 | 7.4 | 6686.4 | 6694.5 | 6719.1 | 6739 | 7506 |

En estos 24 tails: getMessages 0, retries del RPC 96 0, aborts del 96 0, reconexiones antes de la respuesta del 96 0; espera de lane máxima 0.1 ms.

### A warm-adopt-011

START→prefijo 6681.1 ms; send→respuesta 96 6688 ms; START→PCM 6781.6 ms.

- -15.3 ms · WARM_BATCH_BEGIN
- -14.8 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -14.3 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -11.1 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +6678.6 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6676.9 ms
- +6680.7 ms · FIRST_BYTES · 17136 bytes
- +6681.1 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6681.8 ms · CONSUMER_BEGIN · 17136 bytes
- +6781.6 ms · CONSUMER_END
- +18570 ms · END

### A warm-adopt-013

START→prefijo 6728.9 ms; send→respuesta 96 6685.1 ms; START→PCM 6800.3 ms.

- -17.1 ms · WARM_BATCH_BEGIN
- +0 ms · START · mensaje 96
- +6.1 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- +8 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +40.1 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +6726.5 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6725.2 ms
- +6728.7 ms · FIRST_BYTES · 17136 bytes
- +6728.9 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6729.3 ms · CONSUMER_BEGIN · 17136 bytes
- +6800.3 ms · CONSUMER_END
- +12139.2 ms · END

### A warm-adopt-023

START→prefijo 6763.8 ms; send→respuesta 96 6768.4 ms; START→PCM 6835.8 ms.

- -10.3 ms · WARM_BATCH_BEGIN
- -10 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -9.7 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -8.3 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +6761.5 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6760.1 ms
- +6763.6 ms · FIRST_BYTES · 17136 bytes
- +6763.8 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6764.2 ms · CONSUMER_BEGIN · 17136 bytes
- +6835.8 ms · CONSUMER_END
- +18708.1 ms · END

### A warm-adopt-025

START→prefijo 9367.5 ms; send→respuesta 96 9368.9 ms; START→PCM 9439.5 ms.

- -12.7 ms · WARM_BATCH_BEGIN
- -11.3 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -8.2 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -5.1 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +9365.3 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +9363.8 ms
- +9367.3 ms · FIRST_BYTES · 17136 bytes
- +9367.5 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +9367.9 ms · CONSUMER_BEGIN · 17136 bytes
- +9439.5 ms · CONSUMER_END
- +19203.2 ms · END

### A warm-adopt-035

START→prefijo 6851.1 ms; send→respuesta 96 6851.9 ms; START→PCM 7059.5 ms.

- -15.4 ms · WARM_BATCH_BEGIN
- -15 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -14.6 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -10 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +6844.6 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6841.9 ms
- +6850.6 ms · FIRST_BYTES · 17136 bytes
- +6851.1 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6851.8 ms · CONSUMER_BEGIN · 17136 bytes
- +7059.5 ms · CONSUMER_END
- +18879.8 ms · END

### A warm-adopt-037

START→prefijo 9200.6 ms; send→respuesta 96 9207.4 ms; START→PCM 9422.4 ms.

- -15.1 ms · WARM_BATCH_BEGIN
- -14.6 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -13.7 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -11.3 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +9198.1 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +9196.1 ms
- +9200.3 ms · FIRST_BYTES · 17136 bytes
- +9200.6 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +9201.4 ms · CONSUMER_BEGIN · 17136 bytes
- +9422.4 ms · CONSUMER_END
- +18882.6 ms · END

### A warm-adopt-047

START→prefijo 6686.7 ms; send→respuesta 96 6695.5 ms; START→PCM 6766.5 ms.

- -15.5 ms · WARM_BATCH_BEGIN
- -14.8 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -14.4 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -12.8 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +6684 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6682.7 ms
- +6686.4 ms · FIRST_BYTES · 17136 bytes
- +6686.7 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6687.2 ms · CONSUMER_BEGIN · 17136 bytes
- +6766.5 ms · CONSUMER_END
- +18572.7 ms · END

### A warm-adopt-049

START→prefijo 9182.6 ms; send→respuesta 96 9190.5 ms; START→PCM 9256.7 ms.

- -15.5 ms · WARM_BATCH_BEGIN
- -14.9 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -14.2 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -12.1 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +9180.1 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +9178.4 ms
- +9182.3 ms · FIRST_BYTES · 17136 bytes
- +9182.6 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +9183 ms · CONSUMER_BEGIN · 17136 bytes
- +9256.7 ms · CONSUMER_END
- +19354.8 ms · END

### A warm-adopt-059

START→prefijo 6705.9 ms; send→respuesta 96 6694.3 ms; START→PCM 6779.2 ms.

- -8.6 ms · WARM_BATCH_BEGIN
- +0 ms · START · mensaje 96
- +1.3 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- +2.1 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +8.2 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +6703.8 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6702.5 ms
- +6705.5 ms · FIRST_BYTES · 17136 bytes
- +6705.9 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6706.4 ms · CONSUMER_BEGIN · 17136 bytes
- +6779.2 ms · CONSUMER_END
- +18565.1 ms · END

### A warm-adopt-061

START→prefijo 9210.4 ms; send→respuesta 96 9217 ms; START→PCM 9285.3 ms.

- -15.3 ms · WARM_BATCH_BEGIN
- -14.8 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -14.3 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -12.5 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +9205.8 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +9204.5 ms
- +9210.1 ms · FIRST_BYTES · 17136 bytes
- +9210.4 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +9211.6 ms · CONSUMER_BEGIN · 17136 bytes
- +9285.3 ms · CONSUMER_END
- +18992.7 ms · END

### A warm-adopt-071

START→prefijo 6675.5 ms; send→respuesta 96 6677.8 ms; START→PCM 6748.4 ms.

- -9.9 ms · WARM_BATCH_BEGIN
- -8.9 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -8.4 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -6.3 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +6673.4 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6671.5 ms
- +6675.3 ms · FIRST_BYTES · 17136 bytes
- +6675.5 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6676.4 ms · CONSUMER_BEGIN · 17136 bytes
- +6748.4 ms · CONSUMER_END
- +18555.8 ms · END

### A warm-adopt-073

START→prefijo 9195.6 ms; send→respuesta 96 9199.3 ms; START→PCM 9269.3 ms.

- -9.7 ms · WARM_BATCH_BEGIN
- -9.2 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -8.8 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -7 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +9193.5 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +9192.3 ms
- +9195.4 ms · FIRST_BYTES · 17136 bytes
- +9195.6 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +9196.3 ms · CONSUMER_BEGIN · 17136 bytes
- +9269.3 ms · CONSUMER_END
- +19439.8 ms · END

### A warm-adopt-083

START→prefijo 6675.1 ms; send→respuesta 96 6682.3 ms; START→PCM 6749.4 ms.

- -14.3 ms · WARM_BATCH_BEGIN
- -13.3 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -12.7 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -11 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +6672.7 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6671.3 ms
- +6674.9 ms · FIRST_BYTES · 17136 bytes
- +6675.1 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6676.2 ms · CONSUMER_BEGIN · 17136 bytes
- +6749.4 ms · CONSUMER_END
- +18635.5 ms · END

### A warm-adopt-085

START→prefijo 9195.7 ms; send→respuesta 96 9200.1 ms; START→PCM 9278.7 ms.

- -10 ms · WARM_BATCH_BEGIN
- -9.6 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -9.2 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -8 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +9193.6 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +9192.1 ms
- +9195.4 ms · FIRST_BYTES · 17136 bytes
- +9195.7 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +9196.3 ms · CONSUMER_BEGIN · 17136 bytes
- +9278.7 ms · CONSUMER_END
- +19452.1 ms · END

### A warm-adopt-095

START→prefijo 6673.2 ms; send→respuesta 96 6676.3 ms; START→PCM 6752.8 ms.

- -9 ms · WARM_BATCH_BEGIN
- -8.1 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -7.7 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -6.7 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +6671 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6669.6 ms
- +6672.9 ms · FIRST_BYTES · 17136 bytes
- +6673.2 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +6674.2 ms · CONSUMER_BEGIN · 17136 bytes
- +6752.8 ms · CONSUMER_END
- +18553.4 ms · END

### A warm-adopt-097

START→prefijo 9182.8 ms; send→respuesta 96 9191.1 ms; START→PCM 9263.1 ms.

- -14.4 ms · WARM_BATCH_BEGIN
- -13.8 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -13.3 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- -11.6 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +0 ms · START · mensaje 96
- +9180.6 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +9179.5 ms
- +9182.6 ms · FIRST_BYTES · 17136 bytes
- +9182.8 ms · FIRST_USEFUL_RANGE · 17136 bytes
- +9183.8 ms · CONSUMER_BEGIN · 17136 bytes
- +9263.1 ms · CONSUMER_END
- +18819.7 ms · END

### B warm-011

START→prefijo 6687.2 ms; send→respuesta 96 6678 ms; START→currentTime>=0.5s 7487.6 ms.

- -10 ms · TRANSPORT_PREFETCH_BATCH_ENTER
- -7.5 ms · WARM_BATCH_BEGIN
- -2.9 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -0.5 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +0 ms · START
- +5.6 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +12.1 ms · PLAY_WARM_ADOPTED · mensaje 96
- +6684.6 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6683.6 ms
- +6687.2 ms · WARM_PREFIX_READY · mensaje 96 · 17136 bytes
- +6688.3 ms · SOURCE_PREPARE_RETURN
- +6688.7 ms · AUDIO_PLAY_CALL
- +6690.7 ms · SOURCE_MSE_SOURCEOPEN · mensaje 96
- +6691.7 ms · SOURCE_MSE_APPEND_DONE · mensaje 96 · 17136 bytes
- +6691.8 ms · SOURCE_FIRST_PLAYABLE_RANGE · mensaje 96
- +6704.5 ms · AUDIO_EVENT_PLAYING
- +6955.7 ms · AUDIO_FIRST_PROGRESS
- +7487.6 ms · AUDIO_HALF_SECOND

### B warm-031

START→prefijo 6700.6 ms; send→respuesta 96 6694.9 ms; START→currentTime>=0.5s 7494.5 ms.

- -10 ms · TRANSPORT_PREFETCH_BATCH_ENTER
- -8.3 ms · WARM_BATCH_BEGIN
- -4.9 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -3 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +0 ms · START
- +1 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +6.8 ms · PLAY_WARM_ADOPTED · mensaje 96
- +6698.1 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6695.9 ms
- +6701 ms · WARM_PREFIX_READY · mensaje 96 · 17136 bytes
- +6702.4 ms · SOURCE_PREPARE_RETURN
- +6702.6 ms · AUDIO_PLAY_CALL
- +6704.7 ms · SOURCE_MSE_SOURCEOPEN · mensaje 96
- +6705.6 ms · SOURCE_MSE_APPEND_DONE · mensaje 96 · 17136 bytes
- +6705.8 ms · SOURCE_FIRST_PLAYABLE_RANGE · mensaje 96
- +6717.2 ms · AUDIO_EVENT_PLAYING
- +6965.7 ms · AUDIO_FIRST_PROGRESS
- +7494.5 ms · AUDIO_HALF_SECOND

### B warm-043

START→prefijo 6721 ms; send→respuesta 96 6705.4 ms; START→currentTime>=0.5s 7521.3 ms.

- -10.1 ms · TRANSPORT_PREFETCH_BATCH_ENTER
- -8.6 ms · WARM_BATCH_BEGIN
- -2.6 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- +0 ms · START
- +1 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +6 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +8.8 ms · PLAY_WARM_ADOPTED · mensaje 96
- +6714 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6711.4 ms
- +6721 ms · WARM_PREFIX_READY · mensaje 96 · 17136 bytes
- +6723.5 ms · SOURCE_PREPARE_RETURN
- +6723.9 ms · AUDIO_PLAY_CALL
- +6730.6 ms · SOURCE_MSE_SOURCEOPEN · mensaje 96
- +6732.5 ms · SOURCE_MSE_APPEND_DONE · mensaje 96 · 17136 bytes
- +6732.8 ms · SOURCE_FIRST_PLAYABLE_RANGE · mensaje 96
- +6753.6 ms · AUDIO_EVENT_PLAYING
- +6988.3 ms · AUDIO_FIRST_PROGRESS
- +7521.3 ms · AUDIO_HALF_SECOND

### B warm-053

START→prefijo 6696.4 ms; send→respuesta 96 6681.2 ms; START→currentTime>=0.5s 7503.9 ms.

- -10 ms · TRANSPORT_PREFETCH_BATCH_ENTER
- -8.6 ms · WARM_BATCH_BEGIN
- -1.4 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- +0 ms · START
- +1.1 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +6.2 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +13.4 ms · PLAY_WARM_ADOPTED · mensaje 96
- +6691.5 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6687.4 ms
- +6696.4 ms · WARM_PREFIX_READY · mensaje 96 · 17136 bytes
- +6700.1 ms · SOURCE_PREPARE_RETURN
- +6700.7 ms · AUDIO_PLAY_CALL
- +6709 ms · SOURCE_MSE_SOURCEOPEN · mensaje 96
- +6711.1 ms · SOURCE_MSE_APPEND_DONE · mensaje 96 · 17136 bytes
- +6711.4 ms · SOURCE_FIRST_PLAYABLE_RANGE · mensaje 96
- +6728.8 ms · AUDIO_EVENT_PLAYING
- +6970.4 ms · AUDIO_FIRST_PROGRESS
- +7503.9 ms · AUDIO_HALF_SECOND

### B warm-063

START→prefijo 6703.1 ms; send→respuesta 96 6694.7 ms; START→currentTime>=0.5s 7506.4 ms.

- -9.9 ms · TRANSPORT_PREFETCH_BATCH_ENTER
- -9 ms · WARM_BATCH_BEGIN
- -5.9 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -3.5 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +0 ms · START
- +3.5 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +9.2 ms · PLAY_WARM_ADOPTED · mensaje 96
- +6700.1 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6698.2 ms
- +6703.1 ms · WARM_PREFIX_READY · mensaje 96 · 17136 bytes
- +6705.8 ms · SOURCE_PREPARE_RETURN
- +6706.3 ms · AUDIO_PLAY_CALL
- +6712.2 ms · SOURCE_MSE_SOURCEOPEN · mensaje 96
- +6715.4 ms · SOURCE_MSE_APPEND_DONE · mensaje 96 · 17136 bytes
- +6716 ms · SOURCE_FIRST_PLAYABLE_RANGE · mensaje 96
- +6737.1 ms · AUDIO_EVENT_PLAYING
- +6975.4 ms · AUDIO_FIRST_PROGRESS
- +7506.4 ms · AUDIO_HALF_SECOND

### B warm-073

START→prefijo 6710.3 ms; send→respuesta 96 6696.5 ms; START→currentTime>=0.5s 7519.8 ms.

- -9.6 ms · TRANSPORT_PREFETCH_BATCH_ENTER
- -7 ms · WARM_BATCH_BEGIN
- -4.2 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- -0.5 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +0 ms · START
- +4.4 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +9.5 ms · PLAY_WARM_ADOPTED · mensaje 96
- +6703.8 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6700.9 ms
- +6710.3 ms · WARM_PREFIX_READY · mensaje 96 · 17136 bytes
- +6713 ms · SOURCE_PREPARE_RETURN
- +6713.4 ms · AUDIO_PLAY_CALL
- +6726.9 ms · SOURCE_MSE_SOURCEOPEN · mensaje 96
- +6728.6 ms · SOURCE_MSE_APPEND_DONE · mensaje 96 · 17136 bytes
- +6729.2 ms · SOURCE_FIRST_PLAYABLE_RANGE · mensaje 96
- +6745.3 ms · AUDIO_EVENT_PLAYING
- +6986 ms · AUDIO_FIRST_PROGRESS
- +7519.8 ms · AUDIO_HALF_SECOND

### B warm-083

START→prefijo 6712.9 ms; send→respuesta 96 6697.2 ms; START→currentTime>=0.5s 7515.2 ms.

- -10 ms · TRANSPORT_PREFETCH_BATCH_ENTER
- -8.8 ms · WARM_BATCH_BEGIN
- -1.6 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- +0 ms · START
- +2.7 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +8.6 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +16.5 ms · PLAY_WARM_ADOPTED · mensaje 96
- +6707.9 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6705.8 ms
- +6712.9 ms · WARM_PREFIX_READY · mensaje 96 · 17136 bytes
- +6715.7 ms · SOURCE_PREPARE_RETURN
- +6716.4 ms · AUDIO_PLAY_CALL
- +6723.6 ms · SOURCE_MSE_SOURCEOPEN · mensaje 96
- +6726 ms · SOURCE_MSE_APPEND_DONE · mensaje 96 · 17136 bytes
- +6726.4 ms · SOURCE_FIRST_PLAYABLE_RANGE · mensaje 96
- +6749.4 ms · AUDIO_EVENT_PLAYING
- +6985.1 ms · AUDIO_FIRST_PROGRESS
- +7515.2 ms · AUDIO_HALF_SECOND

### B warm-093

START→prefijo 6694.5 ms; send→respuesta 96 6679 ms; START→currentTime>=0.5s 7506 ms.

- -9.9 ms · TRANSPORT_PREFETCH_BATCH_ENTER
- -5.5 ms · WARM_BATCH_BEGIN
- +0 ms · START
- +0.1 ms · WORKER_DATA_LANE_ACQUIRED · mensaje 96
- +2.9 ms · WORKER_GET_FILE_CALL_ENTER · mensaje 96
- +7.4 ms · WORKER_GET_FILE_WEBSOCKET_SEND_CALLED · mensaje 96
- +13.5 ms · PLAY_WARM_ADOPTED · mensaje 96
- +6689 ms · WORKER_GET_FILE_RPC_RESULT_ENTER · mensaje 96 · primer frame correlacionado +6686.4 ms
- +6694.5 ms · WARM_PREFIX_READY · mensaje 96 · 17136 bytes
- +6696.7 ms · SOURCE_PREPARE_RETURN
- +6697.1 ms · AUDIO_PLAY_CALL
- +6716.5 ms · SOURCE_MSE_SOURCEOPEN · mensaje 96
- +6718.7 ms · SOURCE_MSE_APPEND_DONE · mensaje 96 · 17136 bytes
- +6719.1 ms · SOURCE_FIRST_PLAYABLE_RANGE · mensaje 96
- +6739 ms · AUDIO_EVENT_PLAYING
- +6975.2 ms · AUDIO_FIRST_PROGRESS
- +7506 ms · AUDIO_HALF_SECOND
