# Dirección de BeatGaler hacia V1 — Web + Cloud

> **Stupid Simple** para usuarios, frontend y backend. **Dirección, no calendario, backlog, fases ni compromisos de entrega.**

BeatGaler debe hacer simples y fiables los flujos **encontrar → escuchar → descargar** y **subir → describir/editar → organizar → recuperar** beats y proyectos. Primero no perder ni corromper datos; después velocidad, claridad, solidez y pulido.

**Prioridades generales, sin orden obligatorio ni planes predefinidos:**

- **Primera impresión:** landing pública antes de login, marca coherente, UX premium minimalista, accesible y responsive; feedback claro de estados y errores.
- **Rapidez medible:** mejorar carga de biblioteca, subidas, descargas y arranque de reproducción a partir de mediciones reales del cliente, red, servidor y transporte.
- **Experiencia profesional:** no mostrar referencias técnicas de Telegram en UI, textos o errores públicos; quitar debug y logs ruidosos de consola del navegador sin perder observabilidad segura del servidor. Ocultar la infraestructura no significa sustituirla.
- **Confiabilidad y recuperación:** fallos parciales, reintentos, sesiones, corrupción, archivos faltantes, backups, restauración, coherencia del INDEX y datos protegidos.
- **Código comprensible:** responsabilidades limpias, módulos pequeños, duplicación reducida y regresiones verificables; no refactorizar o eliminar componentes a ciegas.
- **Escala real:** probar concurrencia, aislamiento, p95/p99, costos, capacidad EC2/RDS, colas, límites del proveedor y degradación controlada. Que funcione para pocos usuarios no demuestra alta concurrencia.
- **MASTER, INDEX y Transport Bots:** auditar rutas activas, permisos, autoría del pin, publicación, borrado y recuperación antes de decidir si MASTER es un cuello de botella o cambiar qué cuenta edita INDEX. No asumir la conclusión.
- **Marketing en paralelo:** conceptos, guiones, assets y videos piloto en [MarketingBeatGaler](https://github.com/magosouljah/MarketingBeatGaler); mensajes públicos fieles a funciones validadas, sin adelantar grandes campañas a landing/experiencia.

**Exclusiones actuales:** prioridad exclusiva Web + Cloud. Desktop/Tauri se encuentra suspendido, no eliminado. La antigua visión completa incluía offline, Desktop y YouTube; esas ideas no se convierten en promesas ni gates obligatorios de esta estabilización Web.

Cuando se elija un frente: investigar hechos y límites, proponer plan **local a ese trabajo**, establecer criterio de validación, implementar con pruebas/PR y decidir publicación **por separado**. No guardar aquí tareas de cada sesión.
