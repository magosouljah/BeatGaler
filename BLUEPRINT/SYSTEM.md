# Método de desarrollo — BeatGaler

**Meta:** mejorar el producto publicado con cambios pequeños, auditables y reversibles.

## Fuentes de verdad

- [CURRENT-STATE.md](CURRENT-STATE.md): línea de base del release.
- [WORKPLAN.md](WORKPLAN.md): etapas globales.
- [V1.md](V1.md): visión, no lista de características certificadas.
- [ARCHITECTURE/](ARCHITECTURE/README.md): decisiones técnicas, revisables contra implementación.
- [BILLING/](BILLING/README.md): contratos de pagos y acceso.
- GitHub Issues/PRs/CI: trabajo y evidencia viva.
- Código, migraciones, tests y runtime: implementación efectiva.
- [HISTORY/](HISTORY/README.md): investigación histórica con fecha/SHA.

## Contrato mínimo de una tarea

**Problema → Objetivo → No romper → Punto de partida (SHA) → Prueba de cierre → Limpieza → PR.**

Antes de implementar: entender el riesgo y dependencias. Después: pruebas proporcionales, regresión de vecinos, revisión del diff y evidencia de lo no verificado.

## Protección del release

No hacer force-push ni implementar directamente sobre la referencia publicada `release/0.9.0-beta.2` @ `a8418223527f88e9d34db8e05abb10216942013c`. Separar local/staging/Sandbox/producción. No ejecutar cobros, migraciones productivas, cambios de AWS/Telegram, restauración ni despliegue sin autorización. No exponer secretos en documentación o logs.

## No crear burocracia

Sin handoffs perpetuos ni contadores paralelos a GitHub. Archivar evidencias antiguas, actualizar solo el documento pertinente. El método íntegro anterior se conserva en [HISTORY/LEGACY/SYSTEM.md](HISTORY/LEGACY/SYSTEM.md).
