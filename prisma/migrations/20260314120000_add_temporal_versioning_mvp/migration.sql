CREATE TYPE "ArchivedReason" AS ENUM (
    'segment_closed',
    'superseded',
    'contradicted',
    'escalated',
    'expired',
    'duplicate'
);

CREATE TYPE "ResolutionState" AS ENUM (
    'not_applicable',
    'pending',
    'resolved'
);

CREATE TYPE "ResolutionOutcome" AS ENUM (
    'not_applicable',
    'challenger_won',
    'original_retained'
);

ALTER TABLE "knowledge_base"
ADD COLUMN "validFrom" TIMESTAMP(3);

UPDATE "knowledge_base"
SET "validFrom" = COALESCE("createdAt", NOW())
WHERE "validFrom" IS NULL;

ALTER TABLE "knowledge_base"
ALTER COLUMN "validFrom" SET NOT NULL,
ALTER COLUMN "validFrom" SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "archive"
ADD COLUMN "validFrom" TIMESTAMP(3),
ADD COLUMN "resolutionState" "ResolutionState" NOT NULL DEFAULT 'not_applicable',
ADD COLUMN "resolutionOutcome" "ResolutionOutcome" NOT NULL DEFAULT 'not_applicable';

UPDATE "archive"
SET "validFrom" = COALESCE("createdAt", "archivedAt", NOW())
WHERE "validFrom" IS NULL;

ALTER TABLE "archive"
ALTER COLUMN "validFrom" SET NOT NULL;

ALTER TABLE "archive"
ALTER COLUMN "archivedReason" TYPE "ArchivedReason"
USING "archivedReason"::"ArchivedReason";

CREATE INDEX "archive_entityType_entityId_key_validFrom_idx"
ON "archive"("entityType", "entityId", "key", "validFrom");

CREATE INDEX "archive_entityType_entityId_key_validFrom_validUntil_idx"
ON "archive"("entityType", "entityId", "key", "validFrom", "validUntil");

CREATE INDEX "idx_archive_history_non_expired"
ON "archive"("entityType", "entityId", "key", "validFrom")
WHERE "archivedReason" IN ('segment_closed', 'superseded', 'contradicted', 'escalated');

CREATE INDEX "idx_archive_pending_escalations"
ON "archive"("entityType", "entityId", "key", "validFrom")
WHERE "archivedReason" = 'escalated' AND "resolutionState" = 'pending';
