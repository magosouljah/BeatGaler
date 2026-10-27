# Incidente EC2 de conectividad — 2026-10-27

**Estado:** servicio recuperado, causa raíz no confirmada, **en observación / diferido por decisión del responsable**. **No es bloqueo activo de beta.3 ni tarea inmediata**; reabrir si se repite o si aparecen nuevas evidencias.

## Alcance y versión protegida

- Web: `beatgaler.com`; Cloud: `api.beatgaler.com`; EC2 `i-0053e156e4646e799`, región `us-east-2`, tipo `t3.micro`.
- Elastic IP `3.150.163.160`; EBS raíz `vol-0f5b973b3987af96d` (`gp3`, 8 GiB).
- Código desplegado Web + Cloud: **`v0.9.0-beta.2`**, release SHA `a8418223527f88e9d34db8e05abb10216942013c`. Confirmado de nuevo mediante `/var/www/beatgaler-web/current/.well-known/source-sha.txt`.
- Incidente operativo; **no se actualizó producción, RDS, el release, ni el código**. Los cambios posteriores en `main` son independientes de la versión publicada.

## Síntomas y evidencia (27-10-2026, UTC)

1. Desde al menos **16:07 UTC** el servicio Cloud registró `Connection terminated due to connection timeout` en tareas de auth/delivery, errores de reconciliación de Polar y tareas de billing. Son síntomas de conectividad; no prueban una causa en la lógica de esos subsistemas.
2. **17:30 UTC**: `refresh-policy-routes@ens5.service` falla con código 1, tras `ec2net` intentar sin éxito obtener `device-number` desde IMDS. Hubo más fallos del mismo servicio.
3. Aproximadamente **18:39–20:10 UTC**: el agente SSM registra timeouts al solicitar credenciales e IMDSv2 (`169.254.169.254`), y `ec2net` no logra completar repetidamente consultas de metadatos; aparecen respuestas HTTP 401. Un 401 aislado puede indicar falta de token; la combinación de timeouts y reintentos es anormal. **No está demostrado que el fallo de refresh-policy-routes fuera el origen; podría ser consecuencia de otro problema anterior.**
4. Desde fuera, HTTP(S) no establecía conexión TCP; SSH agotaba el tiempo y SSM dejó de procesar Run Command. Las comprobaciones AWS de instancia, sistema y EBS seguían en `ok`.
5. Se creó el snapshot EBS **`snap-093fbea7b33d71148`**, completado. Un `reboot-instances` no recuperó el servicio. Un `stop/start` controlado sí recuperó Web, Cloud y SSM; Elastic IP conservada.
6. Tras la recuperación: `https://beatgaler.com/web-health` -> HTTP 200 (`ok`); `https://beatgaler.com/beatgaler-api/auth/health` -> HTTP 200. `https://api.beatgaler.com/health` devolvía 404 (`Cannot GET /health`): ruta no implementada, **no** prueba de fallo de API.
7. En el arranque recuperado se registró `vault_recovery_degraded` / `TELEGRAM_MESSAGE_MISSING` y el proceso Cloud continuó su inicialización. Esto concuerda con la reparación del manejo de mensajes faltantes; **no se encontró evidencia de que Telegram fuera la causa de la caída**.

## Exclusiones y límites de evidencia

- RDS `galer-cloud-prod`: `available`, sin eventos del período consultado; CPU media ~4%, conexiones 2–9, latencias de lectura/escritura generalmente ~1 ms o inferiores. La memoria liberable estuvo aprox. en 90–130 MB; no se diagnosticó saturación de RDS.
- EC2 después del arranque: disco 63% usado (aprox. 3 GiB libres), 913 MiB RAM, sin swap; no se hallaron eventos kernel OOM en el recorte revisado. **No** equivale a descartar episodios transitorios de presión de memoria durante el fallo.
- `amazon-ec2-net-utils-2.7.6-1.amzn2023.0.1.noarch`; `systemd-252.23-12.amzn2023.x86_64`. Tras recuperación IMDSv2 respondió HTTP 200 en <1 ms, `ens5` quedó `routable`, y contadores ENA de limitación examinados aparecieron en cero; son lecturas **posteriores** al reinicio, no evidencia de valores durante el incidente.
- **Hipótesis principal:** degradación de red / acceso a IMDS dentro de EC2. Causa inicial exacta **desconocida**. Evitar atribuciones definitivas a BeatGaler, a AWS, a `ec2net` o a un proveedor externo.
- Referencia externa para comparar, **no diagnóstico confirmado**: https://github.com/amazonlinux/amazon-ec2-net-utils/issues/129

## Decisión y reactivación

**Decisión 2026-10-27:** observar y continuar el roadmap Web + Cloud; no abrir corrección urgente, no configurar reinicios automáticos ni cambiar paquetes, red, IAM, producción o código solo por este episodio.

Si vuelve a suceder:

1. Registrar hora UTC y desde dónde fallan `/web-health`, el endpoint Cloud funcional, SSH y SSM; conservar respuesta, código y tiempos.
2. Antes de reiniciar, obtener métricas EC2/ENA de tráfico y límites, créditos, memoria si está instrumentada, journal y eventos de red/IMDS; comparar contra `systemd-networkd`, `ec2net`, `refresh-policy-routes@ens5` y RDS. Conservar los logs del **arranque correcto** (identificador, no asumir siempre `-1`/`-2`).
3. Considerar alarmas externas y métricas ENA/IMDS, actualización probada de `amazon-ec2-net-utils` y mitigación de memoria **solo en una tarea posterior autorizada y con rollback**.
4. Si es necesaria recuperación operativa, preservar evidencia/snapshot y pedir autorización de intervención. Verificar mismo SHA, Web, Cloud, PostgreSQL y SSM al finalizar.

**Política:** este documento es una anotación histórica y no una orden operativa. Para nuevos cambios o producción se requiere autorización independiente.
