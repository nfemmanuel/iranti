-- iranti health views — Phase 2.5 (CORE-14): system self-awareness (master PRD §3).
--
-- Read-only reporting views over the behavioral-telemetry tables. They expose
-- ONLY counts, sizes, latency, and scores — never the content of a fact,
-- message, or session (master PRD §11 hard constraint; the underlying tables
-- already hold no content).
--
-- Apply once against the iranti database (safe to re-run — every view is
-- CREATE OR REPLACE):
--     psql "$DATABASE_URL" -f scripts/health.sql
--
-- Then answer the Phase 2.5 gate questions with a single SELECT each, e.g.:
--     SELECT * FROM iranti_health_suppression;        -- "tokens saved this week"
--     SELECT * FROM iranti_health_latency;             -- attend latency
--     SELECT * FROM iranti_health_escalations;         -- escalations by status

-- 1. Attends per day, split by lifecycle phase (CORE-31).
CREATE OR REPLACE VIEW iranti_health_attends_per_day AS
SELECT tenant_id,
       date_trunc('day', created_at)::date           AS day,
       count(*)                                       AS attends,
       count(*) FILTER (WHERE phase = 'pre-response')  AS pre_response,
       count(*) FILTER (WHERE phase = 'post-response') AS post_response,
       count(*) FILTER (WHERE phase = 'mid-turn')      AS mid_turn,
       sum(facts_extracted)                            AS facts_extracted
FROM attend_log
GROUP BY tenant_id, date_trunc('day', created_at)
ORDER BY day DESC;

-- 2. Average injection size (estimated tokens, facts, rules) per day.
CREATE OR REPLACE VIEW iranti_health_injection_size AS
SELECT tenant_id,
       date_trunc('day', created_at)::date AS day,
       count(*)                            AS attends,
       round(avg(injected_tokens_est), 1)  AS avg_injected_tokens,
       round(avg(fact_count), 1)           AS avg_facts,
       round(avg(rule_count), 1)           AS avg_rules,
       max(injected_tokens_est)            AS max_injected_tokens
FROM attend_log
GROUP BY tenant_id, date_trunc('day', created_at)
ORDER BY day DESC;

-- 3. Suppression rate — tokens saved vs injected ("tokens saved this week").
--    suppressed = context-window dedup (Phase 1.2) + budget truncation (CORE-33).
CREATE OR REPLACE VIEW iranti_health_suppression AS
SELECT tenant_id,
       date_trunc('week', created_at)::date AS week,
       sum(injected_tokens_est)             AS injected_tokens,
       sum(suppressed_tokens_est)           AS suppressed_tokens,
       sum(already_present)                 AS facts_suppressed,
       CASE WHEN sum(injected_tokens_est + suppressed_tokens_est) > 0
            THEN round(100.0 * sum(suppressed_tokens_est)
                       / sum(injected_tokens_est + suppressed_tokens_est), 1)
            ELSE 0 END                       AS suppression_pct
FROM attend_log
GROUP BY tenant_id, date_trunc('week', created_at)
ORDER BY week DESC;

-- 4. Attend latency (avg / max / p95) per day.
CREATE OR REPLACE VIEW iranti_health_latency AS
SELECT tenant_id,
       date_trunc('day', created_at)::date AS day,
       count(*)                            AS attends,
       round(avg(latency_ms), 1)           AS avg_latency_ms,
       max(latency_ms)                     AS max_latency_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
FROM attend_log
GROUP BY tenant_id, date_trunc('day', created_at)
ORDER BY day DESC;

-- 5. Escalations by status (Phase 2b conflict resolution).
CREATE OR REPLACE VIEW iranti_health_escalations AS
SELECT tenant_id,
       status,
       count(*)        AS count,
       min(created_at) AS first_seen,
       max(created_at) AS last_seen
FROM escalations
GROUP BY tenant_id, status
ORDER BY tenant_id, status;

-- 6. Source-reliability distribution (Phase 2b / 2.5 confidence weighting).
CREATE OR REPLACE VIEW iranti_health_reliability AS
SELECT tenant_id,
       source,
       wins,
       losses,
       score,
       CASE WHEN score >= 0.8 THEN 'high'
            WHEN score >= 0.5 THEN 'medium'
            ELSE 'low' END AS band,
       updated_at
FROM source_reliability
ORDER BY score DESC;
