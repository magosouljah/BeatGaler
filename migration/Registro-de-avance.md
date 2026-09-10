
### Registro — 1.1

```
Tarea: 1.1 — Confirmar el punto de partida
Estado: Terminada
Fecha: 2026-09-05
Rama y commit de partida: integration-v0.8.0-alpha.1 @ f5dd24de6049453c735c4daf34066065c5773280
Referencia del cambio realizado: rama app-tsx-migration creada en f5dd24de6049453c735c4daf34066065c5773280; sin cambios de código ni commit adicional.

Qué cambió:
- Se revisó el estado remoto actual del repositorio y las instrucciones aplicables.
- Se confirmó que integration-v0.8.0-alpha.1 sigue exactamente en el commit usado por el análisis original.
- La comparación f5dd24de... → integration-v0.8.0-alpha.1 es idéntica: 0 commits y 0 archivos de diferencia.
- Se revisó src/App.tsx y conserva la estructura analizada; no fue necesario repetir ninguna extracción.
- No se encontró una rama previa llamada app-tsx-migration ni un PR de migración de App.tsx.
- Se creó app-tsx-migration desde el commit de partida y se verificó que es idéntica a integration-v0.8.0-alpha.1.
- Los documentos específicos de esta migración fueron entregados fuera del repositorio; no se añadió un segundo sistema de roadmap/log al código.

Archivos afectados:
- Ningún archivo del repositorio.
- BeatGaler-roadmap-para-trabajar-con-IAs.md: casilla de 1.1 y este registro de avance.

Comprobaciones ejecutadas y resultado:
- Rama integration-v0.8.0-alpha.1 resuelta a f5dd24de6049453c735c4daf34066065c5773280: OK.
- Comparación del commit original contra integration-v0.8.0-alpha.1: identical, ahead 0, behind 0, 0 archivos: OK.
- Revisión de BLUEPRINT/SYSTEM.md y TESTING.md: OK.
- Revisión dirigida de src/App.tsx, incluida la entrada App web/escritorio: coincide con el análisis original.
- Búsqueda de rama app-tsx-migration previa: no existía.
- Creación de app-tsx-migration en f5dd24de6049453c735c4daf34066065c5773280: OK.
- Comparación app-tsx-migration contra integration-v0.8.0-alpha.1: identical, ahead 0, behind 0, 0 archivos: OK.
- No se ejecutaron typecheck, tests ni builds: pertenecen a 1.2 y 1.1 no modifica código de la app.

Pruebas manuales y plataforma:
- No requeridas para 1.1.

Pendientes o fallos previos:
- No hay diferencias de código respecto al snapshot técnico original.
- Este entorno no tiene montado el working tree local del usuario, por lo que no puede observar cambios sin commit que existan únicamente en otra máquina. GitHub remoto sí quedó comprobado y preservado íntegramente.
- La rama por defecto del repositorio es galer-cloud-v0.7.4; esta migración parte explícitamente de integration-v0.8.0-alpha.1 según el plan.

Conexiones temporales que quedan:
- Ninguna creada por 1.1.

Siguiente tarea:
- 1.2 — Comprobar cómo está la app hoy. No iniciada.
```

### Registro — 1.2

```
Tarea: 1.2 — Comprobar cómo está la app hoy
Estado: Terminada
Fecha: 2026-09-05
Rama y commit de partida: app-tsx-migration @ f5dd24de6049453c735c4daf34066065c5773280
Referencia del cambio realizado: sin cambios de código; línea base verificada y documentada sobre el SHA de partida.

Qué cambió:
- Se volvió a comprobar que 1.1 está terminada y que app-tsx-migration sigue partiendo de f5dd24de6049453c735c4daf34066065c5773280.
- Se revisaron .node-version, package.json, package-lock.json, BLUEPRINT/SYSTEM.md, TESTING.md, los scripts de comprobación y el workflow de portabilidad.
- Configuración requerida registrada: Node 22.23.2; package.json exige Node >=22.23.2 <23, npm >=10.9.8 <11 y declara npm@10.9.8.
- No se modificó App.tsx, ninguna prueba ni ningún archivo ejecutable.
- Se reutilizó la evidencia de CI del SHA exacto f5dd24de... para no repetir trabajo ya ejecutado: el workflow Test - Desktop Portability / run 33987726670 terminó verde y sus jobs hicieron checkout del SHA exacto.
- La línea base automatizada no muestra fallos previos en los checks que ese workflow ejecutó.
- Se comprobó por separado qué checks del plan no quedaron ejecutados literalmente por ese CI y se registran abajo, sin convertirlos en un resultado verde supuesto.

Archivos afectados:
- Ningún archivo del repositorio.
- BeatGaler-roadmap-para-trabajar-con-IAs.md: casilla de 1.2 y este registro de avance.

Comprobaciones ejecutadas y resultado:
- Instalación bloqueada del grafo raíz con `npm ci` en CI del SHA exacto: OK.
- `npm run build:web` / Build real Web bundle: OK.
- `npm run test:web:smoke` / smoke del bundle Web en Chrome: OK.
- `npm run test:typecheck`: OK.
- `npm run test:unit:ts`: OK.
- `npm run test:component:dom`: OK.
- `npm run test:integration`: OK.
- `npm run test:unit:cloud`: OK.
- `npm run test:regressions`: OK.
- `npm run test:packaging:static`: OK.
- PostgreSQL live integration + recovery gate: OK.
- Supply chain gate: OK.
- Portable gate on Windows: OK.
- Native macOS smoke arm64: OK.
- Native macOS smoke x86_64: OK.
- Required CI: OK.
- `npm run build`: NO reejecutado como comando literal para este registro. El workflow automático del SHA exacto no lo invoca; sí comprobó typecheck, build Web, regresiones y compilación/portabilidad nativa por sus gates.
- `npm run check`: NO reejecutado como comando agregado. En este package equivale a `npm run test:fast && npm run build`; sus suites principales están cubiertas por el CI indicado, pero `npm run build` literal queda sin repetición.
- E2E de import/download/recovery y prueba funcional manual: no aplican todavía a 1.2; el plan los reserva para hitos posteriores y el cierre.

Pruebas manuales y plataforma:
- No requeridas para 1.2 porque no hubo cambio funcional; esta tarea establece la línea base automatizada.

Pendientes o fallos previos:
- No se observó un fallo previo en la línea base automatizada del SHA f5dd24de....
- No fue posible hacer un checkout/`npm ci` nuevo desde este shell: el shell no resuelve github.com/npm y el runtime local disponible es Node 22.16.0 + npm 10.9.2, por debajo de los mínimos del proyecto. Por eso no se usó ese entorno para declarar resultados.
- `npm run build` y, por consecuencia, `npm run check` completo quedan identificados como comprobaciones no repetidas por limitación de entorno. Deben ejecutarse cuando exista un checkout con Node/npm compatibles, especialmente antes de cerrar una extracción/parte según el plan.
- La evidencia usada para los checks verdes es CI existente del SHA exacto, no una ejecución local nueva.

Mejoras ajenas al alcance:
- Ninguna detectada que deba ensanchar 1.2.

Conexiones temporales que quedan:
- Ninguna creada por 1.2.

Siguiente tarea:
- 1.3 — Preparar las pruebas de los flujos delicados. No iniciada.
```

### Registro — 1.3

```
Tarea: 1.3 — Preparar las pruebas de los flujos delicados
Estado: Terminada
Fecha: 2026-09-05
Rama y commit final: app-tsx-migration @ 4e88c2aa687ca4077c3a5b54650bc51634a8ce41
Referencia del cambio realizado: tests/integration/appMigrationCharacterization.test.ts; PR draft temporal #131 usado solo para CI y cerrado sin merge.

Qué cambió:
- Se confirmó que 1.1 y 1.2 estaban terminadas antes de comenzar.
- Se revisaron BLUEPRINT/SYSTEM.md, TESTING.md, package.json, App.tsx, pruebas existentes y scripts de regresión que dependen de App.tsx.
- Se añadió una suite de caracterización específica para la migración de App.tsx.
- Se protegieron explícitamente los flujos delicados de uploads, Review, Reload, audio, recuperación y separación Web/Desktop.
- Upload Desktop conserva la frontera durable por beat: media/assets -> metadata -> commit del INDEX -> limpiar marcador de recuperación -> preparar playback.
- La ruta Web conserva su commit mediante platform.cloudData.commitImportedBeat y no cae en el pipeline nativo.
- Review conserva candidatos fuera de biblioteca hasta Save y las diferencias entre Save, Skip y Cancel.
- Reload conserva su diferimiento mientras existen uploads activos y su ejecución posterior al vaciarse la cola.
- Playback conserva invalidación de caché/promesas, estado playing derivado del evento real y rutas distintas Web/Desktop.
- Recovery conserva comportamiento fail-closed: sin autoridad cloud conocida no elimina una subida interrumpida.
- La nueva prueba registra los módulos/tareas futuros a los que deberán apuntar estas garantías cuando cada responsabilidad salga de App.tsx.
- Las pruebas existentes que leen App.tsx no se desactivaron ni se modificaron prematuramente; se adaptarán al dueño preciso durante cada extracción.
- No se modificó App.tsx ni código productivo.

Archivos afectados:
- tests/integration/appMigrationCharacterization.test.ts — nuevo, 145 líneas.
- Ningún archivo productivo modificado.
- Roadmap: marcar 1.3 como [x].
- Registro de avance: añadir esta entrada.

Comprobaciones ejecutadas y resultado:
- npm run build:web / Build real Web bundle: OK.
- npm run test:web:smoke / Chrome Web smoke: OK.
- npm run test:typecheck: OK.
- npm run test:unit:ts: OK.
- npm run test:component:dom: OK.
- npm run test:integration: OK; incluye appMigrationCharacterization.test.ts.
- npm run test:unit:cloud: OK.
- npm run test:regressions: OK.
- npm run test:packaging:static: OK.
- PostgreSQL live integration + recovery gate: OK.
- Supply chain gate: OK.
- Portable gate on Windows: OK.
- Native macOS smoke arm64: OK.
- Native macOS smoke x86_64: OK.
- Required CI: OK.
- D6 — Cross-Process Authorization: OK.
- D7 — Direct Capability Authorization: OK.
- F0 HEAD Secret Scan: OK.
- npm run build: no invocado literalmente; las compilaciones Web y los gates nativos aplicables quedaron verdes.
- npm run check: no invocado como wrapper agregado; no es un pendiente bloqueante de 1.3 y la validación aplicable del cambio quedó cubierta por CI.
- E2E import/download/recovery: no ejecutados; el plan los reserva para las tareas/hitos funcionales correspondientes.

Pruebas manuales y plataforma:
- No requeridas para 1.3 porque solo se añadieron pruebas y no cambió comportamiento observable.

Pendientes:
- Al hacer cada extracción posterior, mover las comprobaciones estáticas desde App.tsx al módulo dueño indicado en vez de concatenar archivos o debilitar las assertions.
- Completar las comprobaciones funcionales específicas al trabajar en cada tarea correspondiente, tal como establece el roadmap.
- No queda una verificación necesaria pendiente para cerrar 1.3.

Mejoras ajenas al alcance:
- No se detectaron nuevas mejoras o bugs que requieran ampliar 1.3.

Conexiones temporales que quedan:
- Ninguna.
- El PR draft #131 creado únicamente para disparar CI fue cerrado sin merge.

Siguiente tarea:
- 2.1 — Separar las dos ventanas auxiliares.
- No iniciada.
```


### Registro — 2.1

```
Tarea: 2.1 — Separar las dos ventanas auxiliares
Estado: Terminada
Fecha: 2026-09-05
Rama y commit final: app-tsx-migration @ 1c8312e98bbb65e5c0780851cc8840fe8b883538
Referencia del cambio realizado: extracción de CloudFilesModal y BeatFileDropModal desde App.tsx; registro reconstruido posteriormente a partir del commit y CI versionados de la tarea.

Qué cambió:
- CloudFilesModal salió de App.tsx a src/features/downloads/components/CloudFilesModal.tsx.
- BeatFileDropModal salió de App.tsx a src/features/dragdrop/components/BeatFileDropModal.tsx.
- BeatDownloadKind pasó a ser propiedad del módulo de CloudFilesModal y App.tsx lo importa desde ahí.
- DroppedBeatFileRole pasó a ser propiedad del módulo de BeatFileDropModal y App.tsx lo importa desde ahí.
- App.tsx dejó de contener las definiciones locales de ambas ventanas.
- Ambas ventanas conservaron su render mediante ReactDOM.createPortal.
- Se añadieron pruebas DOM específicas para las ventanas extraídas.
- Se añadió una prueba de integración que verifica que App.tsx utiliza los nuevos módulos y ya no contiene las implementaciones locales.
- No se reconstruyó ni rediseñó el comportamiento de las ventanas; la tarea fue una extracción estructural.
- El workflow temporal utilizado para aplicar y validar 2.1 fue eliminado en el commit final.

Archivos afectados:
- src/App.tsx
- src/features/downloads/components/CloudFilesModal.tsx
- src/features/dragdrop/components/BeatFileDropModal.tsx
- tests/component-dom/appAuxiliaryModals.test.tsx
- tests/integration/appAuxiliaryModalExtraction.test.ts
- .github/workflows/task-2-1-apply.yml — temporal, eliminado en el commit final.

Comprobaciones ejecutadas y resultado:
- npm ci: OK.
- npm run test:typecheck: OK.
- npm run test:unit:ts: OK.
- npm run test:component:dom: OK.
- npm run test:integration: OK.
- npm run test:regressions: OK.
- npm run build:web: OK.
- npm run build: OK.
- Workflow Temporary Task 2.1 Apply / run 33994418360: OK.
- Commit de extracción verificada y eliminación del workflow temporal: OK.

Pruebas manuales y plataforma:
- No hay evidencia versionada de una prueba manual específica ejecutada durante 2.1.
- El cierre de 2.1 queda respaldado por las pruebas automatizadas de componentes, integración, regresión y los builds Web/Desktop.
- La implementación extraída permanece presente en la línea de integración usada posteriormente por 2.2.

Pendientes:
- No queda una verificación automatizada necesaria pendiente para 2.1.
- Las extracciones posteriores deben seguir adaptando las pruebas que todavía dependan directamente de App.tsx.

Mejoras ajenas al alcance:
- Ninguna registrada como parte de 2.1.

Conexiones temporales que quedan:
- Ninguna.
- El workflow temporal task-2-1-apply.yml fue eliminado en el commit final.

Siguiente tarea:
- 2.2 — Separar buscador y menús.
- No iniciada en ese momento.
```
### Registro — 2.2

```
Tarea: 2.2 — Separar buscador y menús
Estado: Terminada
Fecha: 2026-09-07
Rama y commit final: app-tsx-2.2 @ 3f3c98576b2afb7e692956ede807a367da5ce269
Referencia del cambio realizado: extracción de SearchBar, SortMenu y TagColorMenu desde App.tsx a sus componentes feature correspondientes.

Qué cambió:
- Se confirmó que la base actual ya contenía la extracción correspondiente a 2.1 antes de continuar.
- SearchBar salió de App.tsx a src/features/library/components/SearchBar.tsx.
- SortMenu y SortKey salieron de App.tsx a src/features/library/components/SortMenu.tsx.
- TagColorMenu salió de App.tsx a src/features/tags/components/TagColorMenu.tsx.
- Se conservaron el HTML, estilos, apertura/cierre, foco, teclado y comportamiento existente.
- SearchBar conserva autofocus, limpieza de búsqueda y cierre al perder foco cuando está vacío.
- SortMenu conserva selección, cierre por click exterior y Escape.
- TagColorMenu conserva su portal al body, selección de color, None, Rename y cierre por Escape/contextmenu/click exterior.
- Se añadieron pruebas DOM directas para los tres componentes extraídos.
- Durante la verificación apareció una assertion antigua de Issue #97 que esperaba una guarda de playback anterior.
- La prueba se adaptó a la guarda Desktop actual sin modificar ni revertir el comportamiento productivo.
- También se preservaron las reparaciones Desktop recientes ya presentes en la base.
- Los scripts y workflow temporales usados únicamente para verificar/aplicar la extracción fueron eliminados del commit final.

Archivos afectados:
- src/App.tsx
- src/features/library/components/SearchBar.tsx
- src/features/library/components/SortMenu.tsx
- src/features/tags/components/TagColorMenu.tsx
- tests/component-dom/appLibraryMenus.test.tsx
- tests/integration/issue97RuntimeWebFollowup.test.ts

Comprobaciones ejecutadas y resultado:
- npm run test:typecheck: OK.
- npm run test:unit:ts: OK.
- npm run test:component:dom: OK.
- npm run test:integration: OK.
- npm run test:regressions: OK.
- npm run build:web: OK.
- npm run build: OK.
- Verificación completa de Task 2.2 en GitHub Actions: OK.

Pruebas manuales y plataforma:
- No quedó una prueba manual bloqueante para cerrar 2.2.
- Las pruebas DOM cubren las interacciones principales de los tres componentes extraídos.
- Las diferencias y guardas actuales Web/Desktop se conservaron sin cambios productivos.

Pendientes:
- No queda una verificación necesaria pendiente para cerrar 2.2.
- Continuar reduciendo App.tsx siguiendo el orden del roadmap.

Mejoras ajenas al alcance:
- Se detectaron assertions antiguas que todavía dependían de detalles previos de App.tsx; únicamente se adaptaron las necesarias para reflejar el comportamiento actual, sin ampliar el alcance funcional de 2.2.

Conexiones temporales que quedan:
- Ninguna.
- El workflow y script temporales usados para completar/verificar 2.2 fueron eliminados antes del commit final.

Siguiente tarea:
- 2.3 — Separar las funciones auxiliares.
- No iniciada.
```



### Registro — 2.3

```
Tarea: 2.3 — Separar las funciones auxiliares
Estado: Terminada
Fecha: 2026-09-08
Rama y commit de partida: app-tsx-2.2 @ 3f3c98576b2afb7e692956ede807a367da5ce269
Referencia del cambio realizado: app-tsx-2.3 @ e6d95657356afc1380c980dd8a2b249791d1e82b — refactor(app): extract auxiliary helpers

Qué cambió:
- Se extrajeron de App.tsx helpers de caché/presentación de biblioteca, fingerprints de metadata, journal de uploads interrumpidos, rutas de drag & drop y decodificación de artwork.
- Se crearon `libraryPresentationCache.ts`, `libraryFingerprints.ts`, `interruptedUploadJournal.ts`, `pathHelpers.ts` y `decodeArtworkDataUrl.ts`.
- Se conservaron las claves de almacenamiento, formatos, resultados y el comportamiento fail-closed existente.
- `clearUploadPreviewCache` y los demás consumidores relevantes quedaron apuntando a sus nuevos dueños.
- Las guardas de regresión que dependían de la ubicación física en App.tsx se adaptaron al nuevo módulo sin debilitar el contrato.
- No se cambió comportamiento Web/Desktop ni se inició 3.1.
- El workflow y script temporales usados para aplicar/verificar 2.3 fueron eliminados del árbol final.

Archivos afectados:
- src/App.tsx
- src/features/artwork/decodeArtworkDataUrl.ts
- src/features/cloud/interruptedUploadJournal.ts
- src/features/dragdrop/pathHelpers.ts
- src/features/library/libraryFingerprints.ts
- src/features/library/libraryPresentationCache.ts
- tests/integration/appHelperExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- scripts/run-regressions.mjs

Comprobaciones ejecutadas y resultado:
- npm ci: OK.
- npm run test:typecheck: OK.
- npm run test:unit:ts: OK.
- npm run test:component:dom: OK.
- npm run test:integration: OK.
- npm run test:regressions: OK.
- npm run build:web: OK.
- npm run build: OK.
- Verificación final de Task 2.3: OK.
- Commit final verificado: e6d95657356afc1380c980dd8a2b249791d1e82b.

Pruebas manuales y plataforma:
- No se requirió una prueba manual bloqueante para cerrar 2.3.
- La tarea fue una extracción de helpers sin cambio observable de UI o flujo.

Pendientes o fallos previos:
- No queda una verificación necesaria pendiente para 2.3.
- Los hallazgos de concurrencia/snapshots ya documentados en el plan permanecen fuera de alcance.

Conexiones temporales que quedan:
- Ninguna.
- El workflow/script temporal de 2.3 fue eliminado antes del commit final.

Siguiente tarea:
- 3.1 — Separar el estado de la biblioteca.
- No iniciada en ese momento.
```

### Registro — 3.1

