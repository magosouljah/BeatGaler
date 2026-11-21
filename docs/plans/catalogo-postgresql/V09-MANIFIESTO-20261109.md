# V08-C → V09 — Manifiesto de regresión en navegador real (2026-11-09)

**Propósito:** V09 (MATRIZ-V) debe ejecutarse en navegadores reales con lector de pantalla; no es ejecutable en este CI aislado (sin Chrome/Edge reales ni lector). Este manifiesto fija qué se prueba, con qué comandos y sobre qué estado, para que BAJA lo ejecute cuando exista el entorno (plan B §9). **Hasta entonces V09 queda PENDIENTE y T16 no puede declararse PASS.**

## 1. Entorno a registrar (V09-A)

Navegador exacto y flags (Chrome y Edge), UA, SO, CPU/RAM/GPU, tasa de refresco, DPR, viewport, zoom, fuentes instaladas, headful/headless, red (LAN-LAB), lector de pantalla disponible (NVDA/Narrador). Capturas de referencia LOCAL con el mismo SHA de CSS/DESIGN (no de `main`).

## 2. Estado del sistema para las pruebas

- Servidor: `BEATGALER_CONTROL_PLANE_AUTHORITY=postgres`, `BEATGALER_CATALOG_NATIVE_ENABLED=true`, **sin** `BEATGALER_CATALOG_GATEWAY_ENABLED` (gateway real no implementado → subidas 503 `TRANSFER_UNAVAILABLE`, reproducción por medios 503), journal opcional.
- Cliente: `VITE_CATALOG_API_ENABLED=true` para la rama POSTGRES; `false` para la regresión LEGACY.
- Fixture: biblioteca nativa provisionada (POST `/catalog/v1/library/provision`) con beats importados por el flujo T12 **fake** (no hay proveedor real), biblioteca LEGACY intacta y un vault no elegible (RESET_REQUIRED).

## 3. Casos (plan B §9 aplicables a UI + r4 T16/V08–V09)

| Fila | Qué | Dónde (comandos existentes) | Resultado esperado |
| --- | --- | --- | --- |
| C12-V-GEOM | Geometría de filas/columnas a 375/768/1440 (±1 px), zoom 100 %/200 %, reduced-motion | `tests/component-dom/catalogRowGeometry.test.ts` (jsdom) + captura real | Igual a LOCAL; sin scroll horizontal; overscan según V03 |
| C12-V-SCROLL | Scroll inverso, PageUp/PageDown, Home/End, Ctrl+End (edge=last), anclas | `catalogQueryStore.test.ts`, `catalogVirtualGallery.test.tsx` | Sin saltos; evicción nunca libera audio |
| C12-V-BORDER | Placeholders de frontera, reintento contextual, bgPage legacy (exact/last/empty/>10.000) | `catalogNavigation.test.ts` | Copy B-legacy exacto; «Ir al inicio» sin salto automático |
| C12-V-FOCUS | Tab/Shift+Tab, Escape de menú, retorno de detalle (`returnAnchor`), foco nunca en body | lector de pantalla real | `role=feed`/`article`, `aria-posinset/setsize` anunciados |
| C12-V-MEDIA | Play/seek mientras la tarjeta y el DTO se expulsan; cola con IDs no cargados; Shuffle sin repetición | `catalogPlaybackSession.test.ts` (node) + navegador | Playbar sigue; 0 URLs revocadas indebidamente (`catalogMediaClient.metrics`) |
| C12-V-RESOURCES | 10 000 ciclos mount/unmount con menús/artwork/hover y StrictMode | navegador + contadores | Timers/listeners/observers/blob URLs vuelven al baseline |
| C12-V-INTERACTION | Select All (count servidor), Shift por extremos, aviso «Selección borrada al cambiar los filtros», conflicto de revisión, bulk desde Drawer con reporte por lote, rename parcial | `catalogInteractionStore.test.ts` + navegador | Copy exacto r4; comandos deshabilitados en conflicto |
| C12-V-QUERY | Filtros/sort/búsqueda globales con totalMatched del servidor | `catalogApi.test.ts`, `catalogQueryStore.test.ts` | Sin cálculo local sobre `windowItems` |
| C12-V-AUTH | Cambio de cuenta A→B, logout, 401 | `catalogLibraryComposition.test.tsx` (teardown) + navegador | Ningún dato/URL de A visible en B |
| C12-V-LEGACY | Regresión LEGACY con flag apagado: pager, App, Playbar idénticos | runner auditado (`npm test` existente) + capturas | 0 peticiones a `/catalog/v1` |
| r4 T16 | Preparación de conjunto (estado/cancelación), aviso condicional, conflictos y vuelta atrás, RESET_REQUIRED y cuarentena como estados bloqueados | navegador | Nunca camino LEGACY para un contexto bloqueado |

## 4. Criterio

Todos los casos, **0 skips obligatorios**, capturas y contadores adjuntos (plan B §8). Un fallo multicomponente escala a MEDIA (V09-C); un caso que exija eliminar una capacidad es STOP-UX. La paridad visual completa de la rama POSTGRES (chrome, tarjetas, Playbar) **no está terminada** en T16: `CatalogGalleryWorkspace` monta la Gallery virtualizada con tarjetas mínimas; GalleryChrome/Playbar/Drawer sobre los servicios del catálogo quedan como integración pendiente antes de V09.
