# BeatGaler — instrucciones para agentes

Para cambios de UI, diseño, Landing, Gallery, MASTER, Design Lab, componentes, interacciones, animaciones o físicas:

1. Leer `BLUEPRINT/DESIGN-SYSTEM/README.md`. Respetar su jerarquía de fuentes y comprobar el código real en `design-lab/`.
2. **Leer y aplicar antes de diseñar las skills locales pertinentes** de `.agents/skills/<skill>/SKILL.md` (incluidos archivos auxiliares cuando sean necesarios). Para apps: `apple-design`, `emil-design-eng`, `mobile-native`; para movimiento: `animate`, `animation-performance`, `review-animations`; para comparar variantes: `prototype`.
3. La verdad del sistema experimental está en MASTER + Landing + Gallery **ejecutables**, no en especulaciones de Markdown. Proponer → implementar/mostrar → probar → documentar. No suponer que MASTER ya tiene aprobación estética.
4. No confundir `MASTER` visual del Design Lab con el MASTER técnico de Cloud. El laboratorio está aislado de datos/servicios reales.
5. **No modificar ni desplegar producción ni `main` sin autorización.** Trabajar en la rama experimental para diseño; no importar código productivo en el lab por conveniencia.

Estas instrucciones no reemplazan las políticas técnicas y de seguridad vigentes en BLUEPRINT.