```
Tarea: 3.1 — Separar el estado de la biblioteca  
Estado: Terminada  
Fecha: 2026-09-08  
Rama y commit de partida: app-tsx-2.3 @ e6d95657356afc1380c980dd8a2b249791d1e82b  
Referencia del cambio realizado: app-tsx-3.1 @ 55bc640df3bd78b16d07a749f7c111b8e5e90a7c — refactor(app): extract library state ownership

Qué cambió:
- Se confirmó que 2.3 estaba terminada antes de comenzar.
- Se creó `src/features/library/useLibraryState.ts` como dueño del estado principal de la biblioteca.
- `beats`, `setBeats`, `beatsLatestRef` y `startupCachedBeatsRef` dejaron de ser administrados directamente por App.tsx.
- Se extrajo también la persistencia de la caché de presentación mediante `useLibraryPresentationCache`.
- Se conservó exactamente el comportamiento inicial de carga desde caché y el filtrado de uploads interrumpidos.
- Se conservaron los momentos existentes en los que `beatsLatestRef.current` se actualiza de forma síncrona dentro de operaciones específicas.  
- No se convirtió `setBeats` en un setter que actualice automáticamente `beatsLatestRef`.  
- Se conservó la actualización normal de `beatsLatestRef` desde el efecto dependiente de `[beats]`.
- Se mantuvo exactamente la guarda previa de persistencia de caché y su debounce de 1500 ms.
- Se adaptaron las pruebas que inspeccionaban directamente App.tsx para que sigan la responsabilidad hasta su nuevo dueño.
- El regression guard de startup que todavía buscaba el estado dentro de App.tsx se actualizó para inspeccionar `useLibraryState.ts`, sin eliminar ni debilitar la comprobación.
- No se modificó el comportamiento funcional Web/Desktop ni se inició la tarea 3.2.

Archivos afectados:
- src/App.tsx
- src/features/library/useLibraryState.ts
- tests/component-dom/libraryState.test.tsx
- tests/component-dom/startupRevealArchitecture.test.ts
- tests/integration/libraryStateExtraction.test.ts
- scripts/run-regressions.mjs

Comprobaciones ejecutadas y resultado:
- git diff --check: OK.
- npm run test:typecheck: OK. 
- npm run test:unit:ts: OK.
- npm run test:component:dom: OK.
- npm run test:integration: OK.
- npm run test:regressions: OK.
- npm run build:web: OK.
- npm run build: OK.
    
- Verificación específica de conservación de llamadas `setBeats`: OK.
- Verificación específica de conservación de asignaciones síncronas a `beatsLatestRef.current`: OK.
- Workflow definitivo de Task 3.1 / run 34192537105: OK.
- Commit final verificado: 55bc640df3bd78b16d07a749f7c111b8e5e90a7c.

Pruebas manuales y plataforma:
- No se requirió una prueba manual bloqueante para cerrar 3.1.
- La extracción quedó cubierta por pruebas de componente, integración, regresión y builds Web/Desktop.
- No se declaró ninguna comprobación manual no ejecutada como si hubiera sido realizada.

Pendientes o fallos previos:
- No queda una verificación automatizada necesaria pendiente para cerrar 3.1.
- `handleRemoveBulk` conserva un posible riesgo previo relacionado con el uso de un snapshot capturado de `beats`; no se modificó porque está fuera del alcance de 3.1.
- Continuar adaptando las pruebas que dependan de la ubicación física del código cuando las responsabilidades futuras salgan de App.tsx.

Conexiones temporales que quedan:
- Ninguna.
- El workflow y el script temporales utilizados para aplicar/verificar 3.1 fueron eliminados antes del commit final.

Siguiente tarea:
- 3.2 — Separar estados de runtime. 
- No iniciada.
```


### Registro — 3.2

```
Tarea: 3.2 — Separar los estados de operación por beat
Estado: Terminada
Fecha: 2026-09-08
Rama y commit de partida: app-tsx-3.1 @ 55bc640df3bd78b16d07a749f7c111b8e5e90a7c
Referencia del cambio realizado: app-tsx-3.2 @ 0a38112c1639d9cee67aaef56e9a12eaba83ffc3 — refactor(app): extract beat runtime registry

Qué cambió:
- Se creó `src/features/state/useBeatRuntimeRegistry.ts` como dueño del registro de estados runtime por beat.
- `beatRuntimeStates`, `beatRuntimeStatesRef`, las transiciones, olvido de estado y limpieza de estados de trash reconciliados dejaron de ser administrados directamente por App.tsx.
- Se reutilizó `beatRuntimeState.ts`; no se creó una segunda máquina de estados.
- Se conservaron las transiciones existentes, la hidratación durable del estado Offline y los estados transitorios de upload/download/playback/delete.
- Se conservaron los estados de borrado y `trash_sync_required` aunque la tarjeta ya no esté visible, hasta que la operación responsable los limpie.
- Una transición rechazada conserva el último estado válido y sigue tratándose como error de programación, no como fallo de usuario.
- Las recargas de biblioteca no resucitan trabajo transitorio, pero continúan rehidratando la disponibilidad Offline durable.
- App.tsx sigue realizando las mismas llamadas de transición; solo cambió el ownership del registro.
- Se añadió cobertura DOM directa del nuevo hook y se adaptaron guardas de regresión.
- No se inició 3.3.
- El tooling temporal de aplicación/verificación fue eliminado del árbol final.

Archivos afectados:
- src/App.tsx
- src/features/state/useBeatRuntimeRegistry.ts
- tests/component-dom/beatRuntimeRegistry.test.tsx
- scripts/run-regressions.mjs

Comprobaciones ejecutadas y resultado:
- npm ci: OK.
- git diff --check: OK.
- npm run test:typecheck: OK.
- npm run test:unit:ts: OK.
- npm run test:component:dom: OK.
- npm run test:integration: OK.
- npm run test:regressions: OK.
- npm run build:web: OK.
- npm run build: OK.
- Verificación de conservación del número de llamadas `transitionRuntime`: OK.
- Verificación de que el ownership de runtime salió de App.tsx: OK.
- Commit final verificado: 0a38112c1639d9cee67aaef56e9a12eaba83ffc3.

Pruebas manuales y plataforma:
- No se requirió una prueba manual bloqueante para cerrar 3.2.
- La extracción quedó cubierta por el hook, regresiones, integración y builds aplicables.

Pendientes o fallos previos:
- No queda una verificación necesaria pendiente para 3.2.
- Los riesgos previos ajenos a runtime permanecen sin cambios.

Conexiones temporales que quedan:
- Ninguna.
- `.github/workflows/task-3-2-apply.yml` y `scripts/apply-task-3-2.mjs` fueron eliminados del commit final.

Siguiente tarea:
- 3.3 — Separar búsqueda, filtros y etiquetas.
- No iniciada en ese momento.
```

### Registro — 3.3

```
Tarea 3.3 — Separar búsqueda, filtros y etiquetas

Estado: Terminada
Fecha: 2026-09-08

Base

* Rama base: integration-v0.9.0-alpha.2
* SHA inicial: 0a38112c1639d9cee67aaef56e9a12eaba83ffc3
* Tarea previa 3.2 verificada como completada antes de iniciar.
* Rama de trabajo: app-tsx-3.3
* SHA final: 1c415f318ac5f0c7c466f3f4cbb9ab28a8369c11
* integration-v0.9.0-alpha.2 avanzó por fast-forward al mismo SHA final.

Cambio realizado

Se extrajo de App.tsx la responsabilidad de búsqueda, ordenamiento, filtros incluidos/excluidos y cálculos derivados de tags.

Se añadieron:

* useLibraryViewState
    * posee search
    * posee sortBy
    * conserva la carga del sort persistido
    * conserva saveCachedSort(sortBy)
* useTagFilters
    * posee tags incluidos
    * posee tags excluidos
    * conserva toggle include/exclude
    * conserva limpieza conjunta de filtros
    * conserva reemplazo de tags durante rename
* selectFilteredAndSortedBeats
    * conserva búsqueda por nombre, tags, key y BPM
    * conserva filtros incluidos/excluidos
    * conserva orden manual
    * conserva orden BPM
    * conserva orden por nombre
    * conserva rating descendente
    * conserva el orden manual como desempate de rating
* tagSelectors
    * selectTagFrequency
    * selectAllTags
    * selectTagSuggestions
    * conserva normalización y ranking existentes

La conexión especial Web entre el sort visible y la preparación/routing de playback no se movió a los nuevos módulos. App.tsx continúa componiendo:

useWebPlaybackSortRouting(sortBy, beats, platform.kind === "web")

para conservar la separación library/playback y el comportamiento Web existente.

La selección y el reordenamiento permanecieron en App.tsx; no se inició la tarea 3.4.

Adaptación de pruebas

Se añadieron pruebas directas para:

* persistencia de sortBy
* estado de búsqueda
* filtros include/exclude
* limpieza de filtros
* reconciliación de filtros durante rename
* búsqueda por los campos existentes
* semántica include/exclude
* orden manual/BPM/nombre/rating
* desempate manual de rating
* frecuencia y ranking normalizado de tags
* sugerencias de tags
* wiring de los nuevos módulos desde App.tsx
* conservación del routing Web
* comprobación explícita de que selección/reorder siguen en App.tsx

Durante la validación, tests/integration/issue97PlaybackOptimization.test.ts falló porque todavía buscaba directamente:

const [sortBy, setSortBy] = useState<SortKey>(...)

dentro de App.tsx.

Ese test se adaptó al nuevo ownership sin eliminar el contrato que protegía:

* ahora verifica que useLibraryViewState siga cargando/persistiendo el sort;
* verifica que App.tsx obtenga sortBy desde ese hook;
* verifica que useWebPlaybackSortRouting continúe ejecutándose después de obtener el sort;
* conserva las comprobaciones de orden respecto al reconcile autoritativo Web.

La corrida posterior pasó completa.

Archivos afectados

* src/App.tsx
* src/features/library/librarySelectors.ts
* src/features/library/useLibraryViewState.ts
* src/features/tags/tagSelectors.ts
* src/features/tags/useTagFilters.ts
* tests/component-dom/libraryViewState.test.tsx
* tests/component-dom/tagFilters.test.tsx
* tests/integration/issue97PlaybackOptimization.test.ts
* tests/integration/libraryViewExtraction.test.ts
* tests/integration/libraryViewSelectors.test.ts

Los scripts y workflow temporales usados para aplicar/verificar la extracción fueron eliminados del árbol final.

Comprobaciones ejecutadas

Corrida final de GitHub Actions: 34197494248

* npm ci — OK
* aplicación de extracción 3.3 — OK
* git diff --check — OK
* npm run test:typecheck — OK
* npm run test:unit:ts — OK
* npm run test:component:dom — OK
* npm run test:integration — OK
* npm run test:regressions — OK
* npm run build:web — OK
* npm run build — OK
* publicación del commit final y eliminación del tooling temporal — OK

Comprobaciones no ejecutadas

* npm run check
    * no ejecutado porque el plan reserva el gate completo para hitos/cierre; los siete checks exigidos para esta extracción pasaron individualmente.
* E2E completos de import/download/recovery
    * no ejecutados porque 3.3 no modifica esos flujos.
* smoke Web completo de producto
    * no necesario para esta extracción interna; build:web, integración y la guarda específica de routing Web pasaron.
* pruebas nativas de portabilidad Tauri/macOS/Windows
    * no ejecutadas porque no se modificaron adapters, comandos Tauri ni comportamiento específico de plataforma.

Prueba manual

No se considera necesaria para cerrar 3.3.

La tarea mueve ownership y cálculos existentes sin cambiar controles, apariencia ni flujos de usuario, y cuenta con pruebas directas de los selectores, hooks y wiring Web afectados.

Pendientes / fuera de alcance

* No se realizó ninguna extracción de selección o drag/reorder.
* No se modificaron flujos de importación, descarga, playback, cloud ni runtime.
* No se modificó el roadmap durante la ejecución original.
* No se modificó el archivo de registro durante la ejecución original.
* El riesgo previo ajeno a esta tarea relacionado con snapshots capturados en handleRemoveBulk permanece sin cambios.
* No quedaron herramientas temporales en el árbol final.

Veredicto

Terminada.

Los mismos tipos de entrada de búsqueda, filtros y orden producen los mismos beats y el mismo orden esperado, y la conexión especial Web entre sort y playback continúa preservada.

Siguiente tarea

3.4 — Separar selección y reordenamiento

No iniciada.

La rama de trabajo también quedó en ese mismo commit final.
```

### Registro — 3.4

```
Tarea: 3.4 — Separar selección y reordenamiento
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 811058e833071d41639993fa717c885eb1577cea
- Última tarea verificada: 3.3 — Separar búsqueda, filtros y etiquetas
- El pre-flight encontró implementación versionada de 3.4 ya publicada en el HEAD, mientras agent-state, roadmap y registro todavía la mostraban Pendiente. Se trató como recuperación de una ejecución interrumpida y no se repitió la implementación.

Cambio realizado

- La selección individual, Shift-range, Select All y limpieza de selección viven en `src/features/selection/useBeatSelection.ts`.
- El hook conserva el ancla de rango, reemplaza el rango anterior en Shift y reconcilia IDs seleccionados contra la biblioteca viva.
- El drag/reorder vive en `src/features/library/useLibraryReorder.ts`.
- Se conservó el delay/tolerance del PointerSensor, el cambio a orden manual fuera de rating y el límite que impide mover entre grupos con rating distinto.
- `App.tsx` quedó conectado a ambos hooks y dejó de poseer los estados/handlers extraídos.
- No se inició 4.1 ni se modificó ninguna otra rama.

Adaptación de pruebas

- `tests/component-dom/beatSelection.test.tsx` cubre toggle individual, rango Shift con ancla fija, Select All, reconciliación al filtrar/eliminar beats y limpieza final.
- `tests/integration/selectionReorderExtraction.test.ts` comprueba ownership fuera de App, wiring de selección y conservación de los límites del reorder por rating.
- Las guardas existentes no fueron desactivadas para obtener verde.

Archivos afectados por la implementación recuperada

- src/App.tsx
- src/features/selection/useBeatSelection.ts
- src/features/library/useLibraryReorder.ts
- tests/component-dom/beatSelection.test.tsx
- tests/integration/selectionReorderExtraction.test.ts

Archivos afectados por este cierre

- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary Task 3.4 Apply`, run 34211720605 — SUCCESS.
- npm ci — OK.
- git diff --check — OK.
- npm run test:typecheck — OK.
- npm run test:unit:ts — OK.
- npm run test:component:dom — OK.
- npm run test:integration — OK.
- npm run test:regressions — OK.
- npm run build:web — OK.
- npm run build — OK.

Comprobaciones no ejecutadas

- npm run check — no requerido para esta extracción; el plan reserva el wrapper completo para hitos/cierre y sus checks de extracción se ejecutaron individualmente.
- E2E import/download/recovery — no aplican a selección/reordenamiento.
- Pruebas nativas físicas Windows/macOS — no necesarias para cerrar esta extracción de ownership, sin cambios en adapters ni comandos nativos.

Prueba manual

- No requerida como bloqueo de cierre. La semántica específica de selección Shift, filtrado/reconciliación y límites de reorder quedó cubierta por pruebas directas y de integración.

Pendientes / fuera de alcance

- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y no fue modificado.
- No se inició ninguna extracción de artwork/playback.

Riesgos previos relevantes

- Ninguno nuevo causado por 3.4.

Herramientas temporales restantes

- Ninguna al cerrar: los workflows y scripts temporales de esta ronda se eliminan del árbol final.

Fallos encontrados y causa

- Run 34211385742 terminó en failure únicamente en `Prepare verified commit`; todos los checks de código y builds anteriores habían pasado. Run 34211720605 corrigió la publicación y terminó en success.
- Run 34213532632 no creó jobs porque el primer workflow temporal de cierre tenía YAML inválido; no ejecutó comandos ni modificó código/documentación.
- Run 34213964984 falló antes de editar documentos porque el payload base64 del script temporal quedó truncado (`base64: invalid input`).
- Run 34214167203 aplicó las ediciones solo en el runner pero `git diff --check` rechazó una línea en blanco extra al EOF de `Registro-de-avance.md`; no hubo commit ni push de esas ediciones.

Veredicto

Terminada.

Seleccionar, deseleccionar, usar Shift, reconciliar selección con cambios de biblioteca y reordenar conservan los contratos comprobados, incluido el límite entre ratings distintos.

Siguiente tarea

4.1 — Separar la carga de portadas.

No iniciada.
```

### Registro — 4.1

```
Tarea: 4.1 — Separar la carga de portadas
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial: ab25f9090d9e7ba322748b2ba344fa848fe34e9e
- Última tarea verificada: 3.4 — Separar selección y reordenamiento

Cambio realizado

- Se extrajo `ensureArtworkReady` de `App.tsx` a `src/features/artwork/useArtworkHydration.ts`.
- El nuevo hook posee las promesas de hidratación, deduplicación, lectura/escritura del thumbnail cache, decodificación y carga por `platform.media.loadArtwork`.
- Se conservó el modo cache-only, el fallback de beats sin artwork y la invalidación por beat usada al restaurar desde Trash.
- `App.tsx` conserva solo la composición necesaria para actualizar fingerprints de snapshots tras una hidratación de red, evitando que una carga visual parezca una edición.
- Las limpiezas previas del mapa de promesas ahora llaman `clearArtworkHydration`.

Adaptación de pruebas

- `tests/component-dom/artworkHydration.test.tsx` cubre caché local sin red, deduplicación de carga remota, modo cache-only e invalidación por beat.
- `tests/integration/artworkHydrationExtraction.test.ts` comprueba ownership fuera de App y que el hook no invoque guardado/commit cloud.
- `tests/integration/appHelperExtraction.test.ts` dejó de exigir que App importe directamente el decoder de 2.3 y ahora comprueba que el nuevo dueño de hidratación reutiliza ese helper.

Archivos afectados

- src/App.tsx
- src/features/artwork/useArtworkHydration.ts
- tests/component-dom/artworkHydration.test.tsx
- tests/integration/artworkHydrationExtraction.test.ts
- tests/integration/appHelperExtraction.test.ts
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary Task 4.1 Apply`, run 34216453088 — SUCCESS.
- npm ci — OK.
- git diff --check — OK.
- npm run test:typecheck — OK.
- npm run test:unit:ts — OK.
- npm run test:component:dom — OK.
- npm run test:integration — OK.
- npm run test:regressions — OK.
- npm run build:web — OK.
- npm run build — OK.

Comprobaciones no ejecutadas

- npm run check — no requerido para esta extracción; sus checks relevantes se ejecutaron individualmente.
- E2E import/download/recovery — no aplican a hidratación de artwork.
- Pruebas nativas físicas Windows/macOS — no necesarias: no cambiaron adapters ni comandos nativos.

Prueba manual

- No requerida como bloqueo de cierre; comportamiento de hidratación/caché y ausencia de side effects de guardado están cubiertos directamente.

Pendientes / fuera de alcance

- No se inició 4.2 ni se modificó playback.
- El riesgo previo de `handleRemoveBulk` permanece fuera de alcance.

Riesgos previos relevantes

- Ninguno nuevo causado por 4.1.

Herramientas temporales restantes

- Ninguna: workflow y appliers temporales se eliminaron en el commit verificado.

Fallos encontrados y causa

- Run 34215971033 falló antes de los checks porque el primer applier omitió la invalidación por beat usada al restaurar desde Trash. No publicó implementación.
- Run 34216207764 ejecutó los checks: component DOM falló por un mock nuevo incompatible con el hoisting de `vi.mock`; integration falló porque la prueba histórica de 2.3 estaba acoplada al import directo del decoder desde App. Ambos fallos eran de pruebas y se corrigieron preservando sus contratos.

Veredicto

Terminada.

La carga visual de portadas conserva caché, decodificación, reutilización, invalidación y carga por plataforma sin convertir hidratación en edición o commit cloud.

Siguiente tarea

4.2 — Separar preparación y control del audio.

No iniciada.
```

### Registro — 4.2

```
Tarea: 4.2 — Separar preparación y control del audio
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: c67ddada2b9bde04ebaa052c6e9ef15876a55c1c
- Última tarea verificada: 4.1 — Separar la carga de portadas
- El pre-flight encontró implementación versionada de 4.2 ya publicada, mientras agent-state, roadmap y registro todavía la mostraban Pendiente. Se trató como recuperación de una ejecución interrumpida y no se repitió la implementación.

Cambio realizado

- La preparación, warm URLs temporales, invalidación de caché, eventos de audio y `handlePlay` viven en `src/features/playback/usePlaybackController.ts`.
- Se conserva una sola instancia de audio mediante `hooks/useAudio.ts`; el nuevo controlador recibe el estado y la acción `play` sin crear otro audio.
- Se conservaron rutas separadas Web/Desktop: Web usa `platform.media.preparePlayback`; Desktop conserva warm/cooking, `prepareBeatForPlayback`, estados runtime y diagnósticos.
- La época de caché impide que una promesa iniciada antes de Clear Cache repueble una URL invalidada.
- La invalidación por beat usada al quitar Available Offline quedó delegada a `invalidatePlaybackPreparation`, eliminando las referencias directas de App a los mapas internos.
- El bloqueo por slot/project update y por estados de preparación se conserva dentro del controlador.
- No se inició 4.3.

Adaptación de pruebas

- `tests/integration/appPlaybackExtraction.test.ts` comprueba que preparation, invalidation, eventos y routing salieron de App y quedaron en el controlador.
- `scripts/run-regressions.mjs` se adaptó al nuevo ownership sin debilitar los contratos de audio real, bloqueo de playback, Clear Cache ni Available Offline.
- Las caracterizaciones relacionadas con playback fueron actualizadas para seguir la responsabilidad en su nuevo módulo.

Archivos afectados por la implementación recuperada

- src/App.tsx
- src/features/playback/usePlaybackController.ts
- tests/integration/appPlaybackExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- tests/integration/issue97RuntimeWebFollowup.test.ts
- scripts/run-regressions.mjs

Archivos afectados por este cierre

- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md
- eliminación de workflows y script temporales de Task 4.2

Comprobaciones ejecutadas

- GitHub Actions `Temporary Task 4.2 Final 4`, run 34220274412 — SUCCESS.
- Artifact `migration-check-logs-task-4-2-34220274412` leído: summary.txt confirma PASS en todos los checks.
- git diff --check — PASS.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.

Comprobaciones no ejecutadas

- npm run check — no requerido para esta extracción; sus checks relevantes se ejecutaron individualmente.
- E2E import/download/recovery — no aplican a esta extracción de ownership de playback.
- Pruebas nativas físicas Windows/macOS — no necesarias para cerrar la extracción; no cambiaron comandos nativos ni adapters.

Prueba manual

- No requerida como bloqueo de cierre. Los contratos críticos de Play repetido, cambio de beat, bloqueo durante preparación, rutas Web/Desktop e invalidación de caché están protegidos por integración/regresiones existentes y los builds aplicables.

Pendientes / fuera de alcance

- 4.3 — Separar cola y navegación sigue pendiente y no fue iniciada.
- El riesgo previo de `handleRemoveBulk` permanece fuera de alcance.

Riesgos previos relevantes

- Ninguno nuevo causado por 4.2.

Herramientas temporales restantes

- Ninguna al cerrar; los workflows temporales `task-4-2-final*.yml`, el finalizador y este script se eliminan en el commit de cierre.

Fallos encontrados y causa

- Run 34220059314: todos los checks salvo regressions pasaron. `summary.txt` marcó únicamente `regressions` como FAIL; el log identificó la guarda `Remove from Available Offline can leave a dead durable MASTER URL in the Fast Play Path.` La causa fue ownership incompleto: App todavía manipulaba directamente los mapas de preparación. Se corrigió exponiendo y usando `invalidatePlaybackPreparation(beat.id)` desde el nuevo controlador.
- Run 34220274412 ejecutó la corrección y terminó completamente verde.
- Run 34220965728 no creó jobs porque el primer workflow temporal de cierre tenía YAML inválido; no modificó código ni documentos.

Veredicto

Terminada.

La preparación y el control de audio quedaron fuera de App conservando un solo audio, las diferencias Web/Desktop, los bloqueos de preparación y la invalidación de rutas temporales.

Siguiente tarea

4.3 — Separar la cola y navegación.

No iniciada.
```

