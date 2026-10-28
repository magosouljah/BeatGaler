# Dirección de BeatGaler hacia V1 — Web + Cloud

> **Stupid Simple** para usuarios, frontend y backend. **Orden recomendado, no cronograma, backlog, fases obligatorias ni compromisos de entrega.**

BeatGaler debe hacer simples y fiables los flujos **encontrar → escuchar → descargar** y **subir → describir/editar → organizar → recuperar** beats y proyectos. Primero no perder ni corromper datos; después velocidad, claridad, solidez y pulido.

## Orden recomendado hacia V1 (flexible)

### 1. Auditoría técnica del núcleo — EMPEZAR AQUÍ

Examinar Web + Cloud y su código real, especialmente **MASTER, Transport Bots, INDEX, concurrencia, permisos, integridad de datos y recuperación**. Confirmar rutas activas, cuellos y riesgos **antes** de alterar la arquitectura. Documentar evidencia y separar hechos, hipótesis y preguntas abiertas.

**Plan específico y hallazgos del paso 1:** [TECHNICAL-CORE-AUDIT-V1.md](TECHNICAL-CORE-AUDIT-V1.md). Es la investigación elegida ahora, no autorización para correr tests peligrosos o modificar producción. [Issue #133](https://github.com/magosouljah/BeatGaler/issues/133) exige aislar bases de pruebas antes de ensayos con escrituras.

### 2. Rendimiento y estabilidad

Optimizar **subidas, reproducción y carga de biblioteca** a partir de mediciones reales de cliente, red, Cloud, PostgreSQL y Telegram. Resolver cuellos comprobados, acelerar el inicio de audio, mejorar manejo de errores/reintentos y comprobar concurrencia con muchos usuarios simultáneos; no asumir capacidad por tests sintéticos.

### 3. Experiencia premium y landing

Crear **landing pública antes de login**, experiencia profesional y coherente, responsive/accesible, mensajes claros y pulido visual. Eliminar referencias técnicas visibles de **Telegram** en interfaz y errores públicos; retirar logs de debug ruidosos de consola del navegador **sin perder observabilidad segura en servidor**. Mantener flujos simples y fiables.

### 4. Limpieza y mantenimiento

Consolidar código, reducir duplicaciones y código muerto **sólo después de identificar rutas activas**, mejorar estructura, nombres, documentación y pruebas. Es trabajo progresivo y transversal mientras se interviene cada área; no obliga a una refactorización masiva separada.

### 5. Validación V1

Probar la experiencia completa en entornos seguros: **carga real, aislamiento y seguridad, fallos parciales, restauración, regresiones y UX**. Fijar criterios medibles y decidir con evidencia si está lista para lanzamiento más amplio. Un PASS local o histórico no certifica producción.

**Este orden expresa preferencia, no dependencia rígida.** Se pueden adelantar correcciones urgentes o realizar trabajos paralelos. Para cada frente se crea su plan puntual al comenzar; no mantener cientos de tareas en BLUEPRINT.

## Principios constantes

- **Integridad antes que apariencia:** INDEX, Trash, tombstones, PROJECT, cuotas, ownership y recuperación deben conservarse ante reintentos, fallos, dos dispositivos y restauración.
- **Autoridad verificable:** MASTER, INDEX y Transport Bots se evalúan con rutas, permisos, mediciones y pruebas actuales. No asumir que MASTER sea el cuello de botella ni cambiar qué cuenta edita/pinnea INDEX por intuición.
- **Escala demostrada:** medir p50/p95/p99, carga, colas, recursos EC2/RDS, límites del proveedor, degradación y costos. Funcionar con pocos usuarios no implica escalar.
- **Código legible y mantenible:** responsabilidades claras, módulos comprensibles y regresiones verificables; no borrar componentes a ciegas.
- **Marketing en paralelo:** conceptos, guiones, assets y videos piloto en [MarketingBeatGaler](https://github.com/magosouljah/MarketingBeatGaler), con mensajes fieles a funciones validadas; grandes campañas según la madurez de landing/experiencia.

**Exclusiones actuales:** prioridad exclusiva Web + Cloud. Desktop/Tauri está suspendido, no eliminado. Offline, Desktop y YouTube son parte de visiones históricas, no promesas ni gates de esta estabilización Web. El incidente EC2 del 27-10-2026 permanece documentado y en observación; no es una investigación activa de este plan.

**Método:** investigar hechos y límites → proponer intervención local con criterios de validación → implementar con pruebas/PR → decidir publicación **por separado**. No guardar aquí cronogramas ni tareas de cada sesión.
