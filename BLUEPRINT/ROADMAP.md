# Roadmap de dirección — BeatGaler después de beta.2

**No es un calendario ni una secuencia obligatoria.** Para cada frente, cuando se decida trabajarlo, se creará un plan concreto y medible. La guía principal, sin duplicar tareas, es [WORKPLAN.md](WORKPLAN.md).

## Ahora: calidad antes que nuevas funcionalidades

Web + Cloud deben sentirse profesionales: landing antes de login, UX limpia y responsive, upload y playback rápidos, comportamiento sólido bajo errores, código entendible y escalabilidad **medida** con múltiples usuarios simultáneos. Auditoría de INDEX/MASTER/Transport Bot **antes de elegir** un cambio de arquitectura. Evitar mensajes técnicos de Telegram y logs ruidosos en la experiencia pública, sin perder seguridad ni observabilidad interna.

## En paralelo: videos promocionales

[MarketingBeatGaler](https://github.com/magosouljah/MarketingBeatGaler) es un proyecto independiente. Puede avanzar con referencias, guiones, diseño y videos de prueba mientras se estabiliza la app. Las campañas públicas a escala esperan una landing y flujos validados.

## Después: beta.3 y V1

Agregar nuevas funciones solo tras validar el núcleo, capacidades, seguridad y desempeño. Beta.3 será una decisión de alcance, no una obligación de calendario. La visión de funciones está en [V1.md](V1.md), no en un checklist de tareas que deban ejecutarse todas ahora.

**Desktop/Tauri** continúa suspendido y no se reactiva automáticamente. El incidente de red EC2 del 27-10-2026 está [documentado](OPERATIONS/INCIDENT-2026-10-27-EC2-NETWORK.md) y en observación, no en trabajo activo.

**Protección de release:** no modificar producción `v0.9.0-beta.2` ni el commit `a8418223527f88e9d34db8e05abb10216942013c` sin autorización expresa.