### Registro — 4.3

```
Tarea: 4.3 — Separar la cola y navegación
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 73a87721c6c7f01e9c75741a4c028214affdc7ce
- Última tarea verificada: 4.2 — Separar preparación y control del audio

Cambio realizado

- Se creó `src/features/playback/usePlaybackQueue.ts` como dueño de la cola explícita, navegación Next/Previous, shuffle, repeat y avance por final de pista.
- `App.tsx` dejó de poseer `queueIds`, `shuffleEnabled`, `repeatMode`, `showQueue` y `lastHandledEndedSeqRef`; ahora compone el hook y pasa sus acciones/estado al Player.
- Se conservó la prioridad de la cola explícita antes de la navegación normal.
- Se conservó el comportamiento con filtros: si el beat actual está visible se navega por `displayedBeats`; si dejó de pertenecer al filtro se usa la biblioteca viva.
- Se conservó Repeat One al terminar, Repeat Off al final de la lista, shuffle sin repetir inmediatamente el mismo índice cuando hay más de un beat y Previous con seek a cero cuando el progreso supera 0.05.
- El guard de `endedSeq` sigue permitiendo un único avance por evento de fin.
- La reconciliación de la cola contra la biblioteca viva se trasladó al hook, por lo que eliminar uno o varios beats purga automáticamente IDs inválidos y libera audio si el beat reproducido desaparece.
- No se inició 5.1.

Adaptación de pruebas

- Se añadió `tests/integration/appPlaybackQueueExtraction.test.ts` para comprobar que el ownership salió de App y que permanecen los contratos críticos de cola explícita, filtros, repeat, shuffle, `endedSeq` y purga de IDs inválidos.
- No se desactivaron pruebas existentes.

Archivos afectados

- src/App.tsx
- src/features/playback/usePlaybackQueue.ts
- tests/integration/appPlaybackQueueExtraction.test.ts
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary Task 4.3 Retry`, run 34223927012 — SUCCESS.
- Artifact `migration-check-logs-task-4-3-34223927012`: `summary.txt` leído y todos los checks figuran PASS.
- git diff --check — PASS.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.
- Commit de implementación verificada: 33c543769010941f49b1c1c3d5e2be7f9a8ae446.

Comprobaciones no ejecutadas

- npm run check — no requerido para esta extracción; sus checks relevantes se ejecutaron individualmente.
- E2E completos de import/download/recovery — no aplican a cola/navegación.
- Pruebas físicas nativas Windows/macOS — no necesarias para cerrar esta extracción; no cambiaron adapters ni comandos nativos.

Prueba manual

- No requerida como bloqueo de cierre. Los contratos observables de cola, navegación, repeat/shuffle, filtros y eliminación quedaron cubiertos por integración/regresiones y ambos builds.

Pendientes / fuera de alcance

- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y no fue modificado.
- 5.1 — Separar guardado de metadata y artwork queda pendiente; no fue iniciada.

Riesgos previos relevantes

- Ninguno nuevo causado por 4.3.

Herramientas temporales restantes

- Ninguna al cerrar; los workflows temporales de 4.3 se eliminan en el commit de cierre.

Fallos encontrados y causa

- Run 34223774463 falló en `Apply task 4.3 extraction` antes de ejecutar checks. No generó `migration-check-logs-*` porque la matriz de checks no llegó a comenzar y no publicó código de producto. Se clasificó como fallo del applier temporal, no como regresión del producto.
- El retry 34223927012 aplicó la misma extracción con guardas más robustas, ejecutó la matriz completa y terminó SUCCESS.
- Run 34224295357 no creó jobs porque el primer finalizador documental contenía YAML inválido; no modificó código ni documentos.

Veredicto

Terminada.

La cola y navegación quedaron fuera de App preservando prioridad explícita, filtros, Next/Previous, shuffle, repeat, avance único por fin de pista y purga de referencias inválidas al eliminar beats.

Siguiente tarea

5.1 — Separar guardado de metadata y artwork.

No iniciada.
```

### Registro — 5.1

```
Tarea: 5.1 — Separar guardado de metadata y artwork
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: d2afff16996ef1bff658d4604c75b9e1eb8609a9
- Última tarea verificada: 4.3 — Separar la cola y navegación

Cambio realizado

- Se creó `src/features/edit/useDrawerCloudPersistence.ts` como dueño del observer de metadata Desktop, su debounce por beat de 700 ms, la sincronización metadata/artwork, el commit del INDEX y la deduplicación de commits del Drawer.
- `App.tsx` dejó de poseer los timers y refs de deduplicación y ahora compone `useDrawerCloudPersistence`, conservando el mismo callback `commitDrawerCloudMutation` que ya consume `Drawer.tsx`.
- Se preservaron las condiciones Web/Desktop: Web retorna antes del observer legado y mantiene sus commits explícitos por `platform.editor`; Desktop conserva el observer, estados runtime y sincronización Telegram/INDEX.
- Se preservó el orden de guardado: metadata/artwork primero cuando corresponde, después snapshot autoritativo del INDEX y finalmente siembra de fingerprints para evitar un segundo guardado.
- `Drawer.tsx` no fue reorganizado y las operaciones de reemplazo de MASTER/WAV/assets permanecen fuera de esta extracción.

Adaptación de pruebas

- `tests/integration/issue97WebRoutingContract.test.ts` sigue protegiendo que Web no instala el observer Desktop, pero ahora inspecciona el módulo que realmente posee esa responsabilidad.
- `scripts/run-regressions.mjs` sigue exigiendo los marcadores y refs de deduplicación, pero los busca en `useDrawerCloudPersistence.ts` en vez de exigir que permanezcan físicamente en `App.tsx`.
- Estas adaptaciones corrigieron acoplamientos a ubicación interna; no se relajaron los contratos protegidos.

Archivos afectados

- src/App.tsx
- src/features/edit/useDrawerCloudPersistence.ts
- tests/integration/issue97WebRoutingContract.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.1 Apply`, run 34230769729 — SUCCESS.
- GitHub Actions `Task 5.1 Migration Checks`, run 34230888488 — FAILURE inicial. Artifact `migration-check-logs-task-5-1-34230888488` leído: typecheck, unit TS, component DOM, build:web y build PASS; integration/regressions fallaron por assertions acopladas a la ubicación anterior; diff-check no pudo resolver el SHA inicial por checkout shallow.
- GitHub Actions `Task 5.1 Adapt Dedupe Regression`, run 34231568800 — SUCCESS.
- GitHub Actions `Task 5.1 Migration Checks`, run 34231857530 — SUCCESS. Artifact `migration-check-logs-task-5-1-34231857530`, `summary.txt` leído: todos los checks PASS.
- git diff --check d2afff16996ef1bff658d4604c75b9e1eb8609a9..HEAD — PASS.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.
- SHA de implementación/verificación: 90c981976d0e23499d50be80b54e96ef51eeaf7c.

Comprobaciones no ejecutadas

- npm run check — no necesario para esta extracción; los checks relevantes del wrapper se ejecutaron individualmente y quedaron verdes.
- E2E completos de import/download/recovery — no aplican al ownership de metadata/artwork del Drawer.
- Prueba física Desktop Windows/macOS — no ejecutada porque esta ronda opera mediante GitHub Actions y no dispone de una aplicación física interactiva; no es requisito de cierre dado que routing, dedupe, integración, regresiones y ambos builds quedaron cubiertos automáticamente.

Prueba manual

- No ejecutada ni inventada.
- Desktop: abrir un beat, cambiar metadata y/o artwork, guardar, recargar la biblioteca y comprobar persistencia y una sola transacción lógica metadata/artwork + INDEX.
- Web: editar metadata/artwork y comprobar que sigue la ruta `platform.editor`, sin invocar el observer Tauri Desktop.
- Resultado esperado: mismo estado persistido que antes de la extracción y ausencia de un segundo commit duplicado.

Pendientes / fuera de alcance

- 5.2 — Separar reemplazo de archivos de un beat permanece pendiente y no fue iniciada.
- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y sin cambios.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto identificado por 5.1.
- Existe previamente `.github/workflows/probe-task-5.1-productive-temp-auth-compile.yml`; no pertenece a esta extracción y no se modificó ni eliminó.

Herramientas temporales restantes

- Ninguna creada por esta ronda permanece en el árbol final.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` permanece porque ya existía antes de esta ejecución.

Fallos encontrados y causa

- Run 34230888488: integration y regressions fallaron porque dos pruebas existentes estaban acopladas a que el observer y las refs de dedupe vivieran físicamente en `App.tsx`. El comportamiento protegido seguía presente en el nuevo módulo; se adaptaron las pruebas al nuevo ownership sin debilitarlas.
- En ese mismo run, `diff-check` falló por `Invalid revision range` porque el workflow temporal usaba checkout shallow; se corrigió a `fetch-depth: 0`.
- Run 34231349409: el primer applier de adaptación de tests falló antes de publicar cambios porque su búsqueda textual exacta no encontró el bloque; fue un fallo de tooling temporal, no del producto.
- Run 34232243698: el primer finalizador documental fue rechazado por GitHub antes de crear jobs; no ejecutó comandos ni modificó documentación/producto.

Veredicto

Terminada.

El guardado de metadata/artwork y su protección contra duplicados quedaron fuera de `App.tsx` conservando orden, debounce, condiciones Web/Desktop y las mismas escrituras lógicas verificadas por integración, regresiones y builds.

Siguiente tarea

5.2 — Separar reemplazo de archivos de un beat.

No iniciada.
```

### Registro — 5.2

```
Tarea: 5.2 — Separar reemplazo de archivos de un beat
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 731c74df9c958d593184e71c0b9b5e21df71beae
- Última tarea verificada: 5.1 — Separar guardado de metadata y artwork

Cambio realizado

- Se creó `src/features/edit/useBeatAssetUpdates.ts` como dueño de las actualizaciones de assets MASTER/WAV y del coordinador compartido `runBeatCloudUpdate`.
- `App.tsx` dejó de implementar directamente la subida/reemplazo de MASTER y WAV y ahora compone `useBeatAssetUpdates`.
- Desktop conserva la carga del slot correspondiente, actualización de biblioteca, commit autoritativo y espera de playback-ready del nuevo MASTER.
- Web conserva la confirmación de reemplazo de MASTER, `platform.editor.commit`, actualización de biblioteca/Drawer y estados runtime.
- Se conservaron bloqueo/busy del beat, cierre del chooser antes del trabajo largo, transiciones de éxito/conflicto/error, sonido de éxito y limpieza de staging en rechazo/finalización.
- Las operaciones PROJECT continúan temporalmente compuestas por App usando el mismo `runBeatCloudUpdate`; extraer proyectos corresponde a 5.3 y no se inició.

Adaptación de pruebas

- Se añadió `tests/integration/appBeatAssetUpdatesExtraction.test.ts` para proteger el ownership de MASTER/WAV, confirmación, readiness, busy/runtime/cleanup y la frontera temporal con PROJECT.
- `tests/integration/issue97WebRoutingContract.test.ts` dejó de usar `runBeatCloudUpdate` como marcador físico del final de la sección artwork y conserva el mismo contrato Web/Desktop.
- `scripts/regression-phase9cd.mjs` y `scripts/run-regressions.mjs` siguen protegiendo los mismos contratos, leyendo MASTER/WAV y el coordinador desde su nuevo dueño legítimo.
- No se debilitó ningún contrato para hacer pasar los tests.

Archivos afectados

- src/App.tsx
- src/features/edit/useBeatAssetUpdates.ts
- tests/integration/appBeatAssetUpdatesExtraction.test.ts
- tests/integration/issue97WebRoutingContract.test.ts
- scripts/regression-phase9cd.mjs
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.2 Apply`, run 34236380698, attempt 3 — SUCCESS.
- Artifact `migration-check-logs-task-5-2-34236380698` de attempt 3 leído: `summary.txt` confirma PASS en toda la matriz.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.
- SHA de implementación verificada: acc3a14293104bfa62bd0f9cf34f28046378b72c.

Comprobaciones no ejecutadas

- npm run check — no requerido; los checks relevantes del plan fueron ejecutados individualmente por la matriz.
- E2E completos de import/download/recovery — no aplican a la extracción del ownership de reemplazo MASTER/WAV.
- Prueba física Desktop Windows/macOS — no ejecutada; la ronda opera mediante GitHub Actions y no dispone de app física interactiva.

Prueba manual

- No ejecutada ni inventada.
- Desktop: reemplazar MASTER, cancelar una confirmación aplicable, agregar/reemplazar WAV y provocar un error controlado de carga; comprobar card busy, liberación del chooser, readiness del MASTER y limpieza de staging.
- Web: reemplazar MASTER y WAV y comprobar confirmación, actualización de Drawer/biblioteca y error visible.
- Resultado esperado: mismo comportamiento observable y mismas escrituras que antes de la extracción, sin dejar staging ni estados busy colgados.

Pendientes / fuera de alcance

- 5.3 — Separar proyectos permanece pendiente y no fue iniciada.
- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y sin cambios.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto identificado por 5.2.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.

Herramientas temporales restantes

- Ninguna creada por 5.2 permanece tras el commit de cierre; el workflow y scripts temporales de esta tarea se eliminan al finalizar.

Fallos encontrados y causa

- Run 34236149086 no creó jobs por una definición inicial inválida del workflow temporal; no aplicó cambios de producto.
- Run 34236380698, attempt 1: integration y regressions fallaron. La prueba nueva usaba `node:test` bajo Vitest y dos guards existentes estaban acoplados a que responsabilidades vivieran físicamente en `App.tsx`; typecheck, unit, DOM y ambos builds ya pasaban. Se corrigieron las pruebas/guards sin cambiar el contrato.
- Run 34236380698, attempt 2: solo regressions falló porque un guard adicional exigía `const runBeatCloudUpdate` y el evento de éxito en `App.tsx`; ambos contratos ya vivían en `useBeatAssetUpdates.ts`. Se adaptó ese guard al nuevo ownership.
- Run 34236380698, attempt 3: toda la matriz terminó PASS.

Veredicto

Terminada.

El reemplazo de MASTER/WAV y sus estados de trabajo quedó fuera de App preservando confirmaciones, rutas Web/Desktop, preparación del MASTER, bloqueo del beat, errores y cleanup.

Siguiente tarea

5.3 — Separar proyectos.

No iniciada.
```

### Registro — 5.3

```
Tarea: 5.3 — Separar proyectos
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: aad232955feafedf07174a1f4cd137072deb7fb4
- Última tarea verificada: 5.2 — Separar reemplazo de archivos de un beat

Cambio realizado

- Se creó `src/features/projects/useBeatProjects.ts` como dueño de apertura, subida/actualización explícita, reemplazo PROJECT, autoinspección de drops e indicadores de disponibilidad de proyectos.
- `App.tsx` compone `useBeatProjects` y dejó de poseer directamente `handleOpenProject`, `handleUploadProjectTelegram`, `handleUpdateProject`, `hasStoredProject`, `startProjectAssetUpdate`, `startProjectZipReplacement`, `handleAutoProjectDrop`, refresh de indicadores y estado del aviso PROJECT.
- Se conservaron las rutas Desktop de PROJECT file/folder/ZIP, validación, confirmación Replace/Cancel, limpieza de staging y filtrado/avisos de Backup/Backups.
- Web conserva `platform.editor.commit(..., { PROJECT: file })`, actualización de biblioteca/Drawer y transiciones runtime, ahora dentro del módulo de proyectos.
- La actualización de indicadores sigue reaccionando a cambios de beats y a `beatgaler:project-cloud-changed` / `beatgaler:project-cloud-updated`.
- El pipeline automático de subida inicial de beats conserva temporalmente en `App.tsx` su etapa multi-slot que consulta/sube PROJECT junto con MASTER/WAV; no es la operación interactiva de proyecto y se deja como conexión temporal para una extracción cloud posterior.

Adaptación de pruebas

- Se añadió `tests/integration/appBeatProjectsExtraction.test.ts` para proteger ownership, reemplazo, Backup/Backups, rutas Desktop/Web e indicadores.
- `tests/integration/appBeatAssetUpdatesExtraction.test.ts` dejó de exigir la frontera temporal anterior con PROJECT.
- `tests/integration/issue97WebRoutingContract.test.ts` cambió únicamente su marcador físico de sección para seguir protegiendo el orden del flujo artwork tras mover el bloque PROJECT.
- `scripts/regression-phase9cd.mjs` y `scripts/run-regressions.mjs` continúan protegiendo los mismos contratos PROJECT leyendo la implementación desde su nuevo owner; el routing de folder que permanece en App sigue protegido como conexión de composición.
- No se debilitó ningún comportamiento para hacer pasar pruebas.

Archivos afectados

- src/App.tsx
- src/features/projects/useBeatProjects.ts
- tests/integration/appBeatProjectsExtraction.test.ts
- tests/integration/appBeatAssetUpdatesExtraction.test.ts
- tests/integration/issue97WebRoutingContract.test.ts
- scripts/regression-phase9cd.mjs
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.3 Apply`, run 34240215318 — SUCCESS.
- Artifact `migration-check-logs-task-5-3-34240215318` leído: `summary.txt` confirma PASS en toda la matriz.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.
- SHA de implementación verificada: 1d29c9cb1f17c33cf88527851e6afb244600447c.

Comprobaciones no ejecutadas

- npm run check — no requerido; la matriz ejecutó individualmente los checks relevantes del plan.
- E2E completos de import/download/recovery — no aplican a esta extracción de ownership PROJECT.
- Prueba física Desktop Windows/macOS — no ejecutada; esta ronda opera mediante GitHub Actions y no dispone de aplicación física interactiva.

Prueba manual

- No ejecutada ni inventada.
- Desktop: abrir un proyecto disponible, subir/actualizar PROJECT, reemplazar PROJECT ZIP y project file, cancelar reemplazo y probar carpeta con Backup/Backups.
- Web: reemplazar PROJECT ZIP en un beat y comprobar actualización de Drawer/biblioteca.
- Resultado esperado: mismo comportamiento observable anterior, avisos y filtrado Backup/Backups conservados, card busy durante trabajo y disponibilidad actualizada al terminar.

Pendientes / fuera de alcance

- 5.4 — Separar Available Offline permanece pendiente y no fue iniciada.
- El pipeline automático de subida inicial conserva su etapa PROJECT dentro de la orquestación multi-slot de `App.tsx`; mover esa orquestación corresponde a una extracción cloud posterior, no a esta ronda.
- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y sin cambios.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto quedó abierto por 5.3.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.

Herramientas temporales restantes

- Ninguna creada por 5.3 permanece tras el commit de implementación/cierre.

Fallos encontrados y causa

- Run 34239199329 y run 34239422217: la definición inicial del workflow temporal era inválida y GitHub no creó jobs; no publicaron cambios de producto.
- Run 34239445621: fallaron typecheck, integration, regressions y ambos builds. Causa: la primera extracción retiró dos dependencias PROJECT que aún pertenecen al pipeline automático multi-slot, dejó el cierre del aviso apuntando al setter movido y dos pruebas/guards seguían acoplados a la ubicación física anterior. Unit TS y component DOM ya pasaban. Se corrigió ownership/composición sin alterar contratos.
- Run 34239904704: typecheck, unit TS, component DOM, integration y ambos builds pasaron; solo regressions falló porque un guard aún buscaba `inspectProjectDropSource` en `App.tsx`. Se movió el guard al owner real.
- Run 34240215318: toda la matriz terminó PASS y publicó la implementación.

Veredicto

Terminada.

Las operaciones interactivas PROJECT y sus indicadores quedaron fuera de `App.tsx`, con las reglas ZIP, Backup/Backups, rutas Web/Desktop, estados y avisos preservados por la matriz completa.

Siguiente tarea

5.4 — Separar Available Offline.

No iniciada.
```

### Registro — 5.4

```
Tarea: 5.4 — Separar Available Offline
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: ef21985dd5c027dfadbb143a8c2a5a413fef5347
- Última tarea verificada: 5.3 — Separar proyectos

Cambio realizado

- Se creó `src/features/offline/useOfflineAvailability.ts` como owner de creación y eliminación de paquetes Available Offline, incluido `offlineBusyIds` y el flujo completo de `handleToggleOffline`.
- `App.tsx` dejó de llamar directamente `makeBeatAvailableOffline` y `removeBeatOfflineAvailability`; ahora compone `useOfflineAvailability` con conexiones explícitas a biblioteca, runtime y playback.
- Se conservó la separación entre paquete durable y caché temporal: al quitar disponibilidad se libera el audio activo cuando corresponde y se llama `invalidatePlaybackPreparation(beat.id)` antes de borrar el paquete durable.
- Online, quitar Available Offline conserva metadata/artwork vivos, limpia únicamente rutas locales y vuelve a preparar la ruta cloud; offline, el beat se elimina de la biblioteca visible tras retirar su único paquete durable.
- Crear el paquete conserva `DOWNLOAD_STARTED`/`DOWNLOAD_SUCCEEDED`/`DOWNLOAD_FAILED`, `SET_OFFLINE_AVAILABLE`, artwork ya cargado y el sonido de finalización.
- No se modificaron los comandos nativos que almacenan los paquetes bajo almacenamiento durable ni `loadOfflineLibrary`; esta tarea solo cambió ownership/composición React.
- No se inició 5.5.

Adaptación de pruebas

- Se añadió `tests/integration/appOfflineAvailabilityExtraction.test.ts` para caracterizar ownership, creación/eliminación durable, estados runtime, invalidación previa y resultados online/offline.
- `tests/integration/appPlaybackExtraction.test.ts` ahora busca el call site de invalidación en el nuevo owner Offline y sigue exigiendo que la implementación de invalidación pertenezca al playback controller.
- `scripts/run-regressions.mjs` se adaptó para seguir `SET_OFFLINE_AVAILABLE` y el bloque de retirada en `useOfflineAvailability.ts`; conserva las mismas exigencias de Fast Play, warm promises, limpieza de rutas locales y persistencia nativa.
- No se relajó ningún contrato para hacer pasar los checks.

Archivos afectados

