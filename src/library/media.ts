// Media library — OD-4.
//
// DB read/write helpers over the media_objects table, following the same
// patterns as facts.ts. Reuses normalizeKey (AX-1 boundary rule) at every
// write/read path so media keys are addressed identically to fact keys.

import { and, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { mediaObjects, type MediaObject, type NewMediaObject } from "../db/schema.js";
import { normalizeKey } from "./keys.js";

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface WriteMediaInput {
  tenantId?: string;
  entityType: string;
  entityId: string;
  key: string;
  objectUrl: string;
  mimeType: string;
  descriptionText?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function writeMediaObject(input: WriteMediaInput): Promise<MediaObject> {
  const tenantId = input.tenantId ?? "default";
  const normalizedKey_ = normalizeKey(input.key);

  const [row] = await db
    .insert(mediaObjects)
    .values({
      tenantId,
      entityType: input.entityType,
      entityId: input.entityId,
      key: normalizedKey_,
      objectUrl: input.objectUrl,
      mimeType: input.mimeType,
      descriptionText: input.descriptionText ?? null,
      metadata: input.metadata ?? null,
    } satisfies Omit<NewMediaObject, "id" | "createdAt">)
    .returning();

  return row!;
}

export async function updateMediaDescription(
  id: string,
  descriptionText: string,
  tags: string[],
  visionModel: string,
): Promise<void> {
  await db
    .update(mediaObjects)
    .set({
      descriptionText,
      metadata: {
        tags,
        visionStatus: "ok" as const,
        visionModel,
      },
    })
    .where(eq(mediaObjects.id, id));
}

export async function markVisionFailed(id: string): Promise<void> {
  await db
    .update(mediaObjects)
    .set({
      metadata: sql`COALESCE(${mediaObjects.metadata}, '{}'::jsonb) || '{"visionStatus":"failed"}'::jsonb`,
    })
    .where(eq(mediaObjects.id, id));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function readMediaByEntity(
  entityType: string,
  entityId: string,
  tenantId = "default",
): Promise<MediaObject[]> {
  return db
    .select()
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.tenantId, tenantId),
        eq(mediaObjects.entityType, entityType),
        eq(mediaObjects.entityId, entityId),
      ),
    )
    .orderBy(mediaObjects.createdAt);
}

// ---------------------------------------------------------------------------
// Search — keyword over description_text and metadata.tags
// ---------------------------------------------------------------------------

export interface SearchMediaOpts {
  entityType?: string;
  entityId?: string;
  tenantId?: string;
  limit?: number;
}

export interface MediaSearchHit {
  id: string;
  entity: string;
  key: string;
  description: string | null;
  mime: string;
  objectUrl: string;
  tags: string[];
}

export async function searchMedia(
  query: string,
  opts: SearchMediaOpts = {},
): Promise<MediaSearchHit[]> {
  const tenantId = opts.tenantId ?? "default";
  const limit = opts.limit ?? 10;
  const pattern = `%${query}%`;

  const filters = [
    eq(mediaObjects.tenantId, tenantId),
    or(
      ilike(mediaObjects.descriptionText, pattern),
      // tags are stored as metadata.tags — cast to text for ilike
      ilike(mediaObjects.key, pattern),
    ),
  ];

  if (opts.entityType) filters.push(eq(mediaObjects.entityType, opts.entityType));
  if (opts.entityId) filters.push(eq(mediaObjects.entityId, opts.entityId));

  const rows = await db
    .select()
    .from(mediaObjects)
    .where(and(...filters))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    entity: `${r.entityType}/${r.entityId}`,
    key: r.key,
    description: r.descriptionText ?? null,
    mime: r.mimeType,
    objectUrl: r.objectUrl,
    tags: extractTags(r.metadata),
  }));
}

function extractTags(metadata: unknown): string[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const m = metadata as Record<string, unknown>;
  if (!Array.isArray(m["tags"])) return [];
  return (m["tags"] as unknown[]).filter((t): t is string => typeof t === "string");
}
