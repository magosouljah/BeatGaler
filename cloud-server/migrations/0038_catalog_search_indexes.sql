BEGIN;

-- T20-N — Índices de búsqueda de subcadena (STOP-PERF filter_nomatch_q_* / filter_rare_q a 1M filas). Aditiva; no cambia la semántica
-- (SEARCH_PROFILE intacto): son índices sobre catalog_beats.search_text (0037), nunca una fuente de verdad.
--
-- 1) q de >= 3 caracteres: GIN pg_trgm sobre `search_text COLLATE "C"` (la misma expresión que usa `search_text COLLATE "C" LIKE`).
--    pg_trgm es una extensión "trusted" (PG13+): la crea el dueño de la base, sin superusuario.
-- 2) q de 1-2 caracteres (sin trigramas útiles): GIN invertido de 1-gramas y 2-gramas por CAMPO. catalog_search_grams(search_text)
--    devuelve el conjunto de subcadenas de 1 y 2 caracteres de cada campo (campos separados por chr(31)); ninguna cruza un límite de
--    campo. `catalog_search_grams(search_text) @> ARRAY[q]` es exactamente `search_text LIKE %q%` cuando q tiene 1-2 caracteres y no
--    contiene chr(31). Es un índice de expresión: no añade columnas ni escritores; PostgreSQL lo mantiene al cambiar search_text.
-- 3) Filas aún sin proyectar (search_text NULL, ver guarda de 0037): índice parcial diminuto para que el OR de queries.js siga usando bitmap.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- COST alto: es ~0,13 ms por fila; el planner no debe tratarla como un filtro barato de recorrido (ver queries.js, modo GRAMS).
CREATE FUNCTION catalog_search_grams(s text) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT COST 1000 AS $fn$
  SELECT coalesce(array_agg(DISTINCT g), '{}'::text[]) FROM (
    SELECT substr(f, i, 1) AS g FROM unnest(string_to_array(s, chr(31))) AS f, generate_series(1, char_length(f)) AS i
    UNION ALL
    SELECT substr(f, i, 2) FROM unnest(string_to_array(s, chr(31))) AS f, generate_series(1, char_length(f) - 1) AS i
  ) x
$fn$;

CREATE INDEX catalog_beats_search_trgm_idx ON catalog_beats USING gin ((search_text COLLATE "C") gin_trgm_ops);
CREATE INDEX catalog_beats_search_grams_idx ON catalog_beats USING gin (catalog_search_grams(search_text));
CREATE INDEX catalog_beats_search_null_idx ON catalog_beats (user_id, generation_id, state) WHERE search_text IS NULL;

ANALYZE catalog_beats;

COMMIT;
