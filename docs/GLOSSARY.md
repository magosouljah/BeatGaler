# Glosario de BeatGaler V1

- **Biblioteca** — Catálogo de un usuario, asociado a un vault y a una generación activa (`cloud-server/catalog/authority.js`).
- **Autoridad** — Fuente que determina los metadatos y el estado del catálogo. La autoridad nativa es PostgreSQL (`cloud-server/catalog/authority.js`).
- **Era** — Identificador del contexto de autoridad que las mutaciones versionadas deben presentar (`cloud-server/catalog/authority.js`).
- **Época** — Contador de autoridad que permite rechazar peticiones con contexto obsoleto (`cloud-server/catalog/authority.js`).
- **Versión** — Valor del beat que el cliente presenta para controlar escrituras concurrentes (`cloud-server/catalog/commands.js`, `cloud-server/catalog/beat-projection.js`).
- **Operación** — Registro durable de una intención del catálogo y de su estado o resultado (`cloud-server/catalog/commands.js`, `cloud-server/catalog/operations.js`).
- **Trabajo / cola** — Unidad de ejecución diferida de `catalog_jobs`, reclamada por el worker con lease y generación de lease (`cloud-server/catalog/operations.js`, `cloud-server/catalog/worker.js`).
- **Transacción de biblioteca** — Envoltorio SQL que aplica la política correspondiente al módulo y a la intención (`cloud-server/catalog/library-tx.js`).
- **Cuarentena** — Estado que registra un conflicto de flush del control-plane y restringe accesos según la intención (`cloud-server/catalog/flush-quarantine.js`, `cloud-server/catalog/library-tx.js`).
- **Sesión de importación** — Estado observable de la revisión, progreso, tarjetas provisionales y operaciones pendientes de subida (`src/features/library/catalog/catalogImportSession.ts`).
- **Edición de beat** — Interfaz de guardado, reemplazo o papelera con una lectura compartida del resultado (`src/features/library/catalog/catalogBeatEditor.ts`).
- **Sesión de consulta** — Coordinación de navegación, filtros, facetas e invalidación de Gallery (`src/features/library/catalog/catalogQuerySession.ts`).
- **Enlace de reproducción** — Conexión entre la sesión de reproducción y el motor de `useAudio` (`src/features/library/catalog/catalogPlaybackLink.ts`).
- **Direct B** — Transporte de medios entre navegador y Telegram mediante una clave MTProto temporal del navegador vinculada por el Cloud (`src/features/library/catalog/catalogDirectPort.ts`, `cloud-server/catalog/direct.js`).
- **C7.8** — Regla de integridad que persiste la identidad antes de enviar y reconcilia un envío incierto sin reenviarlo a ciegas (`cloud-server/catalog/direct.js`, `src/features/library/catalog/catalogTransfer.ts`).
