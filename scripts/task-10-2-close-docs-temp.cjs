'use strict';
const fs = require('fs');

const INITIAL = 'd3df8b8c9ceed684bfb09b70129d47774aba1b1c';
const IMPL = '61ae7ab57402bf033de0e7424d104016b15eff94';
const RUN = '34416955355';

const roadmapPath = 'migration/BeatGaler-roadmap-para-trabajar-con-IAs.md';
let roadmap = fs.readFileSync(roadmapPath, 'utf8');
const open = '### [ ] 10.2 — Dejar la composición mínima';
const closed = '### [x] 10.2 — Dejar la composición mínima';
if (!roadmap.includes(closed)) {
  if (!roadmap.includes(open)) throw new Error('10.2 roadmap marker not found');
  roadmap = roadmap.replace(open, closed);
  fs.writeFileSync(roadmapPath, roadmap);
}

const registroPath = 'migration/Registro-de-avance.md';
let registro = fs.readFileSync(registroPath, 'utf8').trimEnd();
const marker = '## 2026-09-09 — Tarea 10.2 — Dejar la composición mínima';
if (!registro.includes(marker)) {
  registro += `\n\n${marker}\n\n` +
`Tarea: 10.2 — Dejar la composición mínima\n` +
`Estado: Terminada\n` +
`Fecha: 2026-09-09\n\n` +
`Base\n\n` +
`- Rama: v0.9.0-test-noche\n` +
`- SHA inicial de la tarea: ${INITIAL}\n` +
`- SHA de implementación validada: ${IMPL}\n` +
`- Última tarea verificada al comenzar: 10.1 — Extraer la estructura visual restante\n\n` +
`Cambio realizado\n\n` +
`- App.tsx quedó como entrada mínima y delega en app/BeatGalerApp.tsx.\n` +
`- BeatGalerApp.tsx conserva una sola ruta de autenticación por plataforma: Web monta el workspace directamente y Desktop lo monta dentro de AccountGate.\n` +
`- app/useBeatGalerComposition.ts quedó principalmente como composición/wiring entre owners de library, startup, session, playback, import, cloud, edit, projects, downloads, offline, trash, tags, selection y drag/drop.\n` +
`- Se extrajeron de la composición las acciones de mutación offline, recuperación de biblioteca Cloud, transferencias manuales Cloud, entrada de import, edición de beats, routing de archivos soltados y el estado compartido de beat-cloud-update.\n` +
`- La lógica activa de edición/artwork/bulk update quedó en features/edit/useBeatEditing.ts; MASTER/WAV en useBeatAssetUpdates.ts; PROJECT en features/projects/useBeatProjects.ts; routing de archivos en features/dragdrop/useBeatFileDropRouting.ts.\n` +
`- updateExistingBeatFromFolder se identificó como bloque huérfano sin consumidores y se retiró de la composición en lugar de crear un nuevo hook muerto. Sus rutas activas equivalentes permanecen protegidas por useBeatAssetUpdates/useBeatProjects y las regresiones Phase 9C/9D.\n` +
`- No se persiguió un número de líneas artificial: se conservaron callbacks pequeños que son conexiones reales entre features y se evitó mover lógica solo para cumplir una métrica.\n\n` +
`Archivos principales afectados\n\n` +
`- src/App.tsx\n` +
`- src/app/BeatGalerApp.tsx\n` +
`- src/app/useBeatGalerComposition.ts\n` +
`- src/features/session/useMutationAvailability.ts\n` +
`- src/features/startup/useCloudLibraryRecovery.ts\n` +
`- src/features/cloud/useCloudBeatTransfer.ts\n` +
`- src/features/cloud/beatCloudUpdateBusy.ts\n` +
`- src/features/import/useImportEntry.ts\n` +
`- src/features/edit/useBeatEditing.ts\n` +
`- src/features/dragdrop/useBeatFileDropRouting.ts\n` +
`- scripts/run-regressions.mjs\n` +
`- scripts/regression-phase9cd.mjs\n` +
`- tests de integración/characterization afectados por el cambio de owner.\n\n` +
`Adaptación de pruebas\n\n` +
`- Las caracterizaciones que buscaban lógica directamente en App.tsx/useBeatGalerComposition.ts fueron redirigidas al owner real sin relajar sus aserciones.\n` +
`- issue97WebRoutingContract conserva la verificación de orden del routing de artwork en useBeatEditing.ts.\n` +
`- Phase 9C/9D sigue verificando MASTER/WAV/PROJECT/folder, confirmaciones, commits, readiness y filtrado Backup en sus owners actuales.\n` +
`- El guard del runtime state machine fue actualizado para seguir las rutas activas reales después de retirar el bloque huérfano.\n\n` +
`Comprobaciones ejecutadas\n\n` +
`- GitHub Actions Task 10.2 finalize composition temp, run ${RUN}: SUCCESS.\n` +
`- Focused 10.2 architecture check: PASS.\n` +
`- npm ci: PASS.\n` +
`- git diff --check: PASS.\n` +
`- npm run test:typecheck: PASS.\n` +
`- npm run test:unit:ts: PASS.\n` +
`- npm run test:component:dom: PASS.\n` +
`- npm run test:integration: PASS.\n` +
`- npm run test:regressions: PASS.\n` +
`- npm run build:web: PASS.\n` +
`- npm run build: PASS.\n` +
`- SHA validado por la matriz completa: ${IMPL}.\n\n` +
`Pruebas manuales y plataforma\n\n` +
`- No ejecutadas ni inventadas; esta tarea fue una extracción/composición estructural validada por la matriz automatizada aplicable.\n` +
`- La validación final integral y recorrido manual de flujos corresponde a 10.4.\n\n` +
`Fallos encontrados y causa\n\n` +
`- Las primeras corridas de 10.2 expusieron caracterizaciones/regresiones estáticas que todavía buscaban código en el owner anterior; se adaptaron al owner real sin reducir cobertura.\n` +
`- Run 34416745973: la implementación final pasó arquitectura, typecheck, unit, component DOM e integration, pero regression falló porque el guard del runtime esperaba una señal que desapareció al retirar el bloque huérfano. No fue una regresión funcional.\n` +
`- Run ${RUN}: guard corregido; matriz completa PASS y commit de implementación publicado.\n\n` +
`Pendientes / fuera de alcance\n\n` +
`- 10.3 — Retirar restos y conexiones temporales. No iniciada.\n` +
`- La limpieza general de imports/helpers sin consumidores y comentarios de transición corresponde a 10.3.\n` +
`- La validación final completa/E2E y comparación con línea base corresponde a 10.4.\n\n` +
`Herramientas temporales restantes\n\n` +
`- Ninguna de los aplicadores/workflows temporales de implementación de 10.2 permanece en el árbol validado.\n\n` +
`Veredicto\n\n` +
`Terminada.\n\n` +
`La raíz quedó comprensible y la composición dejó de poseer lógica de dominio grande; App.tsx es una entrada mínima, BeatGalerApp mantiene la autenticación por plataforma y useBeatGalerComposition conecta owners de feature sin convertirse en reemplazo funcional del antiguo mega-App.\n\n` +
`Siguiente tarea\n\n` +
`10.3 — Retirar restos y conexiones temporales. No iniciada.\n`;
  fs.writeFileSync(registroPath, registro + '\n');
}

