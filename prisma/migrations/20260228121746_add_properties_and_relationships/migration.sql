-- AlterTable
ALTER TABLE "archive" ADD COLUMN     "properties" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "knowledge_base" ADD COLUMN     "properties" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "EntityRelationship" (
    "id" SERIAL NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "relationshipType" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntityRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EntityRelationship_fromType_fromId_idx" ON "EntityRelationship"("fromType", "fromId");

-- CreateIndex
CREATE INDEX "EntityRelationship_toType_toId_idx" ON "EntityRelationship"("toType", "toId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityRelationship_fromType_fromId_relationshipType_toType__key" ON "EntityRelationship"("fromType", "fromId", "relationshipType", "toType", "toId");
