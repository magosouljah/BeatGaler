
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