const state = `# BeatGaler — Agent State\n\n## Contexto\n\n- Fecha de ejecución: 2026-09-09\n- Rama de trabajo: \`v0.9.0-test-noche\`\n- Tarea trabajada: \`10.2 — Dejar la composición mínima\`\n- Estado: \`Terminada\`\n- Última tarea terminada: \`10.2 — Dejar la composición mínima\`\n\n## Base de esta ejecución\n\n- SHA inicial: \`${INITIAL}\`\n- SHA de implementación validada: \`${IMPL}\`\n- El SHA final real de la ronda se relee desde GitHub después de esta escritura y no se autorreferencia aquí.\n\n## Resultado verificado\n\n- \`src/App.tsx\` es una entrada mínima que monta \`BeatGalerApp\`.\n- \`src/app/BeatGalerApp.tsx\` conserva exactamente una ruta de autenticación por plataforma: Web directo, Desktop mediante \`AccountGate\`.\n- \`src/app/useBeatGalerComposition.ts\` queda principalmente como wiring entre módulos y ya no posee los bloques grandes de mutación/edición/drop que se extrajeron durante 10.2.\n- El bloque huérfano \`updateExistingBeatFromFolder\` fue retirado tras verificar que no tenía consumidores; las rutas activas de MASTER/WAV/PROJECT/folder siguen en sus owners.\n- GitHub Actions run \`${RUN}\` pasó arquitectura, diff check, typecheck, unit TS, component DOM, integration, regressions, build web y build desktop sobre \`${IMPL}\`.\n\n## Pendientes concretos\n\n- \`10.3 — Retirar restos y conexiones temporales\`.\n- \`10.4 — Comprobar el resultado completo\`.\n\n## Comprobaciones pendientes\n\n- Ninguna necesaria para cerrar 10.2.\n- La limpieza general corresponde a 10.3.\n- La validación final integral/E2E corresponde a 10.4.\n\n## Siguiente tarea\n\n- \`10.3 — Retirar restos y conexiones temporales\`\n- Estado: \`Pendiente\`\n- No iniciada.\n`;
fs.writeFileSync('migration/BeatGaler-agent-state.md', state);
