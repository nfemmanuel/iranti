-- CreateTable
CREATE TABLE "knowledge_base" (
    "id" SERIAL NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueRaw" JSONB NOT NULL,
    "valueSummary" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "source" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "conflictLog" JSONB NOT NULL DEFAULT '[]',
    "isProtected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "knowledge_base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive" (
    "id" SERIAL NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueRaw" JSONB NOT NULL,
    "valueSummary" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "conflictLog" JSONB NOT NULL DEFAULT '[]',
    "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedReason" TEXT NOT NULL,
    "supersededBy" INTEGER,

    CONSTRAINT "archive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_base_entityType_entityId_key_idx" ON "knowledge_base"("entityType", "entityId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_entityType_entityId_key_key" ON "knowledge_base"("entityType", "entityId", "key");

-- CreateIndex
CREATE INDEX "archive_entityType_entityId_key_idx" ON "archive"("entityType", "entityId", "key");
