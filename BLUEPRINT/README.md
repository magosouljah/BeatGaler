# BeatGaler — BLUEPRINT

> **Guía compacta de producto e ingeniería**, no calendario ni plan rígido. Un tema se planifica en detalle **solo cuando decidamos trabajarlo**. Evitar crear documentos nuevos por cada conversación, investigación o microtarea.

## Leer primero

- [Estado publicado](CURRENT-STATE.md) — qué release está en producción y qué está pendiente.
- [Guía flexible hacia V1 Web + Cloud](WORKPLAN.md) — calidad, landing, rendimiento, limpieza, escala, arquitectura INDEX/MASTER y marketing en paralelo.
- [Visión de producto](V1.md) — destino de BeatGaler, no certificación de funciones publicadas.
- [Método de cambios](SYSTEM.md) — pruebas, PR y protección de producción.
- [Roadmap resumido](ROADMAP.md) — dirección general, no fases obligatorias.

## Documentación especializada (consultar solo cuando haga falta)

- [Arquitectura](ARCHITECTURE/README.md).
- [Billing y reglas financieras](BILLING/README.md).
- [Operación e incidentes](OPERATIONS/README.md).
- [Historial de pruebas y decisiones](HISTORY/README.md); [gates antiguos](v1-gates/README.md) como **evidencia histórica**, nunca órdenes vigentes.

## Reglas

Preferir actualizar un documento canónico a multiplicar archivos. GitHub Issues/PRs/CI y el código real determinan el estado; conservar únicamente referencias técnicas/históricas que aporten trazabilidad. No hacer limpieza destructiva sin revisar enlaces, contratos ni evidencias.

**Release protegido:** `release/0.9.0-beta.2` @ `a8418223527f88e9d34db8e05abb10216942013c`. La prioridad es Web + Cloud; Desktop/Tauri está pausado. Marketing se desarrolla en el repositorio separado [MarketingBeatGaler](https://github.com/magosouljah/MarketingBeatGaler).
