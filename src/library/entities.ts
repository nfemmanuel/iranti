// Entity management — Phase 0
//
// An entity is the thing a fact is about: project/my-app, user/alice,
// system/global. Entities are the namespace for facts — you can only
// retrieve facts by entity.
//
// Entities are created on first use via upsert. You never need to create
// an entity explicitly before writing facts about it.

import { and, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { entities, type Entity } from "../db/schema.js";

// Get or create an entity. Returns the existing entity if it already exists,
// or creates and returns a new one.
//
// This is the primary way to interact with entities. Rather than checking
// existence and then inserting separately, we do it in one atomic operation.
export async function upsertEntity(
  entityType: string,
  entityId: string,
  label?: string,
): Promise<Entity> {
  const [entity] = await db
    .insert(entities)
    .values({ entityType, entityId, label })
    .onConflictDoUpdate({
      // On conflict, update the label if a new one was provided.
      // Leave everything else unchanged.
      target: [entities.entityType, entities.entityId],
      set: { label: label ?? entities.label },
    })
    .returning();

  return entity!;
}

// Look up an entity by type and ID. Returns undefined if not found.
export async function getEntity(
  entityType: string,
  entityId: string,
): Promise<Entity | undefined> {
  return db.query.entities.findFirst({
    where: and(
      eq(entities.entityType, entityType),
      eq(entities.entityId, entityId),
    ),
  });
}