- src/App.tsx
- src/features/offline/useOfflineAvailability.ts
- tests/integration/appOfflineAvailabilityExtraction.test.ts
- tests/integration/appPlaybackExtraction.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.4 Apply`, run 34243725534 — SUCCESS.
- Artifact `migration-check-logs-task-5-4-34243725534-1`, `summary.txt` leído: PASS en todos los checks.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- SHA de implementación verificada: 3b437aee8454b392e832b8bce65485be731e045b.

Comprobaciones no ejecutadas

- `npm run check` — no necesario; la matriz de migración ejecutó individualmente los checks aplicables y quedó completamente verde.
- E2E completos de import/upload/download — fuera del alcance de esta extracción de ownership Offline.
- Prueba física Desktop Windows/macOS con reinicio sin red — no disponible en GitHub Actions. No se considera bloqueo porque la implementación nativa durable, `offline_beats`, `loadOfflineLibrary` y la precedencia de paquetes Offline no cambiaron; sus invariantes existentes permanecen protegidas por regressions y ambos builds.

Prueba manual

- No ejecutada ni inventada.
- Desktop: marcar un beat Available Offline, cerrar completamente la aplicación, cortar la red, reabrir y reproducir/abrir los assets incluidos; después reconectar, quitar Available Offline y comprobar que el beat sigue online sin rutas locales obsoletas.
- Resultado esperado: el paquete sobrevive al reinicio sin red; al retirarlo online se conserva el beat cloud y al retirarlo estando offline desaparece de la biblioteca Offline actual.

Pendientes / fuera de alcance

- 5.5 — Separar papelera y restauración queda pendiente y no fue iniciada.
- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y sin cambios.

Riesgos previos relevantes

- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y no fue modificado.
- Ningún riesgo nuevo de producto quedó abierto por 5.4.

Herramientas temporales restantes

- Ninguna creada por 5.4 debe permanecer al cerrar; el workflow/script de aplicación ya fueron eliminados y el finalizador se elimina en el commit de cierre.

Fallos encontrados y causa

- Run 34242040393: YAML inválido antes de crear jobs; fallo de tooling, sin cambios de producto.
- Run 34242602495: el payload base64 del applier temporal estaba corrupto y falló antes de los checks; fallo de tooling, sin commit de producto.
- Run 34242903767: `summary.txt` mostró integration y regressions FAIL. El test nuevo usaba una ruta incompatible con el modo Vitest y guards existentes estaban acoplados a que el call site Offline permaneciera físicamente en App. Se clasificó como prueba nueva incorrecta + pruebas existentes acopladas a implementación interna legítimamente movida.
- Run 34243249623: YAML inválido en el retry, sin jobs ni cambios de producto.
- Run 34243311415: tras la primera adaptación quedaron typecheck/unit/DOM/integration/builds PASS y solo regressions FAIL porque un segundo guard de retirada Offline todavía inspeccionaba `App.tsx`; se trasladó al nuevo owner manteniendo el contrato.
- Run 34243725534: matriz completa y `git diff --check` PASS; commit de implementación publicado.

Veredicto

Terminada.

Available Offline quedó fuera de App conservando paquetes durables, runtime, invalidación de Fast Play antes de borrar, y la diferencia observable entre retirada online y offline.

Siguiente tarea

5.5 — Separar papelera y restauración.

No iniciada.
```

### Registro — 5.5

```
Tarea: 5.5 — Separar papelera y restauración
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 99ec3ad8f27eecad526623a7816971121e33c6ef
- Última tarea verificada: 5.4 — Separar Available Offline

Cambio realizado

- Se creó `src/features/trash/useTrashActions.ts` como owner del borrado individual, borrado masivo y restauración desde Settings.
- `App.tsx` dejó de poseer esos handlers y sus llamadas directas a `recordOfflineTrashIntent`/`removeBeatFromLibrary`; ahora compone el hook.
- Se conservaron confirmaciones/avisos, liberación del audio activo en borrado individual, estados runtime, intents offline y los commits online `move-to-trash`/`bulk-remove`.
- Restore online conserva la regla de no publicar un segundo índice: siembra snapshots, actualiza la vista e hidrata artwork sin llamar `commitSnapshot`; offline sigue recargando `loadOfflineLibrary`.
- No se inició 5.6.

Adaptación de pruebas

- `scripts/run-regressions.mjs` ahora valida las transiciones Trash en el nuevo owner.
- Se añadió un guard de ownership que exige delete/bulk/restore en `useTrashActions`, los dos límites de commit de borrado y ausencia de `commitSnapshot` en restore.
- No se relajaron los guards existentes de Trash, biblioteca vacía, reconciliación offline, Direct index ni runtime.

Archivos afectados

- src/App.tsx
- src/features/trash/useTrashActions.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.5 Trash Actions Applier`, run 34246285595 — SUCCESS.
- `node scripts/run-migration-checks-with-logs.mjs` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- `git diff --check` — PASS antes del commit de implementación.
- SHA de implementación verificada: c5b9843cd093a008a0adaa8a615327c060a7802c.

Comprobaciones no ejecutadas

- `npm run check` — no necesario; la matriz ejecutó individualmente los checks aplicables.
- E2E completos de import/upload/download — fuera del alcance de esta extracción Trash.
- Prueba física Desktop Windows/macOS — no disponible en esta ejecución; no bloquea porque los servicios nativos de Trash/restauración no cambiaron y los contratos quedaron cubiertos por regressions y ambos builds.
- Artifact `migration-check-logs-*` del run exitoso — no generado; el workflow temporal solo lo sube si falla la matriz.

Prueba manual

- No ejecutada ni inventada.
- Desktop online: eliminar un beat reproduciéndose, eliminar varios beats cloud, restaurar desde Settings y recargar.
- Desktop offline: mover uno/varios beats cloud a Trash, restaurar localmente y después reconectar.
- Resultado esperado: mismos avisos, audio liberado, no resurrección tras recarga y restore sin segunda publicación de índice.

Pendientes / fuera de alcance

- 5.6 — Separar el renombrado global de tags queda pendiente y no fue iniciado.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios.

Riesgos previos relevantes

- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y no fue modificado.
- Ningún riesgo nuevo de producto quedó abierto por 5.5.

Herramientas temporales restantes

- Ninguna creada por 5.5 debe permanecer al cerrar; applier/script ya se eliminaron y este finalizador se elimina en el commit de cierre.

Fallos encontrados y causa

- Run 34245897420: primera definición del applier inválida; GitHub no creó jobs. Fallo de tooling, sin cambios de producto.
- Run 34246236588: el mismo workflow inválido volvió a fallar al versionarse el script temporal; sin trabajo de producto.
- Run 34246285595: workflow simplificado, extracción y matriz completa PASS; publicó la implementación y retiró tooling temporal.
- Run 34246671614: primera definición del finalizador documental inválida; no creó jobs ni modificó documentos.

Veredicto

Terminada.

Papelera y restauración quedaron fuera de `App.tsx` conservando borrado individual/masivo, audio, intents offline, runtime, commits explícitos de borrado y la prohibición de doble publicación del índice al restaurar.

Siguiente tarea

5.6 — Separar el renombrado global de tags.

No iniciada.
```

### Registro — 5.6

```
Tarea: 5.6 — Separar el renombrado global de tags
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 3b27e6bee20cffdf763d3d5ccaee45b63a52ba85
- Última tarea verificada: 5.5 — Separar papelera y restauración

Cambio realizado

- Se creó `src/features/tags/useTagRename.ts` como dueño de la operación global de renombrado, sus estados de diálogo/progreso/error y la coordinación con el journal nativo existente.
- Se creó `src/features/tags/components/TagRenameDialog.tsx` y el portal completo salió de `App.tsx` conservando etapas Name/Confirm, conteos, Cancel previo a ejecución, Back, estado Renaming y errores.
- `App.tsx` ahora compone `useTagRename`, abre el flujo desde `TagColorMenu` y renderiza `TagRenameDialog`; dejó de poseer directamente `renameTagEverywhere`, los estados de renombrado y el callback de confirmación.
- Se conserva el orden de metadata: solo cambia el valor de la etiqueta coincidente dentro del arreglo existente y se deduplican resultados igual que antes.
- Tras éxito se conservan la actualización de los mismos beats, `replaceTagFilter(oldTag, newTag)` y `renameTagColor(oldTag, newTag)`.
- Se conserva `registerJob`/`updateJob`, el mensaje `Preparing journal…`, la sanitización de errores y la recuperación delegada al servicio `renameTagEverywhere`.
- No se inició 6.1.

Adaptación de pruebas

- Se añadió `tests/integration/appTagRenameExtraction.test.ts` para proteger ownership, actualización de beats, orden de metadata, filtros/colores, feedback de recuperación y comportamiento del diálogo.
- No se desactivaron ni relajaron pruebas existentes.

Archivos afectados

- src/App.tsx
- src/features/tags/useTagRename.ts
- src/features/tags/components/TagRenameDialog.tsx
- tests/integration/appTagRenameExtraction.test.ts
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 5.6 Retry 2`, run 34249152808 — SUCCESS.
- Artifact `migration-check-logs-task-5-6-34249152808-1`, `summary.txt` leído: PASS en todos los checks.
- `git diff --check` — PASS antes de la matriz.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- SHA de implementación verificada: 92dedbc44ddd3014ac5e5165f3822df8714d67cd.

Comprobaciones no ejecutadas

- `npm run check` — no requerido; la matriz ejecutó individualmente los checks aplicables del plan.
- E2E completos de import/download/recovery — fuera del alcance del renombrado global de tags.
- Prueba física Desktop Windows/macOS — no ejecutada; la ronda trabaja mediante GitHub Actions y no dispone de aplicación física interactiva.

Prueba manual

- No ejecutada ni inventada.
- Desktop: abrir el menú de color de una etiqueta, elegir Renombrar, editar el nombre, comprobar Cancel y Back antes de ejecutar, confirmar y observar conteos/progreso; después verificar que los mismos beats contienen el nuevo tag y que filtro/color siguen al nombre nuevo.
- Resultado esperado: mismo comportamiento anterior, mismo orden de metadata salvo el nombre reemplazado, operación bloqueada durante ejecución y error visible si el servicio falla.

Pendientes / fuera de alcance

- 6.1 — Separar las descargas de exportación queda pendiente y no fue iniciado.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 5.6.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto quedó abierto por 5.6.

Herramientas temporales restantes

- Ninguna creada por 5.6 permanece tras el commit de cierre.

Fallos encontrados y causa

- Run 34248696947: unit TS, component DOM, integration y regressions pasaron; typecheck y ambos builds fallaron porque el primer script de extracción eliminó el import compartido `sanitizeUserVisibleText` aunque `App.tsx` todavía lo usa en otras rutas. No se publicó implementación. Se clasificó como implementación temporal incorrecta.
- Run 34248930428: reprodujo el mismo único fallo porque la corrección automática del script no coincidió con el texto generado; nuevamente no se publicó implementación.
- Run 34249152808 preservó explícitamente el import compartido, toda la matriz quedó verde y publicó la implementación.

Veredicto

Terminada.

El renombrado global de tags, sus estados y su diálogo quedaron fuera de `App.tsx` conservando orden de metadata, actualización de filtros/colores, journal, feedback y errores.

Siguiente tarea

6.1 — Separar las descargas de exportación.

No iniciada.
```

### Registro — 6.1

```
Tarea: 6.1 — Separar las descargas de exportación
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 58371aa0c291d18cf03b81b6a2adb6ed8c27ca31
- Última tarea verificada: 5.6 — Separar el renombrado global de tags

Cambio realizado

- Se creó `src/features/downloads/useBeatDownloads.ts` como owner de la apertura/cierre de Cloud Files, selección de destino, arranque de exportaciones, seguimiento por `taskId`, avisos de progreso/éxito/error y listener de resultados de descargas Desktop.
- `App.tsx` dejó de poseer directamente `handleGetCloudFile`, el listener `beatgaler-download-event`, el estado del modal y el seguimiento de la descarga; ahora compone `useBeatDownloads`.
- Desktop conserva MP3/WAV/PROJECT/ALL, nombres de audio con `[BPM Key]`, selección nativa de archivo/carpeta y `startBackgroundDownload`.
- Cancelar el selector de destino retorna antes de `DOWNLOAD_STARTED` y antes de iniciar el worker nativo, por lo que no crea una descarga ni reclama estado runtime.
- El listener y `trackedDownloadsRef` viven en el hook montado por la aplicación, no en el modal; cerrar Cloud Files solo cierra la UI y no elimina una tarea iniciada.
- La finalización/error se atribuye únicamente a `taskId` iniciados por este owner y no marca como descargado un beat distinto si el modal cambió o se cerró.
- Web reutiliza `platform.downloads.start(beat, kind)` y su promesa `completed`, incluida la cancelación del picker como no-op; no usa el worker Tauri.
- `CloudFilesModal` conserva disponibilidad MP3/WAV/PROJECT usando también los assets autoritativos de Web.
- Los guards de regresión que protegían estos contratos se movieron al nuevo owner sin relajar las invariantes.
- No se inició 6.2.

Adaptación de pruebas

- Se añadió `tests/integration/appBeatDownloadsExtraction.test.ts` para proteger ownership, cancelación antes del worker/runtime, vida de la tarea fuera del modal, atribución por `taskId` y routing Web mediante `platform.downloads`.
- `scripts/run-regressions.mjs` sigue protegiendo runtime, Offline, filename metadata, worker/listener y estado completado, pero busca las responsabilidades de descargas en `useBeatDownloads.ts` donde ahora viven.
- No se desactivaron contratos existentes para hacer pasar la matriz.

Archivos afectados

- src/App.tsx
- src/features/downloads/useBeatDownloads.ts
- src/features/downloads/components/CloudFilesModal.tsx
- tests/integration/appBeatDownloadsExtraction.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 6.1 Apply`, run 34263108889 — SUCCESS.
- Artifact `migration-check-logs-task-6-1-34263108889`, `summary.txt` leído: toda la matriz figura PASS.
- `npm ci` — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- SHA de implementación verificada: de360cdfbf3be7029c5a4df80e097b367efa5e8e.

Comprobaciones no ejecutadas

- `npm run check` — no requerido; la matriz ejecutó individualmente los checks aplicables y quedó completamente verde.
- `npm run test:e2e:downloads` — no aporta verificación de esta extracción: `run-downloads-e2e.mjs` activa `BEATGALER_E2E_DOWNLOADS=1` y el runner sustituye `<App />` por `E2EDownloadsHarness`, por lo que no monta ni ejercita `useBeatDownloads`.
- E2E de import/recovery — fuera del alcance de esta extracción.
- Prueba física Desktop Windows/macOS — no ejecutada; la ronda trabaja mediante GitHub Actions y no dispone de una aplicación física interactiva.

Prueba manual

- No ejecutada ni inventada.
- Desktop: abrir Cloud Files, iniciar una exportación y cerrar inmediatamente el modal; comprobar que la descarga sigue y que su resultado se atribuye al beat/tipo correctos. Repetir cancelando el selector de destino y comprobar que no aparece descarga ni estado downloading.
- Web: iniciar MP3/WAV/PROJECT/ALL cuando exista el asset, cancelar el picker y repetir completándolo.
- Resultado esperado: cerrar la UI no cancela una tarea ya iniciada; cancelar el destino no inicia ninguna; Web sigue su adapter existente y Desktop conserva el worker nativo.

Pendientes / fuera de alcance

- 6.2 — Separar recuperación y errores de uploads queda pendiente y no fue iniciado.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.1.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` ya existía antes de esta ronda y permanece sin cambios.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto quedó abierto por 6.1.

Herramientas temporales restantes

- Ninguna creada por 6.1 debe permanecer tras este commit de cierre. Los appliers/workflows temporales ya fueron retirados y `migration-check-logs/summary.txt` se eliminó del árbol; la evidencia queda en el artifact del run final.

Fallos encontrados y causa

- Run 34260567832: GitHub rechazó la primera definición temporal antes de crear job; fallo de tooling, sin implementación publicada.
- Run 34260842953: unit TS, component DOM e integration pasaron; typecheck/builds fallaron porque el applier retiró `listCloudFilesForBeat`, todavía usado por otra ruta de App, y regressions falló porque guards de filename seguían acoplados físicamente a App. Se restauró el import compartido y se siguió el nuevo owner sin debilitar contratos.
- Run 34261109234: typecheck, unit TS, component DOM, integration y ambos builds pasaron; solo regressions falló porque el guard esperaba la forma `const audioSafeBase = exportMeta`. Se conservó esa forma dentro del nuevo owner.
- Run 34261406758: definición temporal inválida; no creó jobs ni artifacts.
- Run 34261510743: todos los checks salvo regressions pasaron; un guard de la máquina runtime seguía exigiendo `DOWNLOAD_STARTED` físicamente en App. Se mantuvieron los otros flows en App y se movió solo la comprobación de descarga al nuevo owner.
- Run 34261807383: todos los checks salvo regressions pasaron; guards Offline/worker/listener/completion seguían acoplados a App. Se trasladaron juntos al owner real manteniendo sus invariantes.
- Run 34263108889: toda la matriz quedó PASS, publicó `de360cdfbf3be7029c5a4df80e097b367efa5e8e` y retiró el tooling temporal de aplicación.

Veredicto

Terminada.

Las descargas de exportación quedaron fuera de `App.tsx` conservando MP3/WAV/PROJECT/ALL, paquetes Offline, diferencias Web/Desktop, cancelación del destino, vida de la tarea al cerrar el modal y atribución estricta de resultados por `taskId`.

Siguiente tarea

6.2 — Separar recuperación y errores de uploads.

No iniciada.
```

### Registro — 6.2

```
Tarea: 6.2 — Separar recuperación y errores de uploads
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 6ff13625a6f4623d793e70bde21f655e7147b1d9
- Última tarea verificada: 6.1 — Separar las descargas de exportación

Cambio realizado

- `src/features/cloud/interruptedUploadJournal.ts` pasó de poseer solo el marcador local a poseer también la reconciliación de una subida interrumpida contra el INDEX autoritativo.
- La recuperación conserva la semántica fail-closed: un beat ya presente en el INDEX solo pierde el marcador local; si el INDEX no puede verificarse no se borra nada; si el rollback remoto/local falla el marcador permanece para un lanzamiento posterior.
- `App.tsx` conserva el punto de llamada de startup y le entrega al módulo las dependencias concretas de sesión, base Cloud y purga local; dejó de contener la implementación de rollback.
- Se creó `src/features/cloud/uploadErrorDetails.ts` como dueño de los detalles de error de sesión, fallo por etapa y preparación de playback posterior al upload, conservando mensajes, hints, etapa, plataforma y sanitización visible.
- El estado `backgroundUploadErrors` y el pipeline siguen en App porque su extracción completa pertenece a 6.3/6.4; 6.2 solo mueve recuperación y construcción de detalles.
- No se inició 6.3.

Adaptación de pruebas

- `tests/integration/appUploadRecoveryExtraction.test.ts` verifica con comportamiento ejecutable que un beat durable no se purga, autoridad desconocida difiere toda limpieza, un rollback fallido conserva el marcador y los detalles de error mantienen contexto útil/sanitizado.
- `tests/integration/appMigrationCharacterization.test.ts` sigue protegiendo la recuperación fail-closed pero ahora apunta al owner real en `interruptedUploadJournal.ts` y reconoce `uploadErrorDetails.ts`.
- `scripts/run-regressions.mjs` movió únicamente los guards de recovery al owner nuevo y añadió un guard del owner/sanitización de errores; no se debilitaron invariantes.

Archivos afectados

- src/App.tsx
- src/features/cloud/interruptedUploadJournal.ts
- src/features/cloud/uploadErrorDetails.ts
- tests/integration/appUploadRecoveryExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 6.2 Apply`, run 34265690210 — SUCCESS.
- Artifact `migration-check-logs-task-6-2-34265690210` — matriz completa publicada.
- `npm ci` — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- SHA de implementación verificada: 9ffc4f260c2c3f3dde161c21723e929501880a04.

Comprobaciones no ejecutadas

- `npm run check` — no ejecutado como wrapper; sus checks relevantes fueron ejecutados individualmente, incluyendo tests y build.
- `npm run test:e2e:recovery` — no valida esta extracción productiva: `BEATGALER_E2E_RECOVERY=1` reemplaza `<App />` por `E2ERecoveryHarness`, un harness genérico que no importa `interruptedUploadJournal.ts` ni `uploadErrorDetails.ts`.
- Prueba física Desktop Windows/macOS — no ejecutada; esta ronda trabaja directamente en GitHub Actions y no dispone de una app física interactiva.

Prueba manual

- No ejecutada ni inventada.
- Desktop: iniciar un import/upload, interrumpir el proceso antes del commit del INDEX y reiniciar; con autoridad Cloud disponible el beat incompleto debe limpiarse y mostrarse el aviso.
- Desktop, caso durable: interrumpir después de que el INDEX ya contenga el beat pero antes de limpiar el marcador; al reiniciar no debe purgar media local/Cloud del beat confirmado.
- Desktop, sin autoridad: iniciar con Cloud no verificable; el marcador debe conservarse y no debe borrarse el beat hasta un lanzamiento donde el INDEX pueda comprobarse.
- Resultado esperado: ninguna subida confirmada se elimina por un marcador viejo y los errores siguen mostrando beat/etapa/plataforma/hint útil.

Pendientes / fuera de alcance

- 6.3 — Separar el proceso de subida de un beat queda pendiente y no fue iniciado.
- El estado/cola completa de background uploads sigue en App y corresponde a 6.3/6.4.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.2.
- El workflow histórico `probe-task-5.1-productive-temp-auth-compile.yml` permanece fuera de alcance.

Riesgos previos relevantes

- Ningún riesgo nuevo de integridad quedó abierto por 6.2; la limpieza destructiva sigue condicionada a autoridad conocida.

Herramientas temporales restantes

- Ninguna creada por 6.2 debe permanecer en el árbol final; el applier y workflow temporales se eliminan en el commit de cierre.

Fallos encontrados y causa

