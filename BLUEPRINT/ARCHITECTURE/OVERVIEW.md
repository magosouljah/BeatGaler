# Mapa técnico — beta.2 Web + Cloud

Este es un **índice de lectura**, no una auditoría runtime nueva.

| Área | Contrato documentado | Verificar en |
| --- | --- | --- |
| Web | UI, biblioteca, reproducción, autenticación cliente | `src/` y tests Web |
| Cloud | Identidad, APIs, coordinación, autorización | `cloud-server/` |
| PostgreSQL | Control-plane durable, Access, cuota, reservas y Billing | migraciones, [ADR-0052](../../docs/ADR-0052-DURABLE-DATA-ARCHITECTURE.md) |
| Telegram / INDEX | Medios y biblioteca lógica, MASTER/Direct | código de transporte, tests y evidencia aislada |
| Billing | Checkout idempotente, webhooks, lifecycle, reconciliación | [documentos Billing](../BILLING/README.md) |
| Infraestructura | Nginx, despliegue, restore/rollback, alertas | [Operación](../OPERATIONS/README.md) |

Cuidado: el PROJECT Web documentó tránsito temporal de bytes por Cloud, aunque un contrato anterior decía «Cloud cero bytes». La evidencia Polar Sandbox no equivale a cobro live. Desktop está en pausa.
