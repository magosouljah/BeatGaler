BEGIN;

-- T20-N — Contadores exactos de 1-/2-gramas por biblioteca y estado. Evidencia (1M filas, EXPLAIN/pgbench, ver T20-CAPACIDAD): el GIN de gramas
-- (0038) resuelve q de 1-2 caracteres sin coincidencias o raras en ~1 ms, pero el planner también lo elige para gramas frecuentes, donde es
-- muy peor que el recorrido ordenado por LIMIT (página 'mi' 2,7 -> 257 ms; COUNT 'mi' 0,8 -> 12,7 s). queries.js usa este contador para
-- (a) elegir el camino de forma determinista (poco frecuente = GIN; frecuente = recorrido ordenado) y (b) responder COUNT exacto de q de 1-2
-- caracteres sin escanear cuando solo hay q + estado. El contador NUNCA es fuente de verdad: es una proyección de catalog_beats.search_text.
--
-- beat_count = número de beats de (user_id, generation_id, state) cuyo search_text contiene la subcadena `gram` (1 o 2 caracteres, dentro de un
-- campo; ver catalog_search_grams en 0038). Esparcido: no existen filas con beat_count = 0. Se mantiene en la MISMA transacción del escritor,
-- con triggers de sentencia (tablas de transición): cualquier escritor de catalog_beats (PATCH, bulk, trash/restore, purge, import/replace,
-- reconstrucciones) queda cubierto sin tocar el código de aplicación. Los escritores de una biblioteca ya están serializados por el lock de
-- biblioteca; las filas se actualizan en orden de clave para no crear ciclos de bloqueo entre bibliotecas.
CREATE TABLE catalog_search_gram_counts (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  state text NOT NULL,
  gram text NOT NULL,
  beat_count bigint NOT NULL,
  PRIMARY KEY (user_id, generation_id, state, gram)
);

INSERT INTO catalog_search_gram_counts(user_id, generation_id, state, gram, beat_count)
SELECT b.user_id, b.generation_id, b.state, g.gram, count(*)
FROM catalog_beats b CROSS JOIN LATERAL unnest(catalog_search_grams(b.search_text)) AS g(gram)
WHERE b.search_text IS NOT NULL
GROUP BY 1, 2, 3, 4;

-- Aplica un delta firmado ya agregado (tabla temporal de la sentencia) y valida: nunca negativo; sin filas en cero.
CREATE FUNCTION catalog_search_counts_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO catalog_search_gram_counts AS c(user_id, generation_id, state, gram, beat_count)
  SELECT d.user_id, d.generation_id, d.state, d.gram, d.n FROM (
    SELECT n.user_id, n.generation_id, n.state, g.gram, count(*)::bigint AS n
    FROM new_rows n CROSS JOIN LATERAL unnest(catalog_search_grams(n.search_text)) AS g(gram)
    WHERE n.search_text IS NOT NULL GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4) d
  ON CONFLICT (user_id, generation_id, state, gram) DO UPDATE SET beat_count = c.beat_count + EXCLUDED.beat_count;
  RETURN NULL;
END $fn$;

CREATE FUNCTION catalog_search_counts_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO catalog_search_gram_counts AS c(user_id, generation_id, state, gram, beat_count)
  SELECT d.user_id, d.generation_id, d.state, d.gram, -d.n FROM (
    SELECT o.user_id, o.generation_id, o.state, g.gram, count(*)::bigint AS n
    FROM old_rows o CROSS JOIN LATERAL unnest(catalog_search_grams(o.search_text)) AS g(gram)
    WHERE o.search_text IS NOT NULL GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4) d
  ON CONFLICT (user_id, generation_id, state, gram) DO UPDATE SET beat_count = c.beat_count + EXCLUDED.beat_count;
  IF EXISTS (SELECT 1 FROM catalog_search_gram_counts c WHERE c.beat_count < 0 AND (c.user_id, c.generation_id) IN (SELECT DISTINCT o.user_id, o.generation_id FROM old_rows o)) THEN
    RAISE EXCEPTION 'catalog_search_gram_counts would become negative' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM catalog_search_gram_counts c WHERE c.beat_count = 0 AND (c.user_id, c.generation_id) IN (SELECT DISTINCT o.user_id, o.generation_id FROM old_rows o);
  RETURN NULL;
END $fn$;

CREATE FUNCTION catalog_search_counts_update() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_n bigint;
BEGIN
  INSERT INTO catalog_search_gram_counts AS c(user_id, generation_id, state, gram, beat_count)
  SELECT d.user_id, d.generation_id, d.state, d.gram, d.n FROM (
    WITH ch AS (
      SELECT o.user_id, o.generation_id, o.state AS os, n.state AS ns, o.search_text AS ost, n.search_text AS nst
      FROM old_rows o JOIN new_rows n ON n.user_id = o.user_id AND n.generation_id = o.generation_id AND n.beat_id = o.beat_id
      WHERE o.search_text IS DISTINCT FROM n.search_text OR o.state IS DISTINCT FROM n.state),
    g1 AS MATERIALIZED (SELECT c.user_id, c.generation_id, c.os, c.ns, c.ost, c.nst, catalog_search_grams(c.ost) AS og FROM ch c),
    gr AS ( -- los gramas se calculan una sola vez por fila cuando solo cambia el estado (trash/restore/purge); STRICT: NULL -> sin gramas
      SELECT g.user_id, g.generation_id, g.os, g.ns, g.og,
             CASE WHEN g.nst IS NOT DISTINCT FROM g.ost THEN g.og ELSE catalog_search_grams(g.nst) END AS ng
      FROM g1 g)
    SELECT x.user_id, x.generation_id, x.state, x.gram, sum(x.d)::bigint AS n FROM (
      SELECT r.user_id, r.generation_id, r.os AS state, g.gram, -1 AS d FROM gr r CROSS JOIN LATERAL unnest(r.og) AS g(gram)
      UNION ALL
      SELECT r.user_id, r.generation_id, r.ns, g.gram, 1 FROM gr r CROSS JOIN LATERAL unnest(r.ng) AS g(gram)
    ) x GROUP BY 1, 2, 3, 4 HAVING sum(x.d) <> 0 ORDER BY 1, 2, 3, 4) d
  ON CONFLICT (user_id, generation_id, state, gram) DO UPDATE SET beat_count = c.beat_count + EXCLUDED.beat_count;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN -- la mayoría de los UPDATE (rating, versión...) no cambian search_text ni state: no hay delta que validar
    IF EXISTS (SELECT 1 FROM catalog_search_gram_counts c WHERE c.beat_count < 0 AND (c.user_id, c.generation_id) IN (SELECT DISTINCT n.user_id, n.generation_id FROM new_rows n)) THEN
      RAISE EXCEPTION 'catalog_search_gram_counts would become negative' USING ERRCODE = 'check_violation';
    END IF;
    DELETE FROM catalog_search_gram_counts c WHERE c.beat_count = 0 AND (c.user_id, c.generation_id) IN (SELECT DISTINCT n.user_id, n.generation_id FROM new_rows n);
  END IF;
  RETURN NULL;
END $fn$;

CREATE TRIGGER catalog_beats_search_counts_ins AFTER INSERT ON catalog_beats REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_search_counts_insert();
CREATE TRIGGER catalog_beats_search_counts_del AFTER DELETE ON catalog_beats REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_search_counts_delete();
CREATE TRIGGER catalog_beats_search_counts_upd AFTER UPDATE ON catalog_beats REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_search_counts_update();

ANALYZE catalog_search_gram_counts;

COMMIT;