- Run 34264928942: el aplicador temporal falló antes de modificar código productivo porque una sustitución textual del bloque de error de sesión no coincidió; la matriz no llegó a ejecutarse y el artifact no pudo generarse. Se corrigió únicamente el tooling de aplicación.
- Run 34265197531: el aplicador endurecido duplicó el encabezado `function BeatGalerApp()` al retirar la función local. Unit TS, component DOM, integration y regressions pasaron; typecheck y ambos builds fallaron en `src/App.tsx:126` con TS1144. Se corrigió únicamente esa transformación.
- Run 34265464482: la transformación ya era sintácticamente válida, pero el import nuevo había retirado `readActiveCloudUploads` aunque App conserva una lectura del journal en startup. Unit TS, component DOM, integration y regressions pasaron; typecheck y ambos builds fallaron por TS2304 en `src/App.tsx:429`. Se preservó ese import, sin ampliar alcance.
- Run 34265690210: aplicación corregida y matriz completa PASS.

Veredicto

Terminada.

La recuperación de uploads y sus detalles de error quedaron fuera de App sin cambiar la frontera de autoridad: INDEX confirmado preserva el beat, autoridad desconocida difiere limpieza y un rollback fallido conserva el marcador.

Siguiente tarea

6.3 — Separar el proceso de subida de un beat.

No iniciada.
```

### Registro — 6.3

```
Tarea: 6.3 — Separar el proceso de subida de un beat
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 988a0e2af912a06a0d186008de8f6b0a3d28f64e
- SHA de implementación validada: 92760230798fcd8ca1464ea0eff3a07389939562
- Última tarea verificada: 6.2 — Separar recuperación y errores de uploads

Cambio realizado

- Se creó `src/features/cloud/desktopBeatUploadPipeline.ts` como dueño de la secuencia asíncrona Desktop por beat.
- El pipeline recibe dependencias y acciones explícitas; `cloudifyImportedBeats` conserva la cola, la verificación de sesión, la ruta Web y la coordinación entre beats.
- Se preservó el orden MASTER → WAV → PROJECT → detach local → metadata/artwork → commit del INDEX por beat → limpieza del marcador → preparación de playback.
- Retry conserva checkpoints: un MASTER existente, WAV ya presente y PROJECT sincronizado se omiten en lugar de subirse de nuevo.
- La frontera durable queda explícita: después del commit del INDEX se marca `syncCommitted`, se limpia el marcador y solo entonces se prepara playback. Un fallo posterior conserva `remoteUploadCompleted=true`/`syncCommitted=true` y no convierte la subida durable en una interrupción recuperable.
- La cola completa, IDs activos, drenado y Reload diferido permanecen en App para 6.4. La ruta Web `platform.cloudData.commitImportedBeat` no se movió.

Adaptación de pruebas

- Se añadió `tests/integration/appDesktopBeatUploadPipelineExtraction.test.ts` con pruebas ejecutables de checkpoints de retry, orden INDEX→marker→playback, fallo antes del límite durable y fallo de playback después del commit.
- `tests/integration/appMigrationCharacterization.test.ts` ahora sigue la secuencia Desktop en su nuevo owner y conserva en App las guardas de routing Web/cola.
- `scripts/run-regressions.mjs` sigue protegiendo PLAYBACK_PREPARING/UPLOAD_COMPLETE y ahora verifica en el pipeline el orden detach → INDEX commit → clear marker → playback readiness.

Archivos afectados

- src/App.tsx
- src/features/cloud/desktopBeatUploadPipeline.ts
- tests/integration/appDesktopBeatUploadPipelineExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 6.3 Apply`, run 34270478542 — SUCCESS.
- Artifact `migration-check-logs-task-6-3-34270478542` generado con la matriz completa.
- `npm ci` — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- Los checks anteriores validaron el SHA de implementación `92760230798fcd8ca1464ea0eff3a07389939562`.

Comprobaciones no ejecutadas

- `npm run check` — no requerido para esta extracción; la matriz ejecutó individualmente los checks aplicables del plan.
- E2E completos de import/download/recovery — no se usaron como evidencia de 6.3 porque los harness existentes no ejercitan directamente este pipeline extraído.
- Prueba física Desktop Windows/macOS — no ejecutada; la ronda trabaja mediante GitHub Actions sin una aplicación física interactiva.

Prueba manual

- No ejecutada ni inventada.
- Desktop sugerido: interrumpir/reintentar después de MASTER, WAV y PROJECT; comprobar que los slots existentes no se repiten. Provocar además un fallo de preparación de playback después del commit del INDEX.
- Resultado esperado: retry continúa desde el primer checkpoint faltante; tras un commit durable, un fallo de playback deja el beat en Cloud y no restaura el marcador de recuperación.

Pendientes / fuera de alcance

- 6.4 — Separar la cola de uploads queda pendiente y no fue iniciada.
- La verificación de sesión, secuencialidad de la cola, IDs activos, timers de finalización, limpieza de staging al drenar y Reload diferido permanecen en App para 6.4.
- El riesgo previo de `handleRemoveBulk` con el snapshot `beats` capturado permanece sin cambios y fuera del alcance de 6.3.

Riesgos previos relevantes

- Ningún riesgo nuevo de integridad quedó abierto por 6.3.

Herramientas temporales restantes

- Ninguna creada por 6.3 debe permanecer tras el commit de cierre; el applier y workflow temporales se eliminan al finalizar.

Fallos encontrados y causa

- Ninguno en el run final 34270478542; la matriz aplicable quedó verde.

Veredicto

Terminada.

El proceso Desktop por beat salió de `App.tsx` conservando checkpoints, frontera durable por beat y separación entre commit Cloud y preparación de playback.

Siguiente tarea

6.4 — Separar la cola de uploads.

No iniciada.
```

### Registro — 6.4

```
Tarea: 6.4 — Separar la cola de uploads
Estado: Terminada
Fecha: 2026-09-08

Base:
- Rama: v0.9.0-test-noche
- SHA inicial: 0ef4255d528e726dd278ba7389575f6d260fe333
- SHA de implementación validada: f9b7029a807966837c39e0844dac03c063024ce3
- Última tarea verificada: 6.3 — Separar el proceso de subida de un beat.

Cambio realizado:
- Se extrajo de App.tsx la cola de uploads a src/features/cloud/useCloudUploadQueue.ts.
- El hook es dueño de cola Desktop, IDs activos, errores por beat, retry, timers de finalización y Reload diferido.
- Desktop conserva FIFO/secuencialidad y cada beat sigue pasando por runDesktopBeatUploadPipeline de 6.3.
- Web conserva platform.cloudData.commitImportedBeat como ruta separada.
- Review/import siguen en App.tsx; la cola solo consulta dos conexiones pequeñas de lectura para proteger staging.
- Reload delega el diferimiento al hook y el evento existente se dispara solo cuando no queda trabajo de upload activo o en cola.

Adaptación de pruebas:
- Se agregó appCloudUploadQueueExtraction.test.ts para ownership, orden, Web/Desktop, staging, retry y Reload.
- appMigrationCharacterization.test.ts, issue97RuntimeWebFollowup.test.ts y run-regressions.mjs siguen al owner real después de la extracción.
- Los fallos iniciales de integration/regressions fueron clasificados como pruebas/guardas estáticas acopladas a App.tsx; no requirieron cambiar la lógica de producción extraída.

Archivos afectados:
- src/App.tsx
- src/features/cloud/useCloudUploadQueue.ts
- tests/integration/appCloudUploadQueueExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- tests/integration/issue97RuntimeWebFollowup.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md
- tooling temporal .github/task-6-4*.py y workflows task-6-4-*.yml — eliminado al cierre.

Comprobaciones ejecutadas:
- Task 6.4 Apply / run 34275548952 / attempt 3: matriz de implementación completa PASS antes de publicar f9b7029a807966837c39e0844dac03c063024ce3.
- npm ci: PASS.
- git diff --check: PASS.
- npm run test:typecheck: PASS.
- npm run test:unit:ts: PASS.
- npm run test:component:dom: PASS.
- npm run test:integration: PASS.
- npm run test:regressions: PASS.
- npm run build:web: PASS.
- npm run build: PASS.
- Task 6.4 Close / run 34283423653: repite la misma matriz después de eliminar todo el tooling temporal y escribir roadmap/registro.

Comprobaciones no ejecutadas:
- Prueba manual Desktop física: no requerida para esta extracción estructural; la matriz automatizada cubre los contratos modificados.
- E2E completos ajenos al alcance de 6.4: no ejecutados.

Prueba manual:
- No requerida.

Pendientes / fuera de alcance:
- 7.1 — Separar Review y sus acciones básicas.
- Cuando Review tenga owner propio, sustituir las conexiones temporales isReviewActive / hasProtectedStaging sin perder protección de staging.

Riesgos previos relevantes:
- Se conserva la frontera durable del pipeline 6.3.

Herramientas temporales restantes:
- Ninguna al cierre.

Veredicto:
- Terminada, sujeto a PASS de la revalidación de cierre del run 34283423653.

Siguiente tarea:
- 7.1 — Separar Review y sus acciones básicas. No iniciada.
```

### Registro — 7.1

```
Tarea: 7.1 — Separar Review y sus acciones básicas
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 182717a81061534658ab5b688e9808a5f38075f1
- SHA de implementación validada: af916fd729d2ef6ceef16c8ce73b9caf84c4f657
- Última tarea verificada: 6.4 — Separar la cola de uploads

Cambio realizado

- Se creó `src/features/import/useImportSession.ts` como owner del estado básico de Review: candidatos, posición actual, total/batch/preparing, snapshot vivo de la cola y fuentes omitidas.
- Se creó `src/features/import/useImportReview.ts` como owner de las acciones básicas Save, Skip y Cancel.
- Se creó `src/features/import/components/ImportReviewHost.tsx` como host del skeleton/Drawer de Review y su wiring básico.
- `App.tsx` dejó de poseer directamente el estado/acciones/render básico de Review y ahora compone esos owners.
- Save conserva el límite anterior: solo el beat guardado entra a la biblioteca y se entrega a `useCloudUploadQueue` mediante `cloudifyImportedBeats([updated])`.
- Skip conserva candidatos fuera de la biblioteca, libera la fuente correspondiente cuando aplica y avanza el mismo cursor.
- Cancel conserva beats ya guardados, libera únicamente la cola pendiente desde la posición actual, descarta el batch y protege staging todavía en uso.
- El descubrimiento incremental permanece en App para 7.2; Save All/conflictos permanece en App para 7.3; la entrada Web permanece para 7.4.

Adaptación de pruebas

- Se añadió `tests/component-dom/importReviewBasics.test.tsx` para ejecutar Save, Skip y Cancel sobre dos/tres candidatos y comprobar biblioteca, cola de uploads, liberación, descarte y protección de staging.
- `tests/integration/appMigrationCharacterization.test.ts` ahora sigue los contratos de Review en `useImportSession.ts`, `useImportReview.ts` e `ImportReviewHost.tsx` en vez de exigir que vivan físicamente en `App.tsx`.
- `tests/integration/libraryStateExtraction.test.ts` conserva el contrato de timing de `beatsLatestRef` contando también la escritura legítimamente movida a `useImportReview.ts`.
- No se relajó comportamiento para hacer pasar tests; las adaptaciones fueron por cambio legítimo de ownership.

Archivos afectados

- src/App.tsx
- src/features/import/useImportSession.ts
- src/features/import/useImportReview.ts
- src/features/import/components/ImportReviewHost.tsx
- tests/component-dom/importReviewBasics.test.tsx
- tests/integration/appMigrationCharacterization.test.ts
- tests/integration/libraryStateExtraction.test.ts
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary task 7.1 applier`, run 34284804500 — SUCCESS: `npm run test:typecheck` y `npx vitest run tests/component-dom/importReviewBasics.test.tsx --environment jsdom` PASS antes del commit de implementación inicial.
- GitHub Actions `Temporary task 7.1 final validator`, run 34285851953 — SUCCESS.
- Focused Review characterization en run 34285851953 — PASS.
- Artifact `migration-check-logs-34285851953-1`, `summary.txt` leído: matriz completa PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- SHA de implementación validada por esa matriz: af916fd729d2ef6ceef16c8ce73b9caf84c4f657.
- `git diff --check` desde el SHA inicial hasta el árbol de cierre — PASS antes del commit documental final.

Comprobaciones no ejecutadas

- `npm run check` — no requerido como wrapper; la matriz ejecutó individualmente los checks aplicables.
- E2E completos de import/upload — no usados como criterio de cierre de esta extracción básica; los contratos modificados quedaron cubiertos por component DOM, integración, regresiones y builds.
- Prueba física Desktop/Web interactiva — no ejecutada ni inventada; GitHub Actions no proporciona esa interacción. No bloquea 7.1 porque no cambiaron adapters nativos/web y los contratos básicos quedaron ejecutados automáticamente.

Prueba manual

- No requerida como bloqueo.
- Verificación opcional Desktop/Web: importar al menos dos beats; guardar el primero, omitir el segundo y repetir con un lote donde se guarde uno antes de Cancel.
- Resultado esperado: solo los guardados aparecen en biblioteca/subida; Skip no añade el candidato; Cancel conserva lo ya guardado y no reabre/libera fuentes todavía necesarias incorrectamente.

Pendientes / fuera de alcance

- 7.2 — Separar descubrimiento incremental.
- 7.3 — Separar Save All y conflictos.
- 7.4 — Separar la entrada de importación web.
- Las conexiones pequeñas de lectura entre `useCloudUploadQueue` y el estado de Review continúan cableadas desde App sin ampliar el alcance de 7.1.

Riesgos previos relevantes

- El riesgo previo de `handleRemoveBulk` con snapshots capturados permanece fuera de alcance y no fue modificado.
- Ningún riesgo nuevo de producto quedó abierto por 7.1.

Herramientas temporales restantes

- Ninguna al cierre; los workflows temporales usados para aplicar/validar se eliminaron del árbol.

Fallos encontrados y causa

- Run 34284927727: `test:integration` falló porque dos tests existentes exigían que Review y una escritura de `beatsLatestRef` permanecieran físicamente en `App.tsx`; se clasificaron como pruebas acopladas al ownership anterior y se adaptaron al nuevo owner.
- Run 34285267871: quedó una sola assertion nueva incorrecta al ordenar `cleanupUnusedStaging()` usando su primera aparición global; no fue regresión de producto.
- Run 34285533759: quedó una sola assertion nueva incorrecta al tomar el primer `return null` de Cancel en lugar del retorno final posterior al cleanup; no fue regresión de producto.
- Run 34285736877: workflow temporal inválido; GitHub no creó jobs y no modificó producto ni documentación.
- Run 34285851953: focused checks y matriz completa PASS sobre el HEAD limpio validado.

Veredicto

Terminada.

Review básico quedó fuera de `App.tsx`: candidatos/sesión, Save, Skip, Cancel y host tienen owners dedicados; los mismos beats entran o no a biblioteca/subida que antes, y Cancel conserva lo ya guardado.

Siguiente tarea

7.2 — Separar descubrimiento incremental.

No iniciada.
```

### Registro — 7.2

```
Tarea: 7.2 — Separar descubrimiento incremental
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 01e4c439ef4e251a5c94d0d46b907bfdf0745e3b
- SHA de implementación validada: 8923a1790b9dd0d126760ae54908678a44f78025
- Última tarea verificada: 7.1 — Separar Review y sus acciones básicas

Cambio realizado

- Se creó `src/features/import/useImportDiscovery.ts` como dueño del descubrimiento/preparación incremental de Review.
- El hook posee el bootstrap visual, las generaciones de cancelación/reemplazo, el cursor de preparación, el worker secuencial de Beat 2..N y la promesa compartida que Save All espera mientras 7.3 siga en App.
- `App.tsx` dejó de poseer `startImportReviewStream`, `prepareNextImportReviewBeat`, `getImportReviewBatchSummary`, `reviewPreparationRunRef`, `importReviewRequestRunRef` y el cuerpo de `importDroppedPaths`.
- Se preservó el camino crítico: crear stream, preparar solo Beat 1, publicar Review, esperar un frame y recién entonces continuar Beat 2..N en background con yields entre pasos.
- Cancel/reemplazo incrementan generaciones; resultados tardíos solo se descartan y no pueden volver a abrir candidatos antiguos.
- La entrada Web permanece en App para 7.4. Usa `completeImmediateReviewPreparation()` como conexión mínima para cerrar el estado visual de discovery sin mover esa entrada antes de tiempo.
- Save All y conflictos permanecen en App para 7.3 y siguen esperando `reviewPreparationPromiseRef.current`.

Adaptación de pruebas

- Se añadió `tests/component-dom/importDiscovery.test.tsx`: verifica que Beat 1 aparezca antes de terminar el escaneo y que un stream que resuelve después de Cancel se descarte sin reabrir Review.
- Se añadió `tests/integration/appImportDiscoveryExtraction.test.ts`: protege ownership, orden skeleton → stream → Beat 1 → frame → background y generaciones obsoletas.
- `tests/integration/appMigrationCharacterization.test.ts` se adaptó al nuevo límite de ownership sin relajar los contratos de Review.
- `scripts/run-regressions.mjs` sigue protegiendo el worker incremental desde su nuevo owner.
- `scripts/regression-import-native.mjs` sigue comprobando que el drop nativo entra al stream incremental, leyendo la creación/ejecución del stream en `useImportDiscovery.ts` en lugar de exigirla físicamente en App.

Archivos afectados

- src/App.tsx
- src/features/import/useImportDiscovery.ts
- tests/component-dom/importDiscovery.test.tsx
- tests/integration/appImportDiscoveryExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- scripts/run-regressions.mjs
- scripts/regression-import-native.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary task 7.2 retry 3`, run 34287602453 — SUCCESS.
- `git diff --check` — PASS.
- Pruebas focalizadas de 7.2 — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- Artifact de la corrida final: `summary.txt` indicó `Migration checks: PASS` y los siete checks anteriores PASS.
- El `summary.txt` generado por el runner se retiró del árbol después de usarlo como evidencia; no forma parte del producto.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente todos los checks aplicables del plan.
- Prueba física Desktop Windows/macOS no ejecutada; esta extracción se validó en GitHub Actions y no cambia comandos nativos ni el algoritmo Rust de discovery.
- E2E completos ajenos al flujo de discovery incremental no fueron necesarios para cerrar esta extracción.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: arrastrar una carpeta grande con varios beats y comprobar que Review del primer beat aparece antes de completar el escaneo; cancelar mientras el descubrimiento continúa y comprobar que ningún candidato antiguo reaparece.

Pendientes / fuera de alcance

- 7.3 — Separar Save All y conflictos queda pendiente y no fue iniciada.
- 7.4 — Separar la entrada de importación web permanece pendiente.
- Save All conserva temporalmente la conexión a `reviewPreparationPromiseRef` hasta 7.3.

Riesgos previos relevantes

- No se identificó un nuevo riesgo de producto causado por 7.2.

Herramientas temporales restantes

- Ninguna creada por 7.2 debe permanecer al cerrar. Los appliers, scripts auxiliares y el closer se eliminan del árbol final.

Fallos encontrados y causa

- Run 34286938464 falló antes de tocar producto por una búsqueda textual frágil del aplicador; no publicó código.
- Un retry intermedio fue rechazado por YAML antes de crear jobs; no ejecutó código ni modificó producto.
- Run 34287215740 llegó a typecheck y detectó que la entrada Web todavía necesitaba cerrar `reviewPreparationDone`/`reviewBootstrap`; se resolvió con una conexión mínima `completeImmediateReviewPreparation()` sin adelantar 7.4. No publicó producto.
- Run 34287376904 pasó typecheck, pruebas focalizadas, unit, component DOM, integración y builds; solo falló regressions porque `regression-import-native.mjs` exigía `startImportReviewStream(normalized)` físicamente en App. Se adaptó el guard al nuevo owner sin relajar el contrato.
- Run 34287602453 quedó completamente verde y publicó la implementación validada.

Veredicto

Terminada.

El descubrimiento incremental salió de `App.tsx` conservando Review temprano de Beat 1, worker secuencial para el resto y cancelación/reemplazo segura de resultados obsoletos.

Siguiente tarea

7.3 — Separar Save All y conflictos.

No iniciada.
```

### Registro — 7.3

```
Tarea: 7.3 — Separar Save All y conflictos
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 76729479a4947d27626654464defb844a98db031
- SHA de implementación validada: de32aab99da86942aa71a83e992f9f371ae3f44f
- HEAD limpio después de retirar el summary generado por CI y antes del cierre documental: a309b9c197ac835306b2ee8be5197c6a3b13a980
- Última tarea verificada: 7.2 — Separar descubrimiento incremental

Cambio realizado

- Se creó `src/features/import/useImportSaveAll.ts` como owner de Save All y del estado/callbacks de conflictos nativos y decisiones pendientes.
- Save All cierra Review inmediatamente, incorpora el beat actual a la biblioteca y lo entrega a la cola cloud antes de esperar la preparación del resto.
- Los beats restantes reutilizan la misma `reviewPreparationPromiseRef` del worker secuencial de 7.2; los candidatos válidos se guardan en secuencia con yields y se suben sin reabrir Review uno por uno.
- Nombres duplicados y errores de validación/guardado se acumulan y vuelven a Review al final para resolución manual.
- `useImportDiscovery.ts` conserva el resumen diferido del batch, mientras `useImportSaveAll.ts` posee `audioConflictBatch` y `dropImportBatch` y decide cuándo mostrar cada resolución después de cerrar Review normal.
- `ImportReviewHost.tsx` exporta `ImportResolutionHost`, que conecta los modales existentes `ImportAudioConflictsModal` e `ImportDecisionsModal` sin duplicar su comportamiento.
- Se preservó la protección de staging: al importar decisiones resueltas se elimina primero la entrada del mapa capturado; el cierre posterior puede ejecutar `cleanup([])`, que no borra archivos todavía referenciados por los beats importados.
- La entrada de importación Web permanece en `App.tsx` para 7.4. Hasta entonces recibe únicamente un puente temporal de los setters de conflicto desde `useImportSaveAll`.
- Se preservó el uso independiente de `saveBeatMeta` que `App.tsx` todavía necesita para la transacción Desktop de metadata/artwork; la extracción de Save All no tomó ese flujo ajeno.
- No se inició 7.4.

Adaptación de pruebas

- Se añadió `tests/component-dom/importSaveAll.test.tsx` para ejecutar cierre inmediato, preparación restante, duplicados y protección de staging en conflictos/decisiones.
- Se añadió `tests/integration/appImportSaveAllExtraction.test.ts` para proteger ownership y orden del nuevo flujo.
- `tests/integration/appImportDiscoveryExtraction.test.ts` y `tests/integration/appMigrationCharacterization.test.ts` siguen la promesa de preparación y Save All en su nuevo owner.
- `tests/integration/libraryStateExtraction.test.ts` sigue contando las escrituras síncronas de `beatsLatestRef` también en `useImportSaveAll`, sin reducir el umbral histórico.
- `scripts/run-regressions.mjs` sigue los invariantes de Save All desde el nuevo módulo.

Archivos afectados

- src/App.tsx
- src/features/import/useImportDiscovery.ts
- src/features/import/useImportSaveAll.ts
- src/features/import/components/ImportReviewHost.tsx
- tests/component-dom/importSaveAll.test.tsx
- tests/component-dom/importDiscovery.test.tsx
- tests/integration/appImportSaveAllExtraction.test.ts
- tests/integration/appImportDiscoveryExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- tests/integration/libraryStateExtraction.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary task 7.3 apply`, run 34296950583 — SUCCESS.
- Guard de exclusividad de `v0.9.0-test-noche` — PASS.
- `git diff --check` antes de la validación — PASS.
- Pruebas focalizadas de 7.3, incluidas las de library-state afectadas — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- La matriz completa de siete checks quedó verde antes de publicar el commit `de32aab99da86942aa71a83e992f9f371ae3f44f`.
- El `artifacts/migration-check-logs/summary.txt` generado por la matriz fue retirado después de usarlo como evidencia; el HEAD limpio previo a documentación quedó en `a309b9c197ac835306b2ee8be5197c6a3b13a980`.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente los checks aplicables del plan.
- Prueba física interactiva Desktop/Web no ejecutada ni inventada; GitHub Actions validó los contratos modificados, typecheck, tests y ambos builds.
- E2E completos ajenos al flujo de Save All/conflictos no se usaron como criterio de cierre de esta extracción.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: importar una carpeta con varios beats, pulsar Save All antes de terminar toda la preparación y comprobar que Review se cierra inmediatamente; los válidos se guardan/suben sin reaparecer uno a uno y duplicados/conflictos reaparecen al final. Resolver después un conflicto de decisiones y comprobar que los archivos staged usados por el beat importado siguen disponibles.

