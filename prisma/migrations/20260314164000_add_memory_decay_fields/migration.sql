ALTER TABLE "knowledge_base"
ADD COLUMN "lastAccessedAt" TIMESTAMP(3),
ADD COLUMN "stability" DOUBLE PRECISION;

UPDATE "knowledge_base"
SET
    "lastAccessedAt" = COALESCE("updatedAt", "createdAt", NOW()),
    "stability" = 30,
    "properties" = CASE
        WHEN "properties" IS NULL THEN jsonb_build_object('originalConfidence', "confidence")
        WHEN NOT ("properties"::jsonb ? 'originalConfidence') THEN "properties"::jsonb || jsonb_build_object('originalConfidence', "confidence")
        ELSE "properties"
    END
WHERE "lastAccessedAt" IS NULL
   OR "stability" IS NULL
   OR "properties" IS NULL
   OR NOT ("properties"::jsonb ? 'originalConfidence');

ALTER TABLE "knowledge_base"
ALTER COLUMN "lastAccessedAt" SET NOT NULL,
ALTER COLUMN "lastAccessedAt" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "stability" SET NOT NULL,
ALTER COLUMN "stability" SET DEFAULT 30;
