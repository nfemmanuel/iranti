-- AX-1: normalize existing fact keys (data migration, no schema change).
--
-- Layer 1 normalization — kept in EXACT parity with the TypeScript normalizeKey
-- in src/library/keys.ts so a row normalized here is found by an application read:
--   1. Split optional category: prefix on the first colon.
--   2. camelCase → hyphen boundaries (two regex passes, BEFORE lowercasing).
--   3. Lowercase.
--   4. Collapse runs of non-alphanumeric characters to a single hyphen.
--   5. Trim leading/trailing hyphens.
--   6. Cap at 80 chars (drop a trailing hyphen left by the cut).
--
-- Duplicate handling: rows that collide after normalization are collapsed by
-- keeping the most recently updated row and ARCHIVING the losers to fact_archive
-- (reason "superseded") before deleting them — facts are never hard-deleted, and
-- this matches the live supersession path (PRD §7: 1 survivor + N-1 archive events).

-- Helper: normalize one segment (no colon handling). Mirrors normalizeSegment.
CREATE OR REPLACE FUNCTION _iranti_norm_seg(s text) RETURNS text AS $$
  SELECT btrim(
    regexp_replace(
      lower(
        regexp_replace(
          regexp_replace(s, '([a-z0-9])([A-Z])', '\1-\2', 'g'),
          '([A-Z]+)([A-Z][a-z])', '\1-\2', 'g'
        )
      ),
      '[^a-z0-9]+', '-', 'g'
    ),
    '-'
  );
$$ LANGUAGE sql IMMUTABLE;

-- Helper: normalize a full key, handling optional category: prefix + 80-char cap.
CREATE OR REPLACE FUNCTION _iranti_norm_key(raw text) RETURNS text AS $$
DECLARE
  col_pos int := position(':' in raw);
  cat     text;
  body    text;
  result  text;
BEGIN
  IF col_pos > 0 THEN
    cat  := _iranti_norm_seg(left(raw, col_pos - 1));
    body := _iranti_norm_seg(substr(raw, col_pos + 1));
    result := CASE
      WHEN cat  = '' THEN body
      WHEN body = '' THEN cat
      ELSE cat || ':' || body
    END;
  ELSE
    result := _iranti_norm_seg(raw);
  END IF;
  -- Cap at 80 chars, dropping any trailing hyphen the cut leaves behind.
  IF length(result) > 80 THEN
    result := regexp_replace(left(result, 80), '-+$', '');
  END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint

-- Collapse duplicates: archive the losers (under the SURVIVOR's fact_id, since the
-- loser row is about to be deleted and fact_archive.fact_id has a FK to facts.id),
-- then delete them. Data-modifying CTEs run exactly once regardless of reference.
WITH ranked AS (
  SELECT
    id, tenant_id, entity_type, entity_id,
    _iranti_norm_key(key) AS nkey,
    value, confidence, source, surface, session_id, agent_id,
    stability_score, access_count, metadata,
    row_number() OVER w   AS rn,
    first_value(id) OVER w AS survivor_id
  FROM facts
  WINDOW w AS (
    PARTITION BY tenant_id, entity_type, entity_id, _iranti_norm_key(key)
    ORDER BY updated_at DESC NULLS LAST
  )
),
losers AS (
  SELECT * FROM ranked WHERE rn > 1
),
archived AS (
  INSERT INTO fact_archive (
    fact_id, tenant_id, entity_type, entity_id, key, value, confidence,
    source, surface, session_id, agent_id, stability_score, access_count,
    metadata, archived_reason
  )
  SELECT
    survivor_id, tenant_id, entity_type, entity_id, nkey, value, confidence,
    source, surface, session_id, agent_id, stability_score, access_count,
    metadata, 'superseded'
  FROM losers
  RETURNING fact_id
)
DELETE FROM facts WHERE id IN (SELECT id FROM losers);
--> statement-breakpoint

-- facts: normalize the key column and stamp rawKey into metadata for changed rows,
-- preserving any existing rawKey (don't clobber genuine provenance from prior writes).
UPDATE facts
SET
  key      = _iranti_norm_key(key),
  metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('rawKey', COALESCE(metadata->>'rawKey', key))
WHERE key != _iranti_norm_key(key);
--> statement-breakpoint

-- fact_archive: no uniqueness constraint — just normalize (same rawKey-preserving rule).
UPDATE fact_archive
SET
  key      = _iranti_norm_key(key),
  metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('rawKey', COALESCE(metadata->>'rawKey', key))
WHERE key != _iranti_norm_key(key);
--> statement-breakpoint

-- Clean up helpers (idempotent).
DROP FUNCTION IF EXISTS _iranti_norm_key(text);
DROP FUNCTION IF EXISTS _iranti_norm_seg(text);