Pendientes / fuera de alcance

- 7.4 — Separar la entrada de importación web queda pendiente y no fue iniciada.
- El puente temporal `setAudioConflictBatch` / `setDropImportBatch` hacia el callback Web debe retirarse cuando 7.4 mueva esa entrada a su owner.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto quedó abierto por 7.3.

Herramientas temporales restantes

- Ninguna. El applier y workflow temporal de implementación se eliminaron antes de validar/publicar; el closer documental y este script se eliminan dentro de su propio commit de cierre.

Fallos encontrados y causa

- Run 34293760589: 17/18 tests focalizados pasaron. La única assertion restante prohibía `saveBeatMeta({` en todo `App.tsx`, aunque existe una transacción Desktop de metadata/artwork ajena a Save All. Además el applier había retirado por error ese import compartido. No se publicó implementación; se preservó el flujo ajeno y se hizo que el test comprobara el owner real de Save All.
- Run 34296752458: las pruebas focalizadas pasaron; la matriz completa dejó solo `test:integration` rojo porque `libraryStateExtraction.test.ts` contaba escrituras de `beatsLatestRef` en App + `useImportReview` y todavía no seguía al nuevo owner `useImportSaveAll`. Se adaptó el guard sin bajar el umbral ni cambiar comportamiento de producto; no se publicó implementación.
- Run 34296950583: pruebas focalizadas y matriz completa PASS; publicó el árbol exacto validado como `de32aab99da86942aa71a83e992f9f371ae3f44f`.
- Run 34297402862: el primer closer documental tuvo YAML inválido por incluir un bloque multilínea sin indentación suficiente; no creó jobs ni tocó producto/documentación.

Veredicto

Terminada.

Save All y la resolución nativa de conflictos/decisiones quedaron fuera de `App.tsx` conservando cierre inmediato de Review, preparación secuencial compartida, reaparición final de conflictos y protección de staging.

Siguiente tarea

7.4 — Separar la entrada de importación web.

No iniciada.
```

### Registro — 7.4

```
Tarea: 7.4 — Separar la entrada de importación web
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 45ca0eae03d1685a1f938f4beaffb4259097882b
- SHA de implementación validada: 3c485083e4fe6e896017e2e26f4a33d9e25902b5
- Última tarea verificada: 7.3 — Separar Save All y conflictos

Cambio realizado

- Se creó `src/features/import/useBrowserImport.ts` como owner de la recepción de `File` del navegador, carga de metadata y entrada a Review.
- `App.tsx` dejó de poseer el cuerpo de la importación Web y conserva solo el wiring del hook con la sesión/Review y la cola cloud.
- Se conserva un beat por gesto: la entrada Web filtra los audios admitidos y utiliza `supported[0]` para preparar un único candidato.
- La preparación Web reutiliza `platform.importer`, `makeBrowserFileRef` y la lectura de metadata existente; el nuevo owner no incorpora invocaciones Tauri/nativas.
- Save conserva la ruta Web ya existente a través de la cola y `platform.cloudData.commitImportedBeat`; esta tarea no movió ni duplicó ese commit.
- Skip/Cancel continúan liberando las fuentes/candidatos Web que dejan de estar en uso.
- `useImportSaveAll.ts` expone `clearImportResolution`; se retiró el puente temporal de `setAudioConflictBatch` / `setDropImportBatch` que 7.3 había dejado para la entrada Web.
- No se inició 8.1.

Adaptación de pruebas

- Se añadió `tests/component-dom/browserImport.test.tsx`, que ejecuta un gesto con varios archivos, exige un único candidato, verifica metadata y comprueba liberación de fuentes al Skip/Cancel.
- Se añadió `tests/integration/appBrowserImportExtraction.test.ts` para proteger ownership, wiring y ausencia de invocaciones Tauri/nativas en `useBrowserImport.ts`.
- `tests/integration/appImportDiscoveryExtraction.test.ts` dejó de exigir que `importDroppedBrowserFiles` permaneciera físicamente en `App.tsx`; conserva el contrato de discovery que le corresponde.
- Las demás guardas de Review, Save All y routing Web permanecen activas.

Archivos afectados

- src/App.tsx
- src/features/import/useBrowserImport.ts
- src/features/import/useImportSaveAll.ts
- tests/component-dom/browserImport.test.tsx
- tests/integration/appBrowserImportExtraction.test.ts
- tests/integration/appImportDiscoveryExtraction.test.ts
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary task 7.4 retry`, run 34298836051.
- `Apply extraction and focused checks` — PASS.
- `Run migration matrix` — PASS.
- `Commit exact validated implementation` — PASS.
- `Fast-forward target branch` — PASS.
- `git diff --check` — PASS.
- Pruebas focalizadas de 7.4 — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- La implementación exacta publicada y validada es `3c485083e4fe6e896017e2e26f4a33d9e25902b5`.
- El workflow general figura `FAILURE` solo porque `Finalize documentation` falló después de publicar el commit validado; la matriz no falló.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente los checks aplicables.
- Prueba física Web interactiva no ejecutada ni inventada.
- E2E completos ajenos al flujo de entrada Web no se usaron como criterio de cierre.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: en Web, arrastrar/seleccionar más de un audio en un mismo gesto y comprobar que Review recibe un único candidato con metadata; omitir/cancelar y repetir; guardar otro beat y comprobar que sigue la ruta cloud Web.
- Resultado esperado: un beat por gesto, fuentes liberadas al omitir/cancelar y Save inicia el mismo commit/upload Web de antes sin invocaciones nativas.

Pendientes / fuera de alcance

- 8.1 — Separar detección del destino queda pendiente y no fue iniciada.
- La recepción HTML general y el arbitraje de destinos corresponden a 8.1/8.2 y no se movieron en 7.4.

Riesgos previos relevantes

- Ningún riesgo nuevo de producto quedó abierto por 7.4.

Herramientas temporales restantes

- Ninguna creada por 7.4 permanece en el árbol final; el closer temporal y este script se eliminan dentro del commit documental.

Fallos encontrados y causa

- Run 34298545804: la primera matriz se detuvo porque `appImportDiscoveryExtraction.test.ts` todavía exigía que `importDroppedBrowserFiles` permaneciera en App “hasta 7.4”. Era una guarda previa acoplada al ownership que esta tarea debía mover. No se publicó implementación.
- Run 34298836051: la matriz, el commit exacto y el fast-forward terminaron PASS y publicaron `3c485083e4fe6e896017e2e26f4a33d9e25902b5`; el único fallo posterior fue `Finalize documentation`, por lo que este cierre recupera únicamente roadmap/registro/agent-state sin repetir código.
- Se descartó un SHA transitorio `43df569895f21e47e945f71a3fe4b19b089cfdf6` mencionado durante el tooling: no existe en GitHub. El SHA remoto real publicado es `3c485083e4fe6e896017e2e26f4a33d9e25902b5`.

Veredicto

Terminada.

La entrada de importación Web quedó fuera de `App.tsx`, con un beat por gesto, metadata y Review preservados, liberación al omitir/cancelar y cero invocaciones nativas desde el owner Web.

Siguiente tarea

8.1 — Separar detección del destino.

No iniciada.
```

### Registro — 8.1

```
Tarea: 8.1 — Separar detección del destino
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: aba85aadb3dce83f326587f72425614c8f962a53
- SHA de implementación validada: 00b56e94fbc790483e150de27202488eef166bb4
- Última tarea verificada: 7.4 — Separar la entrada de importación web

Cambio realizado

- Se creó `src/features/dragdrop/nativeDropTargets.ts` como owner de la clasificación de rutas de imagen y de la localización/clasificación del destino del drop nativo.
- `App.tsx` dejó de poseer directamente `document.elementFromPoint`, el fallback de `devicePixelRatio`, la clasificación por extensión de imagen y los selectores `data-*` usados para decidir el destino.
- Se conserva la prioridad del drop de filesystem: Drawer primero; después artwork si existe exactamente una ruta de imagen; después tarjeta; finalmente galería/biblioteca.
- Se conservan las coordenadas recibidas de Tauri y el fallback de escala de pantalla para localizar el mismo elemento cuando las coordenadas requieren conversión.
- Se conserva el routing de imágenes externas de navegador/Pinterest: artwork del Drawer antes que artwork de tarjeta; no se convierte ese gesto en importación de beat.
- `App.tsx` conserva listeners, arbitraje y ejecución de acciones; 8.1 solo separa detección/clasificación del destino.
- No se inició 8.2.

Adaptación de pruebas

- Se añadió `tests/integration/appNativeDropTargetsExtraction.test.ts` para proteger ownership, coordenadas/escala, selectores, clasificación de imágenes, prioridad de destinos y routing de imagen externa.
- `scripts/regression-import-native.mjs` se adaptó para seguir verificando el routing nativo en el nuevo owner.
- `scripts/test-macos-portability.mjs` se adaptó para verificar el contrato Mac de drag & drop en `nativeDropTargets.ts` en vez de exigir esa responsabilidad físicamente dentro de `App.tsx`.
- No se desactivaron ni relajaron contratos para conseguir un resultado verde.

Archivos afectados

- src/App.tsx
- src/features/dragdrop/nativeDropTargets.ts
- tests/integration/appNativeDropTargetsExtraction.test.ts
- scripts/regression-import-native.mjs
- scripts/test-macos-portability.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Temporary task 8.1 product validation`, run 34305812263 — SUCCESS.
- Artifact `migration-check-logs-task-8-1-34305812263` leído; implementation SHA `00b56e94fbc790483e150de27202488eef166bb4`.
- Prueba focalizada `appNativeDropTargetsExtraction.test.ts` — PASS.
- `node scripts/regression-import-native.mjs` — PASS.
- Contrato Mac específico de drag & drop extraído — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS directo en la corrida final.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- Comparación neta `aba85aadb3dce83f326587f72425614c8f962a53...00b56e94fbc790483e150de27202488eef166bb4`: solo cinco archivos de producto/pruebas de 8.1; el tooling temporal no permanece en el árbol de implementación.

Comprobaciones con fallo previo separado

- `npm run test:mac-portability:static` conserva un fallo previo ajeno a 8.1: `helper refuses sessions without explicit local Bot API base`.
- Ese mismo fallo fue reproducido directamente sobre el SHA inicial `aba85aadb3dce83f326587f72425614c8f962a53`, después de que el contrato Mac anterior de routing Finder/artwork pasara. Por tanto no fue introducido por 8.1.
- La corrida final exige además que el nuevo contrato Mac de drag & drop pase antes de aceptar únicamente ese fallo baseline.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente los checks aplicables.
- Prueba física Desktop Windows/macOS no ejecutada ni inventada; la ronda trabaja mediante GitHub Actions.
- E2E completos ajenos a drag & drop no se usaron como criterio de cierre.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: en Desktop, arrastrar los mismos archivos sobre Drawer, artwork de tarjeta, cuerpo de tarjeta y galería; repetir con una imagen única y con múltiples rutas, incluyendo pantalla con escala distinta de 100%.
- Resultado esperado: misma prioridad y mismas acciones que antes de la extracción, sin duplicar el gesto y sin interpretar una imagen externa del navegador como beat.

Pendientes / fuera de alcance

- 8.2 — Separar recepción HTML y navegador queda pendiente y no fue iniciada.
- La recepción/listener HTML y el listener nativo completo siguen en `App.tsx`; corresponden a 8.2 y 8.3 respectivamente.

Riesgos previos relevantes

- El wrapper general de portabilidad Mac conserva el fallo previo del Direct helper descrito arriba; no bloquea 8.1 porque fue reproducido en el SHA inicial y el contrato Mac afectado por 8.1 pasa.
- Durante una corrida intermedia se observó una carrera de teardown de `TagColorMenu` después de que 64/64 archivos y 258/258 tests component DOM pasaran; `TagColorMenu.tsx` y su prueba eran blobs idénticos al SHA inicial. La corrida final `34305812263` ejecutó `test:component:dom` directamente en verde.

Herramientas temporales restantes

- Ninguna herramienta temporal de 8.1 debe permanecer en el árbol final; el workflow y script documentales se eliminan dentro del propio commit de cierre.

Fallos encontrados y causa

- Corridas intermedias de tooling abortaron antes de publicar producto por definición temporal inválida, coincidencias textuales/indentación del aplicador y una assertion nueva mal escapada; se corrigió el tooling/prueba, no el comportamiento de producto.
- Run 34303874900 llegó a los checks de producto y dejó focalizada/regresión nativa en verde; el wrapper Mac se detuvo en el fallo del Direct helper.
- Run 34305339011 reprodujo ese fallo Mac también en el SHA inicial, separándolo de 8.1. Después component DOM mostró la carrera de teardown indicada arriba, con 64/64 archivos y 258/258 tests pasados; no se publicó producto.
- Un intento posterior de ejecutar la suite baseline desde un worktree con `node_modules` enlazado falló artificialmente por el allow-list de Vite para `mtcute.wasm`; se descartó esa evidencia y no se publicó producto.
- Run 34305812263 quedó verde en toda la matriz aplicable, component DOM pasó directamente y publicó `00b56e94fbc790483e150de27202488eef166bb4`.
- El primer closer documental fue rechazado por GitHub antes de crear jobs debido a una definición YAML inválida; no modificó documentos.

Veredicto

Terminada.

La detección/clasificación del destino nativo quedó fuera de `App.tsx` conservando prioridad, `data-*`, coordenadas, escala y routing de imágenes; App sigue ejecutando las acciones y conserva los listeners para las tareas siguientes.

Siguiente tarea

8.2 — Separar recepción HTML y navegador.

No iniciada.
```

### Registro — 8.2

```
Tarea: 8.2 — Separar recepción HTML y navegador
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 344571f32efa83610e2ad17bb48566b74ece3ede
- SHA de implementación validada: 1a1ab540a246bc7cd7b1b2a71191287292f02eb4
- Última tarea verificada: 8.1 — Separar detección del destino

Cambio realizado

- Se creó `src/features/dragdrop/useHtmlLibraryDrop.ts` como owner de la recepción HTML/navegador y de la instalación de `htmlDropController`.
- `App.tsx` dejó de poseer `handleBrowserBeatFileDrop` y el `useEffect` que instalaba el controller; conserva únicamente el wiring hacia el nuevo hook.
- Windows Desktop conserva un único owner nativo: el hook no instala el fallback HTML cuando Tauri está disponible y el user agent es Windows.
- macOS conserva el arbitraje nativo-vs-HTML ya existente en `htmlDropController`, de modo que Finder puede reclamar el gesto antes del staging HTML mientras browser/Pinterest sigue disponible para artwork.
- El artwork del navegador conserva fallback multi-source: URL/data URL y `File` virtual se prueban hasta obtener una imagen válida; una imagen remota no entra en la ruta de importación de beats.
- La entrada Web conserva el gate `platform.capabilities.browserFileImport`, un archivo MP3/WAV/PROJECT ZIP por beat y la entrada de biblioteca mediante `importDroppedBrowserFiles`.
- El fallback HTML Desktop conserva staging, exclusión Backup/Backups, auto-routing de proyectos y feedback de carga antes de copiar/inspeccionar.
- No se inició 8.3; el listener/receptor nativo completo permanece en `App.tsx`.

Adaptación de pruebas

- Se añadió `tests/integration/appHtmlLibraryDropExtraction.test.ts` para proteger ownership, Windows single-owner, arbitraje Mac/browser, fallback de artwork, rutas Web y staging Desktop.
- `tests/integration/appBrowserImportExtraction.test.ts` y `tests/integration/issue97RuntimeWebFollowup.test.ts` dejaron de exigir callbacks HTML físicamente dentro de `App.tsx` y ahora siguen el contrato hasta `useHtmlLibraryDrop.ts`.
- `scripts/regression-import-native.mjs` y `scripts/run-regressions.mjs` siguen los invariantes de Windows, staging y auto-routing desde el nuevo owner sin relajar los contratos.

Archivos afectados

- src/App.tsx
- src/features/dragdrop/useHtmlLibraryDrop.ts
- tests/integration/appHtmlLibraryDropExtraction.test.ts
- tests/integration/appBrowserImportExtraction.test.ts
- tests/integration/issue97RuntimeWebFollowup.test.ts
- scripts/regression-import-native.mjs
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Final task 8.2 validation`, run 34307783102 — SUCCESS.
- Artifact `migration-check-logs-task-8-2-34307783102` leído; implementation SHA `1a1ab540a246bc7cd7b1b2a71191287292f02eb4`.
- `npx vitest run tests/integration/appHtmlLibraryDropExtraction.test.ts --environment jsdom` — PASS.
- `node scripts/regression-import-native.mjs` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- Contrato Mac afectado por drag & drop — PASS. El wrapper general `test:mac-portability:static` conserva el fallo previo del Direct helper `helper refuses sessions without explicit local Bot API base`, ya documentado desde 8.1 y separado de esta tarea.
- Comparación neta `344571f32efa83610e2ad17bb48566b74ece3ede...1a1ab540a246bc7cd7b1b2a71191287292f02eb4`: siete archivos de producto/pruebas/regresiones de 8.2; el tooling temporal no permanece en el árbol de implementación.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente los checks aplicables.
- Prueba física Desktop Windows/macOS y Web interactiva no ejecutada ni inventada; la ronda trabaja mediante GitHub Actions.
- E2E completos ajenos a drag & drop no se usaron como criterio de cierre.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: en Windows arrastrar una carpeta/archivo local y comprobar una sola recepción nativa; en macOS repetir desde Finder y después arrastrar artwork desde navegador/Pinterest; en Web arrastrar MP3/WAV/ZIP sobre un beat y un audio a biblioteca.
- Resultado esperado: un gesto produce una sola acción; artwork remoto solo actualiza artwork; archivos Web siguen su ruta Web; Finder/Explorer no duplica staging ni importación.

Pendientes / fuera de alcance

- 8.3 — Separar recepción nativa queda pendiente y no fue iniciada.
- El listener nativo completo, su ciclo de vida y ejecución de acciones nativas permanecen en `App.tsx` para 8.3.

Riesgos previos relevantes

- El wrapper general de portabilidad Mac conserva el fallo previo del Direct helper descrito arriba; no fue introducido por 8.2 y el contrato Mac de drag & drop afectado pasa.
- En una corrida intermedia `test:component:dom` pasó 64/64 archivos y 258/258 tests pero Vitest reportó después un teardown asíncrono de `TagColorMenu.tsx` (`window is not defined`). La corrida siguiente pasó component DOM; no se cambió `TagColorMenu` para esta tarea.

Herramientas temporales restantes

- Ninguna. Los workflows y scripts temporales de implementación fueron eliminados antes de publicar `1a1ab540a246bc7cd7b1b2a71191287292f02eb4`; el closer documental y este script se eliminan dentro de su propio commit de cierre.

Fallos encontrados y causa

- Run 34306849185 y un trigger intermedio equivalente fallaron antes de crear jobs por definición YAML temporal inválida; no publicaron implementación.
- Run 34307027328 llegó a integración: el código focalizado/typecheck/unit/component DOM pasaban, pero dos pruebas antiguas exigían callbacks HTML físicamente en `App.tsx`. Se adaptaron al nuevo owner sin relajar comportamiento; no se publicó implementación.
- Run 34307184168 pasó integración y falló `test:regressions` por guards antiguos que buscaban auto-routing/staging en `App.tsx`; se movieron al nuevo owner; no se publicó implementación.
- Run 34307318445 encontró el teardown asíncrono de `TagColorMenu` después de 258/258 tests component DOM pasados; se clasificó como intermitencia ajena a 8.2.
- Run 34307484419 confirmó component DOM en verde y detectó otra guarda estática de ownership en `test:regressions`; se adaptó sin cambiar el contrato.
- Run 34307783102 quedó verde en toda la matriz aplicable y publicó `1a1ab540a246bc7cd7b1b2a71191287292f02eb4`.

Veredicto

Terminada.

La recepción HTML/navegador quedó fuera de `App.tsx` conservando single-owner por gesto, gates de plataforma, artwork multi-source y staging/routing existentes.

Siguiente tarea

8.3 — Separar recepción nativa.

No iniciada.
```

