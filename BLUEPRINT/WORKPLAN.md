# Plan de trabajo — posterior a beta.2

Prioridad: estabilizar la Web y Cloud publicadas sin modificar el commit estable. El trabajo concreto vive en GitHub Issues y PRs. **Desktop/Tauri suspendido.** Ninguna etapa implica despliegue automático a producción.

| # | Etapa | Criterio de cierre |
| --- | --- | --- |
| 1 | Ordenar GitHub | Revisar ramas/tags/releases, fijar `main` como referencia de desarrollo, resolver PRs pendientes y protecciones de rama |
| 2 | Preparar desarrollo local | Entorno Web/Cloud aislado, reproducible y sin usar la DB productiva para tests |
| 3 | Diagnóstico técnico | Auditar código y flujos Web/Cloud; reproducir y priorizar defectos reales |
| 4 | Corregir bugs | Reproducción, fix mínimo, pruebas de regresión y revisión de cada PR |
| 5 | Seguridad y dependencias | Verificar auth, aislamiento entre usuarios, Billing, secrets, permisos y CVEs; tratar riesgos confirmados |
| 6 | Limpiar código | Retirar duplicaciones, paths y compatibilidades muertas solo después de probar dependencias y contratos de datos |
| 7 | Fortalecer producción | Validar backups, restore/PITR, rollback, alertas, límites y procedimientos de recuperación con autorización separada |
| 8 | Cerrar estabilización | Matriz real de flujos Web/Cloud, pruebas de candidatos por SHA y riesgos abiertos/aceptados |
| 9 | Planificar beta.3 | Alcance acotado tras la estabilización, criterios de aceptación y decisión de publicación |
| 10 | Desarrollo y crecimiento | Entregas pequeñas, pruebas con usuarios, seguimiento y eventual vuelta a Desktop **solo si se autoriza** |

## Estado de avance al 27-10-2026

- **Etapa 1 avanzada:** GitHub y BLUEPRINT reorganizados; `main` ya es la rama predeterminada. No confundir organización con cierre de protección de ramas y revisión de pendientes.
- **Pendiente concreto:** [PR #145](https://github.com/magosouljah/BeatGaler/pull/145), limpieza residual del regalo automático de siete días de Paid Entry. En `main`, [PR #144](https://github.com/magosouljah/BeatGaler/pull/144) ya deshabilitó la emisión para cuentas nuevas; la limpieza posterior debe **conservar todos los beneficios históricos hasta el vencimiento**. El PR #145 debe revisarse y pasar sus tests antes de integrarlo; no desplegarlo automáticamente.
- **Riesgo de desarrollo abierto:** [Issue #133](https://github.com/magosouljah/BeatGaler/issues/133), aislar la base de datos de pruebas. Priorizar antes de correr pruebas peligrosas sobre datos persistentes.
- **Incidente de infraestructura del 27-10-2026:** [registro](OPERATIONS/INCIDENT-2026-10-27-EC2-NETWORK.md). Web/Cloud recuperados mediante stop/start; causa inicial aún no demostrada. **Decisión explícita: diferir / observar; no es tarea activa ni bloquea el siguiente trabajo.** Retomar solo si reaparece o surge evidencia nueva.
- **Release protegido:** `release/0.9.0-beta.2` @ `a8418223527f88e9d34db8e05abb10216942013c` sigue publicado. Cambios en `main` no equivalen a un despliegue.

## Secuencia práctica de los próximos trabajos

1. Resolver o cerrar con evidencia los PRs y asuntos de GitHub todavía abiertos; comenzar por revisar #145 sin tocar la emisión histórica ni producción.
2. Crear y verificar un entorno de pruebas aislado de RDS/producción; atender #133 antes de suites con escritura.
3. Ejecutar revisión técnica Web + Cloud en desarrollo: arranque, autenticación, Free/planes, biblioteca, búsqueda, reproducción, descargas, uploads, PROJECT, edición, Trash, Telegram/INDEX y recuperación.
4. Clasificar bugs reproducibles (severidad/impacto/riesgo); corregir en PRs pequeños con test previo y test de regresión.
5. Validar permisos, límites, aislamiento entre cuentas, pagos y suscripciones (sandbox y sin cobros no autorizados), secretos y dependencias.
6. Hacer limpieza limitada a código obsoleto demostrado; revisar rendimiento y estabilidad sin refactorizar por estética.
7. En una **etapa posterior autorizada**, revisar capacidad EC2/RDS, alarmas externas, backups restaurables y rollback. El incidente EC2 documentado permanece en observación, sin acción por ahora.
8. Cerrar un checklist de punta a punta para el mismo SHA candidato y registrar diferencias entre `main`, release y producción.
9. Decidir qué problemas justifican beta.3 y cuáles quedan fuera; definir gates y pruebas.
10. Desarrollar, validar en staging, pedir aprobación para publicar y observar el resultado; repetir iterativamente hasta decidir formalmente V1 Web + Cloud. Desktop permanece pausado.

Reglas: no mutar producción durante documentación/diagnóstico; no modificar código del release ni hacer force-push; usar rama/PR; probar según riesgo; registrar limitaciones de evidencia; autorización específica para pagos, infraestructura, datos o despliegues productivos.
