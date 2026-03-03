-- CreateTable
CREATE TABLE "entities" (
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("entityType","entityId")
);

-- CreateTable
CREATE TABLE "entity_aliases" (
    "id" SERIAL NOT NULL,
    "entityType" TEXT NOT NULL,
    "aliasNorm" TEXT NOT NULL,
    "rawAlias" TEXT NOT NULL,
    "canonicalEntityType" TEXT NOT NULL,
    "canonicalEntityId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entity_aliases_canonicalEntityType_canonicalEntityId_idx" ON "entity_aliases"("canonicalEntityType", "canonicalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "entity_aliases_entityType_aliasNorm_key" ON "entity_aliases"("entityType", "aliasNorm");

-- AddForeignKey
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_canonicalEntityType_canonicalEntityId_fkey" FOREIGN KEY ("canonicalEntityType", "canonicalEntityId") REFERENCES "entities"("entityType", "entityId") ON DELETE CASCADE ON UPDATE CASCADE;
