BEGIN;

-- T06 — Consultas paginadas y endpoints de lectura (CONTRATO C5, C12-r4 §3–§5, MATRIZ-V V02).
-- Aditiva: no modifica datos legacy, 0026 ni 0027. Solo TEXT para JSON (D-08).
--  - Perfil de orden de nombres A1: colación ICU `und`, no determinista (C12 §3.2). Si el servidor no tiene ICU,
--    CREATE COLLATION falla y la migración entera se rechaza (STOP-DESIGN-A): nunca se sustituye por libc.
--  - Proyecciones JS materializadas (search-js-v1 / display de webLibrary.ts:165-193), escritas por el código que
--    inserta o edita el beat; el backfill SQL de abajo solo cubre filas de laboratorio preexistentes (no hay
--    bibliotecas reales) y se aproxima a la semántica JS, nunca la sustituye para escrituras nuevas.
--  - Índices por tupla de orden completa con beat_id COLLATE "C" (C12 §4.3), para keyset hacia delante y atrás.

CREATE COLLATION catalog_name_icu_und_v1 (provider = icu, locale = 'und', deterministic = false);

ALTER TABLE catalog_beats ADD COLUMN name_display text;
ALTER TABLE catalog_beats ADD COLUMN name_search text;
ALTER TABLE catalog_beats ADD COLUMN key_display text;
ALTER TABLE catalog_beats ADD COLUMN key_search text;
ALTER TABLE catalog_beats ADD COLUMN bpm_display text;
ALTER TABLE catalog_beats ADD COLUMN rating_display smallint;

UPDATE catalog_beats SET
  name_display = CASE WHEN name IS NULL OR btrim(name) = '' THEN 'Untitled' ELSE btrim(name) END,
  name_search = lower(CASE WHEN name IS NULL OR btrim(name) = '' THEN 'Untitled' ELSE btrim(name) END),
  key_display = coalesce(key_text, ''),
  key_search = lower(coalesce(key_text, '')),
  bpm_display = coalesce(bpm_text, ''),
  rating_display = coalesce(rating, 0)
WHERE name_display IS NULL;

ALTER TABLE catalog_beats ALTER COLUMN name_display SET NOT NULL;
ALTER TABLE catalog_beats ALTER COLUMN name_search SET NOT NULL;
ALTER TABLE catalog_beats ALTER COLUMN key_display SET NOT NULL;
ALTER TABLE catalog_beats ALTER COLUMN key_search SET NOT NULL;
ALTER TABLE catalog_beats ALTER COLUMN bpm_display SET NOT NULL;
ALTER TABLE catalog_beats ALTER COLUMN rating_display SET NOT NULL;
ALTER TABLE catalog_beats ADD CONSTRAINT catalog_beats_rating_display_range CHECK (rating_display BETWEEN 0 AND 255);
ALTER TABLE catalog_beats ADD CONSTRAINT catalog_beats_name_display_nonempty CHECK (name_display <> '');

ALTER TABLE catalog_beat_tags ADD COLUMN search_key text;
UPDATE catalog_beat_tags SET search_key = lower(label) WHERE search_key IS NULL;
ALTER TABLE catalog_beat_tags ALTER COLUMN search_key SET NOT NULL;

-- Tuplas de orden (C12 §4.3). Todas ASC para permitir comparación de filas (ROW(...) > ROW(...)) en ambas direcciones;
-- rating se indexa como (255 - rating_display) para que "rating DESC" sea ASC en la tupla.
CREATE INDEX catalog_beats_order_manual_idx ON catalog_beats(user_id, generation_id, state, manual_rank, beat_id COLLATE "C");
CREATE INDEX catalog_beats_order_rating_idx ON catalog_beats(user_id, generation_id, state, (255 - rating_display), manual_rank, beat_id COLLATE "C");
CREATE INDEX catalog_beats_order_name_idx ON catalog_beats(user_id, generation_id, state, name_display COLLATE catalog_name_icu_und_v1, manual_rank, beat_id COLLATE "C");
CREATE INDEX catalog_beats_order_bpm_idx ON catalog_beats(user_id, generation_id, state, bpm_sort_class, (coalesce(bpm_sort, 0::float8)), manual_rank, beat_id COLLATE "C");

-- Facetas (C12-r4 §6): frecuencia desc, nombre representante bajo A1, clave binaria final.
CREATE INDEX catalog_facets_order_idx ON catalog_facets(user_id, generation_id, scope, beat_count DESC, rep_label COLLATE catalog_name_icu_und_v1, norm_key COLLATE "C")
  WHERE beat_count > 0;

-- Miembros de conjuntos: recorrido por slot ya cubierto por la PK; lookup por beat por el UNIQUE (user_id, set_id, beat_id).

COMMIT;