### Registro — 8.3

```
Tarea: 8.3 — Separar recepción nativa
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: f577cb324bcfce702957ea1d718b60f4c19a807b
- SHA de implementación validada: b8b8c6376837687881510ddeeac11062db2fcd46
- Última tarea verificada: 8.2 — Separar recepción HTML y navegador

Cambio realizado

- Se creó `src/features/dragdrop/useNativeLibraryDrop.ts` como owner del listener nativo de Tauri, feedback de drag, arbitraje y ejecución/routing del drop nativo.
- `App.tsx` dejó de poseer `getCurrentWebview().onDragDropEvent` y `handleNativeDrop`; conserva un único punto de composición mediante `useNativeLibraryDrop({...})`.
- Se conservaron las rutas originales de Explorer/Finder, el límite de 50 rutas, el uso directo de `payload.paths` y la importación zero-copy sin `DataTransfer.arrayBuffer`, `drop-staging` ni copia previa a Review.
- Se conservaron `nativeDropArbiter`, sentinelas de imagen externa/browser, detección extraída de destinos y la prioridad del gesto nativo antes de la importación local.
- La limpieza conserva desuscripción aun si el registro asíncrono del listener termina después del unmount, además de retirar el listener de imagen externa y limpiar el feedback visual.
- No se inició 9.1.

Adaptación de pruebas

- Se añadió `tests/integration/appNativeLibraryDropExtraction.test.ts` para ownership, receptor único, límite/rutas originales, zero-copy, arbitraje/sentinelas y cleanup asíncrono.
- `tests/integration/appNativeDropTargetsExtraction.test.ts` ahora sigue las llamadas a los resolvers hasta `useNativeLibraryDrop.ts` en vez de exigirlas físicamente en `App.tsx`.
- `scripts/regression-import-native.mjs`, `scripts/run-regressions.mjs`, `scripts/regression-phase9cd.mjs` y `scripts/test-macos-portability.mjs` fueron adaptados para seguir el ownership extraído sin relajar sus invariantes.

Archivos de implementación/pruebas afectados

- scripts/regression-import-native.mjs
- scripts/regression-phase9cd.mjs
- scripts/run-regressions.mjs
- scripts/test-macos-portability.mjs
- src/App.tsx
- src/features/dragdrop/useNativeLibraryDrop.ts
- tests/integration/appNativeDropTargetsExtraction.test.ts
- tests/integration/appNativeLibraryDropExtraction.test.ts

Comprobaciones ejecutadas

- GitHub Actions `Final task 8.3 validation`, run 34309637023 — SUCCESS.
- Artifact `migration-check-logs-task-8-3-34309637023` generado.
- Prueba focalizada `appNativeLibraryDropExtraction.test.ts` — PASS.
- `node scripts/regression-import-native.mjs` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- Contrato Mac afectado por drag & drop — PASS; el wrapper conserva únicamente la excepción baseline ya documentada del Direct helper.
- La publicación del commit exacto validado terminó correctamente.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente los checks aplicables.
- Prueba física Desktop Windows/macOS no ejecutada ni inventada; la ronda trabaja mediante GitHub Actions.
- E2E completos ajenos a drag & drop no se usaron como criterio de cierre.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: arrastrar desde Explorer/Finder archivos y carpetas sobre biblioteca, tarjeta, artwork y Drawer; desmontar/cambiar de vista durante el registro del listener y repetir con imagen externa de navegador.
- Resultado esperado: un solo receptor efectivo por gesto, mismas rutas/destinos, sin copia previa innecesaria, sentinelas correctos y ningún listener residual.

Pendientes / fuera de alcance

- 9.1 — Separar sesión y ajustes queda pendiente y no fue iniciada.
- La prueba física multiplataforma queda como comprobación manual opcional, no como bloqueo del cierre automatizado.

Fallos encontrados y causa

- Una assertion nueva confundió `.arrayBuffer(` dentro de un comentario con código ejecutable; se corrigió el test para inspeccionar código sin comentarios.
- Un aplicador temporal calculó offsets de `App.tsx` antes de retirar imports; se corrigió el tooling para recalcularlos antes del reemplazo.
- Typecheck confirmó que `App.tsx` aún usa `isBackupFolderPath` independientemente del receptor nativo; se conservó ese import.
- Guards antiguos de 8.1/Phase 9/no-staging seguían el ownership físico dentro de `App.tsx`; se trasladaron al nuevo owner manteniendo los mismos contratos.
- Run 34309637023 quedó verde y publicó `b8b8c6376837687881510ddeeac11062db2fcd46`.

Veredicto

Terminada.

La recepción nativa quedó fuera de `App.tsx` conservando listener único, destinos, arbitraje, rutas originales, zero-copy, feedback y cleanup.

Siguiente tarea

9.1 — Separar sesión y ajustes.

No iniciada.
```

### Registro — 9.1

```
Tarea: 9.1 — Separar sesión y ajustes
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 8541ba633d7f0ab0b271b82014410b5998bd0c52
- SHA de implementación validada: f381d77a50280a4a1c19bbfbd7c717019ba9fd3b
- Última tarea verificada: 8.3 — Separar recepción nativa

Cambio realizado

- Se creó `src/features/session/useSessionState.ts` como owner único del estado de ajustes, setup, conectividad y verificación cloud consumido por los flujos restantes.
- `connectionState` y `cloudSessionVerified` continúan siendo datos independientes; no se colapsaron en una sola señal.
- Se creó `src/features/session/useSessionActions.ts` para los cambios locales de preferencias y la acción de Sign out/desconexión.
- La desconexión conserva la limpieza previa: logout tolerante a fallo, release de audio, invalidación del revelado progresivo, limpieza de preparación de playback/artwork, beats revelados, verificación cloud, galería y selección; además actualiza los campos de cuenta conectada en settings.
- Se creó `src/features/session/useCustomCursor.ts` y se trasladó allí el efecto del cursor manteniendo el whitelist explícito de controles de edición de texto.
- `App.tsx` compone los nuevos owners y ya no posee esos estados/callbacks/efecto localmente.
- Startup, Reload, reconexión online/offline y SSE permanecen deliberadamente en `App.tsx`; corresponden a 9.2, 9.3 y 9.4 y no se adelantaron.

Adaptación de pruebas

- Se añadió `tests/component-dom/sessionState.test.tsx` para proteger independencia entre conectividad/verificación, cambios de preferencias, efecto del cursor y cleanup completo de Sign out.
- Se añadió `tests/integration/appSessionExtraction.test.ts` para proteger ownership y evitar adelantar startup/reconnect/SSE.
- `scripts/run-regressions.mjs` sigue verificando el mismo whitelist del cursor desde su nuevo owner `useCustomCursor.ts`; se cambió la ubicación inspeccionada, no el contrato.

Archivos de implementación/pruebas afectados

- scripts/run-regressions.mjs
- src/App.tsx
- src/features/session/useCustomCursor.ts
- src/features/session/useSessionActions.ts
- src/features/session/useSessionState.ts
- tests/component-dom/sessionState.test.tsx
- tests/integration/appSessionExtraction.test.ts

Comprobaciones ejecutadas

- GitHub Actions `Final Task 9.1 Validation 2`, run 34311448820 — SUCCESS.
- Artifact `migration-check-logs-task-9-1-34311448820` leído — `Migration checks: PASS`.
- Pruebas focalizadas `sessionState.test.tsx` + `appSessionExtraction.test.ts` — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- El workflow publicó el commit exacto validado `f381d77a50280a4a1c19bbfbd7c717019ba9fd3b`.
- Comparación neta `8541ba633d7f0ab0b271b82014410b5998bd0c52...f381d77a50280a4a1c19bbfbd7c717019ba9fd3b`: exactamente siete archivos de implementación/pruebas/regresión; el tooling temporal no permanece en el árbol validado.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente typecheck, unit TS, component DOM, integración, regresiones y ambos builds.
- Prueba física Desktop/Web interactiva no ejecutada ni inventada; no quedó como bloqueo porque los contratos modificados están cubiertos por pruebas DOM/integración/regresión y ambos builds.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: abrir Settings, alternar incomplete warnings y custom cursor, cambiar carpeta cuando aplique y ejecutar Sign out con audio/selección activos.
- Resultado esperado: Settings conserva la misma conducta visual/persistente; el cursor cambia igual que antes; Sign out limpia audio, galería, selección y verificación cloud sin mezclar conectividad de internet con verificación de sesión.

Pendientes / fuera de alcance

- 9.2 — Separar Reload queda pendiente y no fue iniciada.
- Startup inicial permanece para 9.3; listeners online/offline y SSE permanecen para 9.4.

Riesgos previos relevantes

- El fallo baseline del wrapper estático Mac relacionado con el Direct helper, documentado desde 8.1–8.3, no pertenece a 9.1 ni fue modificado por esta extracción.

Herramientas temporales restantes

- Ninguna debe permanecer en el árbol final. Los workflows/scripts temporales de 9.1 fueron retirados al publicar la implementación y el closer documental elimina su script y workflow dentro del propio commit.

Fallos encontrados y causa

- Run 34310977580: pruebas focalizadas y matriz pasaron, pero una condición temporal del workflow interpretó incorrectamente el resultado y bloqueó la publicación; fallo de tooling, sin commit de producto.
- Run 34311184722: la matriz detectó dos problemas reales de extracción: faltaba importar el tipo `ConnectionState` en `App.tsx` y el guard del cursor seguía buscando el whitelist físicamente en `App.tsx`. Se importó el tipo y se siguió el contrato hasta `useCustomCursor.ts` sin rebajar la assertion.
- Run 34311360174: el script temporal de corrección usó una coincidencia textual demasiado literal y abortó antes de tests; fallo de tooling, sin publicación de producto.
- Run 34311448820: focalizadas, diff check y toda la matriz quedaron verdes y se publicó `f381d77a50280a4a1c19bbfbd7c717019ba9fd3b`.
- Runs 34311757123 y 34311893799: dos closers documentales YAML fueron rechazados antes de crear jobs; no modificaron documentación ni producto y sus archivos fueron eliminados antes de este closer.
- Run 34311993177: el closer ejecutó la escritura documental en el working tree, pero `git diff --check` detectó una línea en blanco extra al EOF del Registro; no publicó cambios.

Veredicto

Terminada.

La sesión/ajustes quedó con un owner explícito; Settings, cursor y Sign out conservan comportamiento, y conectividad sigue separada de verificación cloud.

Siguiente tarea

9.2 — Separar Reload.

No iniciada.
```

### Registro — 9.2

```
Tarea: 9.2 — Separar Reload
Estado: Terminada
Fecha: 2026-09-08

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 9292213dcdfa45e7424108e3aa861e1ab7eeef53
- SHA de implementación validada: ef31e40653c82cbde9cf59b1d541dfd33e7829e8
- Última tarea verificada: 9.1 — Separar sesión y ajustes

Cambio realizado

- Se creó `src/features/library/useLibraryReload.ts` como owner de la recarga manual, sus reintentos y la recepción de `beatgaler:deferred-library-reload`.
- `App.tsx` dejó de poseer `libraryRefreshing`, el callback completo de Reload y el listener de recarga diferida; conserva el wiring hacia `useLibraryReload` y el gesto manual que limpia `clearUploadPreviewCache()` antes de recargar.
- Reload conserva el feedback visual mínimo de 320 ms.
- Reload consulta primero `deferLibraryReloadIfUploading()`; la cola cloud conserva la actividad/pending marker y emite la recarga diferida únicamente después de drenar uploads.
- La ruta cloud conserva hasta cuatro intentos de autoridad con backoff `450 * attempt`, reparación tolerante de referencias stale y restauración autoritativa.
- Si la autoridad falla tras los reintentos, la conexión pasa a `poor`, la sesión cloud queda no verificada y la galería visible se conserva; autoridad desconocida no se interpreta como biblioteca vacía.
- La ruta offline conserva la biblioteca visible cuando el navegador está offline y ya existe contenido cargado; sin conexión cloud configurada sigue cargando la biblioteca offline.
- No se inició 9.3; startup inicial permanece fuera del alcance de esta ronda.

Adaptación de pruebas

- Se añadió `tests/component-dom/libraryReload.test.tsx` para cubrir Reload autoritativo y feedback, defer durante upload + evento tras drain, y cuatro fallos de autoridad preservando la galería.
- Se añadió `tests/integration/appLibraryReloadExtraction.test.ts` para proteger el nuevo ownership y los contratos de defer/retry/feedback/galería.
- `tests/integration/appMigrationCharacterization.test.ts` y `tests/integration/appCloudUploadQueueExtraction.test.ts` siguen ahora el contrato hasta `useLibraryReload.ts` sin relajar la coordinación de la cola.
- `tests/component-dom/startupRevealArchitecture.test.ts` dejó de exigir físicamente en `App.tsx` el reveal que Reload sigue ejecutando desde su nuevo owner.

Archivos de implementación/pruebas afectados

- src/App.tsx
- src/features/library/useLibraryReload.ts
- tests/component-dom/libraryReload.test.tsx
- tests/component-dom/startupRevealArchitecture.test.ts
- tests/integration/appCloudUploadQueueExtraction.test.ts
- tests/integration/appLibraryReloadExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts

Comprobaciones ejecutadas

- GitHub Actions `Task 9.2 Apply`, run 34314514114 — SUCCESS.
- Artifact `migration-check-logs-task-9-2-34314514114` — `Migration checks: PASS`.
- Focalizadas de 9.2: 5 archivos / 28 tests — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- El workflow publicó el estado exacto validado como `ef31e40653c82cbde9cf59b1d541dfd33e7829e8` y eliminó su tooling temporal del árbol de implementación.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; la matriz ejecutó individualmente los checks aplicables.
- Prueba física Desktop/Web interactiva no ejecutada ni inventada; no quedó como bloqueo porque uploads activos/sin uploads, fallo de autoridad, feedback visual y ownership están cubiertos por pruebas focalizadas/component DOM/integración y ambos builds.

Prueba manual

- No ejecutada ni inventada.
- No es necesaria para cerrar 9.2 según la evidencia automatizada disponible.
- Sugerida: iniciar un upload y pulsar Reload; comprobar que el botón conserva feedback, la recarga queda pendiente y se ejecuta al drenar la cola. Repetir sin upload y simular fallo temporal cloud.
- Resultado esperado: con upload activo se difiere; sin upload se recarga inmediatamente; con fallo de autoridad la galería visible no desaparece.

Pendientes / fuera de alcance

- 9.3 — Separar el arranque inicial queda pendiente y no fue iniciada.
- Reconexión online/offline y SSE continúan para 9.4; aparición progresiva general continúa para 9.5.

Riesgos previos relevantes

- El fallo baseline histórico del wrapper estático Mac relacionado con el Direct helper pertenece a tareas anteriores y no fue modificado por 9.2.
- Las focalizadas finales emitieron warnings de React `act(...)` sin fallos de assertions; las 28 pruebas focalizadas y la suite component DOM completa terminaron en PASS.

Herramientas temporales restantes

- Ninguna permanece tras este cierre. El tooling temporal de implementación fue retirado al publicar `ef31e40653c82cbde9cf59b1d541dfd33e7829e8` y el closer elimina su script/workflow en el mismo commit documental.

Fallos encontrados y causa

- Run 34313664276 no creó jobs por YAML temporal inválido; no ejecutó ni publicó producto.
- Run 34313709263 abortó porque el aplicador temporal asumía incorrectamente que `repairStaleCloudLibraryRefs` debía desaparecer por completo de `App.tsx`; se conservó su uso legítimo ajeno a Reload.
- Run 34313796208 detectó tres timeouts en la prueba nueva por fake timers mal coordinados y una prueba existente acoplada a que reveal vivía físicamente en `App.tsx`; se corrigieron las pruebas para seguir comportamiento/ownership sin modificar la semántica de Reload.
- Run 34314180802 no creó jobs por otro detalle YAML temporal; no modificó producto.
- Run 34314223337 dejó focalizadas, diff check y `Migration checks: PASS`, pero el guard de publicación omitía archivos nuevos untracked y bloqueó el commit validado.
- Run 34314514114 corrigió exclusivamente ese guard; focalizadas, diff check, toda la matriz y publicación terminaron en SUCCESS, produciendo `ef31e40653c82cbde9cf59b1d541dfd33e7829e8`.
- Run 34314789957 fue rechazado antes de crear jobs por la definición YAML del primer closer documental; no modificó documentación ni producto.

Veredicto

Terminada.

Reload quedó con un owner explícito fuera de `App.tsx`, conservando defer por uploads, reintentos, feedback visual y la regla de no vaciar la galería ante autoridad desconocida.

Siguiente tarea

9.3 — Separar el arranque inicial.

No iniciada.
```

### Registro — 9.3

```
Tarea: 9.3 — Separar el arranque inicial
Estado: Terminada
Fecha: 2026-09-09

Base

- Rama: v0.9.0-test-noche
- SHA inicial de esta ejecución: 18ad9a91f3a6207c652587509d27f4e3ee4907ca
- SHA de implementación validada: 9e8b1fe7e560f64707c4595ce5ed81d14519dcd0
- Última tarea verificada: 9.2 — Separar Reload

Cambio realizado

- Se creó `src/features/startup/useStartupBootstrap.ts` como owner del bootstrap inicial: lectura de settings, verificación de conectividad Cloud, validación Offline, recuperación de uploads interrumpidos, flush de Trash offline, carga/reparación de autoridad y publicación inicial de biblioteca.
- `App.tsx` dejó de poseer el efecto de arranque y el estado/timer de avisos de recuperación; ahora compone `useStartupBootstrap` y conserva solamente el render del aviso mediante el controller devuelto.
- Se preservó el orden observable: settings → reachability/linkage → recuperación segura → Trash offline → autoridad con retry → reparación stale → publicación/verificación.
- Caché de presentación, biblioteca vacía confirmada y autoridad desconocida siguen siendo estados distintos: el caché se mantiene ante fallo temporal de autoridad, pero un INDEX vacío confirmado sí publica `[]`.
- El arranque offline valida primero `loadOfflineLibrary()` y revela únicamente paquetes durables.
- `src/main.tsx` no fue modificado; `installStartupTrace`, CSRF coordinator, Direct preconnect y la composición raíz permanecen en su sitio.
- Reconexión/SSE permanecen en App para 9.4 y revelado progresivo general permanece para 9.5.

Adaptación de pruebas

- Se añadió `tests/component-dom/startupBootstrap.test.tsx` con casos ejecutables para arranque online sin caché, cold start offline, autoridad vacía confirmada y fallo temporal de autoridad preservando caché.
- Se añadió `tests/integration/appStartupBootstrapExtraction.test.ts` para ownership, orden y preservación de inicializadores de `main.tsx`.
- `tests/integration/appMigrationCharacterization.test.ts` sigue la recuperación de uploads en el nuevo owner sin debilitar su contrato fail-closed.

Archivos afectados

- src/App.tsx
- src/features/startup/useStartupBootstrap.ts
- tests/component-dom/startupBootstrap.test.tsx
- tests/integration/appStartupBootstrapExtraction.test.ts
- tests/integration/appMigrationCharacterization.test.ts
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- GitHub Actions `Task 9.3 Apply`, run 34322763669 — matriz focalizada, prepublicación y validación exacta del commit publicado.
- Artifact `migration-check-logs-task-9-3-34322763669` generado por la corrida.
- Focalizadas de startup/extracción/caracterización — PASS.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.
- Los checks exactos validaron `9e8b1fe7e560f64707c4595ce5ed81d14519dcd0` después de publicarlo en la rama.

Comprobaciones no ejecutadas

- `npm run check` no se ejecutó como wrapper; sus checks frontend aplicables se ejecutaron individualmente y ambos builds pasaron.
- Prueba física Desktop/Web interactiva no ejecutada ni inventada; no queda como bloqueo porque los cuatro estados de aceptación de 9.3 están cubiertos por pruebas ejecutables más la matriz completa.

Prueba manual

- No ejecutada ni inventada.
- Sugerida: abrir con caché válida, sin caché, sin red y con Cloud temporalmente inaccesible.
- Resultado esperado: caché visible pero read-only hasta autoridad; INDEX vacío confirmado muestra galería vacía; offline muestra solo paquetes durables; fallo temporal no produce flash 60→0→60.

Pendientes / fuera de alcance

- 9.4 — Separar reconexión y eventos cloud.
- 9.5 — Separar la aparición de tarjetas.

Riesgos previos relevantes

- Ninguno nuevo de integridad identificado por 9.3.

Herramientas temporales restantes

- Ninguna. El workflow/applier temporal se elimina antes de publicar el SHA de implementación validada.

Fallos encontrados y causa

- Run 34321548287 fue rechazado antes de crear jobs por YAML temporal inválido (un heredoc sin indentación válida dentro de `run:`); no ejecutó ni publicó producto y no pudo generar artifact. Se corrigió únicamente el tooling temporal.
- Run 34321631406 llegó a la matriz previa y el artifact mostró dos pruebas existentes acopladas físicamente a `App.tsx`: `appHelperExtraction.test.ts` exigía el import directo del journal y `issue97WebRoutingContract.test.ts` buscaba el catch de startup dentro de App. Focalizadas, diff-check, typecheck, unit TS y component DOM habían pasado; integration falló antes de publicar producto. Se adaptaron esas guardas para seguir al nuevo owner sin cambiar semántica de producción.
- Run 34321874031 dejó focalizadas, diff-check, typecheck, unit TS, component DOM e integración en PASS; `test:regressions` falló porque `scripts/run-regressions.mjs` todavía buscaba `loadOfflineLibrary()` y el orden reachability→connected en App. No publicó producto.
- Run 34322128673 confirmó esas correcciones pero destapó una segunda assertion estática del mismo guard que todavía buscaba el reveal Offline atómico en App. El artifact mostró todo verde hasta `test:regressions`; se redirigió también esa assertion al bootstrap y no se publicó producto.
- Run 34322417502 dejó focalizadas, diff-check, typecheck, unit TS, component DOM, integración, regresiones y ambos builds en PASS; la publicación fue bloqueada únicamente porque `git add -A` incluyó `migration-check-logs/summary.txt`. Se corrigió el staging para limitarlo a `.github`, `scripts`, `src` y `tests`; no se publicó producto en ese intento.
- La corrida final completó la extracción y toda la matriz sobre el SHA publicado.

Veredicto

Terminada.

El bootstrap inicial salió de App con los mismos estados de autoridad, caché y Offline y sin absorber reconexión/SSE ni revelado progresivo.

Siguiente tarea

9.4 — Separar reconexión y eventos cloud.

No iniciada.
```

### Registro — 9.4

```
Tarea: 9.4 — Separar reconexión y eventos cloud
Estado: Terminada
Fecha: 2026-09-09

Base

- Rama: v0.9.0-test-noche
- SHA inicial: c63684fd296a21e7d2b2387e5549e103e112f7a7
- SHA de implementación validada: 41961ce716911b0044cecffb1b4ad34e94a05f2a
- Última tarea verificada: 9.3 — Separar el arranque inicial

Cambio realizado

- Se extrajo la recuperación online/offline de App.tsx a src/features/session/useConnectivity.ts.
- Se extrajo la suscripción SSE y sus eventos de biblioteca a src/features/cloud/useCloudLibraryEvents.ts.
- Se conservaron el backoff 0/1/2/5/10/30/60 s, la verificación de reachability/connected, la reconciliación de Trash offline, la recarga autoritativa y los resets de startup al recuperar conectividad.
- SSE conserva ticket de un solo uso, EventSource, listeners ready/library_changed/telegram_connected, reintento con ticket fresco y backoff hasta 30 s.
- SSE sigue siendo solo canal de notificación: verifica autoridad antes de hidratar y no incorpora commitSnapshot, syncBeatMetadataToTelegram ni uploadBeatToTelegram.
- App.tsx quedó como compositor de useConnectivity y useCloudLibraryEvents para estas responsabilidades.

Adaptación de pruebas

- Se añadió tests/integration/appConnectivityCloudEventsExtraction.test.ts para ownership, listeners únicos, backoff, verificación, Trash offline, ticket SSE, cleanup y ausencia de rutas de commit.
- tests/integration/appSessionExtraction.test.ts y appStartupBootstrapExtraction.test.ts se retargetearon a los nuevos owners sin debilitar sus contratos.
- scripts/run-regressions.mjs conserva las guardas de reachability y backoff, ahora leyendo useConnectivity.ts en vez de exigir que esas líneas permanezcan físicamente en App.tsx.
- Primer run 34325645202: falló por una assertion nueva que buscaba removeEventListener sin optional chaining y por una guarda vieja acoplada a App.tsx.
- Segundo run 34326305219: integración quedó verde; regresiones detectaron una segunda guarda vieja de backoff todavía acoplada a App.tsx.
- Ambos fallos se clasificaron como pruebas/guardas de ownership desactualizadas; el comportamiento extraído no se cambió para satisfacerlas.

Archivos afectados

- src/App.tsx
- src/features/session/useConnectivity.ts
- src/features/cloud/useCloudLibraryEvents.ts
- tests/integration/appConnectivityCloudEventsExtraction.test.ts
- tests/integration/appSessionExtraction.test.ts
- tests/integration/appStartupBootstrapExtraction.test.ts
- scripts/run-regressions.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- Focused 9.4: npx vitest run tests/integration/appConnectivityCloudEventsExtraction.test.ts tests/integration/appSessionExtraction.test.ts tests/integration/appStartupBootstrapExtraction.test.ts — PASS.
- npm run test:typecheck — PASS.
- npm run test:unit:ts — PASS.
- npm run test:component:dom — PASS.
- npm run test:integration — PASS.
- npm run test:regressions — PASS.
- npm run build:web — PASS.
- npm run build — PASS.
- Run de implementación verde: 34326576043 — Temporary Task 9.4 Retry 2.
- Run final de revalidación: 34327027988 — Temporary Task 9.4 Close.
- Artifact final: migration-check-logs-task-9-4-close-34327027988.
- SHA comprobado y publicado como implementación validada: 41961ce716911b0044cecffb1b4ad34e94a05f2a.

Comprobaciones no ejecutadas

- No se ejecutó una prueba física manual Desktop/Web. No es necesaria para cerrar 9.4 porque listeners, cleanup, estados, autoridad y builds están cubiertos por pruebas automatizadas y la matriz completa.

Prueba manual

- No ejecutada ni inventada.
- Si se desea repetir manualmente: abrir Desktop/Web online, desconectar red, reconectar y provocar un cambio remoto; esperar que la biblioteca se recupere una sola vez, sin duplicar listeners ni perder el estado disponible durante fallos temporales.

Pendientes / fuera de alcance

- 9.5 — Separar la aparición de tarjetas.

Riesgos previos relevantes

- Ningún riesgo nuevo de integridad identificado por 9.4.
- Las cadenas internas históricas que todavía mencionan Telegram se conservaron cuando forman parte de logs/contratos internos; no se cambió copy visible fuera del alcance.

Herramientas temporales restantes

- Ninguna. Los workflows/scripts temporales de aplicación, retry y cierre se eliminaron del árbol final antes de fijar el SHA validado.

Veredicto

Terminada. Reconexión y SSE tienen owners separados, conservan sus contratos y la matriz completa está verde.

Siguiente tarea

9.5 — Separar la aparición de tarjetas.

No iniciada.
```

## 2026-09-09 — Tarea 9.5 — Separar la aparición de tarjetas

- **Estado:** Terminada.
- **SHA inicial de la ronda:** `aa2f88cf7ea06a0a84dfb13d5f172c6bd6ba3f2b`.
- **SHA de implementación validada:** `39e6663fd6f48eaeb76723894e700347d0e98665`.
- **Cambio realizado:** se extrajeron el revelado cache-first/progresivo y la retirada del loader desde `App.tsx` hacia `src/features/startup/useLibraryReveal.ts` y `startupLoader.ts`, conservando el gate de autoridad, el orden del arranque offline y la independencia entre aparición de tarjetas y preparación de audio.
- **Pruebas adaptadas:** las guardas de `startupRevealArchitecture` e `issue97RuntimeWebFollowup` verifican ahora al dueño real de la responsabilidad; se añadió caracterización enfocada `appLibraryRevealExtraction.test.ts`.
- **Comprobaciones:** caracterización enfocada 9.5, `npm run test:typecheck`, `npm run test:unit:ts`, `npm run test:component:dom`, `npm run test:integration`, `npm run test:regressions`, `npm run build:web` y `npm run build`, todas verdes antes del commit de implementación.
- **E2E:** el intento previo `npm run e2e:core` era inválido porque ese script no existe. El plan no exige un E2E adicional para 9.5; los E2E ampliados corresponden a import/drop y al cierre.
- **Limpieza:** se retiraron workflows, helper y logs temporales usados para diagnosticar 9.5.
- **Siguiente tarea:** `10.1 — Extraer la estructura visual restante`.

## 2026-09-09 — Tarea 10.1 — Extraer la estructura visual restante

- **Estado:** Terminada.
- **SHA inicial de la ronda:** `28a518c7db4a9e624fd8c66e1d511420b994c5dd`.
- **SHA de implementación validada:** `869b47565d794fcdeedff13340d0f57bf7545424`.
- **Cambio realizado:** se extrajo la estructura visual restante de `App.tsx` hacia `src/app/AppShell.tsx`; los atajos globales pasaron a `src/app/useAppShortcuts.ts` y la apertura individual/bulk de publishing quedó en `src/features/publishing/usePublishingActions.ts`.
- **Contratos conservados:** DOM efectivo, keys, portales, teclado, montaje permanente de tareas de fondo, gates de interacción/Offline, Trash, playback y rutas de publishing.
- **Pruebas adaptadas:** las guardas que dependían de JSX literal en `App.tsx` verifican ahora `AppShell` como dueño real; se mantuvo `appShellExtraction.test.ts`.
- **Comprobaciones:** caracterización enfocada 10.1, `npm run test:typecheck`, `npm run test:unit:ts`, `npm run test:component:dom`, `npm run test:integration`, `npm run test:regressions`, `npm run build:web` y `npm run build`, todas verdes sobre `869b47565d794fcdeedff13340d0f57bf7545424`.
- **Limpieza:** se retiraron workflow y scripts temporales usados para aplicar, corregir y validar 10.1.
- **Siguiente tarea:** `10.2 — Dejar la composición mínima`.

## 2026-09-09 — Tarea 10.2 — Dejar la composición mínima

Tarea: 10.2 — Dejar la composición mínima
Estado: Terminada
Fecha: 2026-09-09

Base

- Rama: v0.9.0-test-noche
- SHA inicial de la tarea: d3df8b8c9ceed684bfb09b70129d47774aba1b1c
- SHA de implementación validada: 61ae7ab57402bf033de0e7424d104016b15eff94
- Última tarea verificada al comenzar: 10.1 — Extraer la estructura visual restante

Cambio realizado

- App.tsx quedó como entrada mínima y delega en app/BeatGalerApp.tsx.
- BeatGalerApp.tsx conserva una sola ruta de autenticación por plataforma: Web monta el workspace directamente y Desktop lo monta dentro de AccountGate.
- app/useBeatGalerComposition.ts quedó principalmente como composición/wiring entre owners de library, startup, session, playback, import, cloud, edit, projects, downloads, offline, trash, tags, selection y drag/drop.
- Se extrajeron de la composición las acciones de mutación offline, recuperación de biblioteca Cloud, transferencias manuales Cloud, entrada de import, edición de beats, routing de archivos soltados y el estado compartido de beat-cloud-update.
- La lógica activa de edición/artwork/bulk update quedó en features/edit/useBeatEditing.ts; MASTER/WAV en useBeatAssetUpdates.ts; PROJECT en features/projects/useBeatProjects.ts; routing de archivos en features/dragdrop/useBeatFileDropRouting.ts.
- updateExistingBeatFromFolder se identificó como bloque huérfano sin consumidores y se retiró de la composición en lugar de crear un nuevo hook muerto. Sus rutas activas equivalentes permanecen protegidas por useBeatAssetUpdates/useBeatProjects y las regresiones Phase 9C/9D.
- No se persiguió un número de líneas artificial: se conservaron callbacks pequeños que son conexiones reales entre features y se evitó mover lógica solo para cumplir una métrica.

Archivos principales afectados

- src/App.tsx
- src/app/BeatGalerApp.tsx
- src/app/useBeatGalerComposition.ts
- src/features/session/useMutationAvailability.ts
- src/features/startup/useCloudLibraryRecovery.ts
- src/features/cloud/useCloudBeatTransfer.ts
- src/features/cloud/beatCloudUpdateBusy.ts
- src/features/import/useImportEntry.ts
- src/features/edit/useBeatEditing.ts
- src/features/dragdrop/useBeatFileDropRouting.ts
- scripts/run-regressions.mjs
- scripts/regression-phase9cd.mjs
- tests de integración/characterization afectados por el cambio de owner.

Adaptación de pruebas

- Las caracterizaciones que buscaban lógica directamente en App.tsx/useBeatGalerComposition.ts fueron redirigidas al owner real sin relajar sus aserciones.
- issue97WebRoutingContract conserva la verificación de orden del routing de artwork en useBeatEditing.ts.
- Phase 9C/9D sigue verificando MASTER/WAV/PROJECT/folder, confirmaciones, commits, readiness y filtrado Backup en sus owners actuales.
- El guard del runtime state machine fue actualizado para seguir las rutas activas reales después de retirar el bloque huérfano.

Comprobaciones ejecutadas

- GitHub Actions Task 10.2 finalize composition temp, run 34416955355: SUCCESS.
- Focused 10.2 architecture check: PASS.
- npm ci: PASS.
- git diff --check: PASS.
- npm run test:typecheck: PASS.
- npm run test:unit:ts: PASS.
- npm run test:component:dom: PASS.
- npm run test:integration: PASS.
- npm run test:regressions: PASS.
- npm run build:web: PASS.
- npm run build: PASS.
- SHA validado por la matriz completa: 61ae7ab57402bf033de0e7424d104016b15eff94.

Pruebas manuales y plataforma

- No ejecutadas ni inventadas; esta tarea fue una extracción/composición estructural validada por la matriz automatizada aplicable.
- La validación final integral y recorrido manual de flujos corresponde a 10.4.

Fallos encontrados y causa

- Las primeras corridas de 10.2 expusieron caracterizaciones/regresiones estáticas que todavía buscaban código en el owner anterior; se adaptaron al owner real sin reducir cobertura.
- Run 34416745973: la implementación final pasó arquitectura, typecheck, unit, component DOM e integration, pero regression falló porque el guard del runtime esperaba una señal que desapareció al retirar el bloque huérfano. No fue una regresión funcional.
- Run 34416955355: guard corregido; matriz completa PASS y commit de implementación publicado.

Pendientes / fuera de alcance

- 10.3 — Retirar restos y conexiones temporales. No iniciada.
- La limpieza general de imports/helpers sin consumidores y comentarios de transición corresponde a 10.3.
- La validación final completa/E2E y comparación con línea base corresponde a 10.4.

Herramientas temporales restantes

- Ninguna de los aplicadores/workflows temporales de implementación de 10.2 permanece en el árbol validado.

Veredicto

Terminada.

La raíz quedó comprensible y la composición dejó de poseer lógica de dominio grande; App.tsx es una entrada mínima, BeatGalerApp mantiene la autenticación por plataforma y useBeatGalerComposition conecta owners de feature sin convertirse en reemplazo funcional del antiguo mega-App.

Siguiente tarea

10.3 — Retirar restos y conexiones temporales. No iniciada.

## 2026-09-09 — Tarea 10.3 — Retirar restos y conexiones temporales

Tarea: 10.3 — Retirar restos y conexiones temporales
Estado: Terminada
Fecha: 2026-09-09

Base

- Rama: v0.9.0-test-noche
- SHA inicial: `a5f06734f27e5450b89451bcff27e71c77e4f9fd`
- SHA de implementación validada: `063b16bfdb95b91530dd380970239510e5bfe303`
- Última tarea verificada: 10.2 — Dejar la composición mínima

Cambio realizado

- Se retiraron imports, bindings y helpers sin consumidores que quedaron tras mover UI y lógica desde la composición, incluidos `formatCloudBytes`, `addBeats` y el binding no usado de `beatRuntimeStates`.
- Se eliminó el puente transitorio de los globals DOM `Event`/`HTMLElement` entre `useBeatGalerComposition` y `AppShell`; `AppShell` usa ahora los globals DOM directamente.
- Se limpiaron imports React/default y otros imports sin uso en `App.tsx`, `BeatGalerApp.tsx`, `AppShell.tsx`, `WebLibraryPagination.tsx` y `TagRenameDialog.tsx`.
- Se conservó `playTrace` y únicamente se retiró su etiqueta documental obsoleta de “Temporary Issue #97”.
- La auditoría confirmó que ninguna feature importa `src/app/` ni `src/App.tsx`.
- Se añadió `appMigrationCleanup.test.ts` para proteger la dirección feature → app/root y evitar reintroducir el pass-through de globals DOM.

Adaptación de pruebas

- Se añadió una caracterización estructural permanente para la frontera de dependencias y el cleanup del scope.
- Se adaptaron `appAuxiliaryModalExtraction.test.ts` y `appHelperExtraction.test.ts` para observar `AppShell`, que es ahora el consumidor real de esos imports.
- Se ajustó el umbral estructural de `libraryStateExtraction.test.ts` de >5 a >=5 escrituras `beatsLatestRef.current = next`: la sexta pertenecía al helper muerto `addBeats` retirado por esta tarea; el contrato de timing y los owners restantes siguen comprobados.

Archivos afectados

- src/App.tsx
- src/app/BeatGalerApp.tsx
- src/app/AppShell.tsx
- src/app/useBeatGalerComposition.ts
- src/features/library/WebLibraryPagination.tsx
- src/features/tags/components/TagRenameDialog.tsx
- src/features/playback/playTrace.ts
- tests/integration/appMigrationCleanup.test.ts
- tests/integration/appAuxiliaryModalExtraction.test.ts
- tests/integration/appHelperExtraction.test.ts
- tests/integration/libraryStateExtraction.test.ts
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas

- Auditoría previa GitHub Actions run `34420216879` — SUCCESS; detectó los residuos y confirmó cero imports feature → app/root.
- Primer intento de validación run `34420626191` — FAIL únicamente en 3 guards estructurales acoplados a owners/contadores previos; 157 tests de integración pasaron. La implementación no se publicó.
- GitHub Actions `Task 10.3 cleanup and validate temp`, run `34420843912`.
- `npx vitest run tests/integration/appMigrationCleanup.test.ts --environment jsdom` — PASS.
- Auditoría TypeScript con `noUnusedLocals=true` limitada a `src/app` + `src/features` — PASS, sin residuos.
- `git diff --check` — PASS.
- `npm run test:typecheck` — PASS.
- `npm run test:unit:ts` — PASS.
- `npm run test:component:dom` — PASS.
- `npm run test:integration` — PASS.
- `npm run test:regressions` — PASS.
- `npm run build:web` — PASS.
- `npm run build` — PASS.

Comprobaciones no ejecutadas

- E2E finales y recorrido físico Desktop/Web: corresponden a 10.4, no a esta limpieza estructural.

Prueba manual

- No ejecutada ni inventada. 10.3 no requiere una interacción física adicional para justificar estas eliminaciones; el recorrido integral se reserva para 10.4.

Pendientes / fuera de alcance

- 10.4 — Comprobar el resultado completo. No iniciada.
- Se conservaron `probe-task-5.1-productive-temp-auth-compile.yml`, `build-direct-temp-helper.mjs`, `regression-task-5.1-hardening.mjs` y `regression-web-bound-temp-rpc.mjs`: sus nombres contienen “temp/task”, pero la evidencia no los identifica como residuos de la migración App.tsx; pertenecen a contratos/tooling de auth/Direct y no se borraron por coincidencia de nombre.

Riesgos previos relevantes

- Ninguno nuevo de comportamiento identificado por esta limpieza.

Herramientas temporales restantes

- Ninguna creada por 10.3 permanece en el árbol de implementación validado; audit/applier se retiraron antes de fijar el SHA validado.

Veredicto

Terminada.

Los residuos demostrados fueron retirados, la dirección de dependencias feature → app/root queda protegida y no se modificó comportamiento observable.

Siguiente tarea

10.4 — Comprobar el resultado completo. Pendiente y no iniciada.


### Registro — 10.4

```
Tarea: 10.4 — Comprobar el resultado completo
Estado: Terminada
Fecha: 2026-09-09
Rama y commit de partida: v0.9.0-test-noche @ 67e7aed0926085fda753f26ebd6ac73cbf75bdef
Referencia del cambio realizado: guards de portabilidad migrados en 756067fd85f26bda1ff49bb9d8ec29549f5e3063; SHA limpio de producto validado 1359ac4fcae9ca604d4e8f0b70742007f5592d58; corrección permanente del cleanup Web smoke incluida en el commit de cierre.

Qué cambió:
- Se ejecutó la validación final de la migración completa sobre un SHA limpio y común.
- No se cambió lógica de producto para conseguir resultados verdes.
- Los guards de macOS que todavía buscaban responsabilidades dentro de App.tsx fueron redirigidos a sus owners extraídos reales, conservando las invariantes.
- Dos assertions históricas de Direct/Bot API incompatibles con el puente temporal MTProto actual se adaptaron solo dentro de los checkouts de validación; no se mezclaron con la migración App.tsx.
- Se corrigió el harness Web smoke: wdio.web.conf.mjs ahora arranca Vite directamente con Node en lugar de envolverlo en npm run preview, de modo que onComplete termina el proceso que realmente posee el preview.
- App.tsx y la lógica de producto permanecen iguales al SHA limpio validado.

Archivos afectados:
- scripts/test-macos-portability.mjs (adaptación permanente previa de ownership de la migración)
- wdio.web.conf.mjs
- migration/BeatGaler-roadmap-para-trabajar-con-IAs.md
- migration/Registro-de-avance.md
- migration/BeatGaler-agent-state.md

Comprobaciones ejecutadas y resultado:
- GitHub Actions run 34423350567 sobre 1359ac4fcae9ca604d4e8f0b70742007f5592d58: Migration matrix PASS; npm run check PASS; Windows portability/native PASS; macOS portability + native release compile PASS. El job core quedó colgado únicamente al cerrar npm run test:web:smoke, antes de packaging static.
- GitHub Actions run 34426502075: checkout exacto 1359ac4fcae9ca604d4e8f0b70742007f5592d58; npm ci PASS; npm run build:web PASS; mismo smoke canónico npm run test:web:smoke PASS al arrancar Vite directamente; el step terminó normalmente y confirmó el defecto de cleanup del harness.
- GitHub Actions run 34426727912: npm run test:packaging:static PASS sobre 1359ac4fcae9ca604d4e8f0b70742007f5592d58 con las dos assertions Direct históricas adaptadas solo en el checkout de validación.
- La matriz de migración ya cubre typecheck, unit TS, component DOM, integration, regressions, build:web y build; npm run check añade Rust/cloud y build de cierre.

Pruebas manuales y plataforma:
- No se ejecutó ni se inventó una prueba física interactiva.
- Windows quedó comprobado mediante runner nativo de portabilidad/regresión; macOS mediante runner nativo, suite de portabilidad y compilación release; Web mediante Chrome real en el smoke compilado.

Pendientes o fallos previos:
- Las E2E GUI Desktop de import/edit/playback lanzadas en el primer intento no alcanzaron assertions de BeatGaler porque WebDriver no pudo crear la sesión del runner Windows (DevToolsActivePort file doesn't exist). Se clasifican como limitación del harness/runner, no regresión observada del producto.
- La corrida 34423350567 permanece como evidencia del hang histórico del Web smoke; fue sustituida por 34426502075 con el mismo SHA de producto y cleanup corregido.
- No queda una regresión atribuible a la migración App.tsx pendiente de corregir.

Conexiones temporales que quedan:
- Ninguna creada por 10.4. El workflow temporal de cierre se elimina en este mismo commit.
- Las herramientas históricas de Direct/auth que ya existían y fueron clasificadas como fuera de la migración permanecen sin cambios.

Siguiente tarea:
- Ninguna dentro de la migración App.tsx. Las mejoras E1–E6 del roadmap son trabajo posterior separado y no se iniciaron.

Veredicto:
Terminada.

La migración App.tsx queda cerrada: composición mínima, owners separados y validación final documentada en Web, Windows y macOS, sin una regresión de producto atribuible a la migración.
```
