# Plan de trabajo — posterior a beta.2

Prioridad: estabilizar la Web y Cloud publicadas sin modificar el commit estable. El trabajo concreto vive en GitHub Issues y PRs.

| # | Etapa | Criterio de cierre |
| --- | --- | --- |
| 1 | Ordenar GitHub | Revisar ramas/tags/releases, resolver default antigua y definir PRs/protecciones |
| 2 | Preparar desarrollo local | Entorno Web/Cloud aislado y reproducible en `E:\777\app\BeatGaler` |
| 3 | Diagnóstico técnico | Problemas priorizados y verificados contra el código |
| 4 | Corregir bugs | Reproducción, fix mínimo y regresiones |
| 5 | Seguridad y dependencias | Riesgos auth/tenancy/Billing/secrets/CVEs verificados y tratados |
| 6 | Limpiar código | Duplicaciones y paths muertos retirados tras comprobar dependencias |
| 7 | Fortalecer producción | Backups, restore/PITR, rollback, alertas, límites y operativa comprobados |
| 8 | Cerrar estabilización | Evidencia del SHA, matriz Web+Cloud y riesgos aceptados |
| 9 | Planificar beta.3 | Alcance acotado y criterios de aceptación |
| 10 | Desarrollo y crecimiento | Entregas pequeñas, observación real, iteración y eventual retorno a Desktop autorizado |

**Etapa activa: 1 — GitHub.** La reorganización de BLUEPRINT es su preparación.

Reglas: no mutar producción durante documentación/diagnóstico; no modificar código del release ni hacer force-push; usar rama/PR; probar según riesgo; registrar limitaciones de evidencia; autorización específica para pagos, infraestructura, datos o despliegues productivos.
