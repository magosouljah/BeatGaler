# Arquitectura — fuentes y decisiones

Este directorio contiene índices y arquitecturas canónicas aceptadas. No convertir experimentos en decisiones vigentes sin contrastar código, migraciones y tests.

- [Mapa técnico Web/Cloud](OVERVIEW.md).
- [ADR-0052: persistencia durable](../../docs/ADR-0052-DURABLE-DATA-ARCHITECTURE.md), aprobado históricamente; su estado «implementation not started / NO-GO» es de agosto, no una comprobación actual.
- [Threat model](../../docs/THREAT-MODEL-0052-DATA-PERSISTENCE.md) y [rollback de migración](../../docs/MIGRATION-0052-POSTGRES-ROLLBACK.md).
- [Billing V1](../BILLING/README.md) y [evidencias antiguas](../HISTORY/README.md).

Una arquitectura canónica nueva debe especificar autoridades, invariantes, flujos, fallos, recuperación, contratos y pruebas; aprobación explícita antes de adoptarla.
