// Media library — OD-4.
//
// DB read/write helpers over the media_objects table, following the same
// patterns as facts.ts. Reuses normalizeKey (AX-1 boundary rule) at every
// write/read path so media keys are addressed identically to fact keys.

import { and, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/connection.js";
import { mediaObjects, type MediaObject, type NewMediaObject } from "../db/schema.js";
import { normalizeKey } from "./keys.js";

// See facts.ts's projectFilter — same rationale.
function projectFilter(project: string | string[]) {
  const ids = Array.isArray(project) ? project : [project];
  return ids.length === 1
    ? eq(mediaObjects.project, ids[0]!)
    : inArray(mediaObjects.project, ids);
}

// Merge a patch into the existing metadata jsonb (top-level keys overwrite,
// everything else — sha256/bytes/rawKey provenance from ingestMedia — is
// preserved). Both vision write paths share this so the COALESCE/|| merge
// lives in exactly one place.
function mergeMetadataPatch(patch: Record<string, unknown>): SQL {
  return sql`COALESCE(${mediaObjects.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface WriteMediaInput {
  tenantId?: string;
  project?: string;
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
  const project = input.project ?? "default";
  const normalizedKey_ = normalizeKey(input.key);

  const [row] = await db
    .insert(mediaObjects)
    .values({
      tenantId,
      project,
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
      metadata: mergeMetadataPatch({ tags, visionStatus: "ok", visionModel }),
    })
    .where(eq(mediaObjects.id, id));
}

export async function markVisionFailed(id: string): Promise<void> {
  await db
    .update(mediaObjects)
    .set({
      metadata: mergeMetadataPatch({ visionStatus: "failed" }),
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
  project: string | string[] = "default",
): Promise<MediaObject[]> {
  return db
    .select()
    .from(mediaObjects)
    .where(
      and(
        eq(mediaObjects.tenantId, tenantId),
        projectFilter(project),
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
  project?: string | string[];
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
  const project = opts.project ?? "default";
  const limit = opts.limit ?? 10;
  const pattern = `%${query}%`;

  const filters = [
    eq(mediaObjects.tenantId, tenantId),
    projectFilter(project),
    or(
      ilike(mediaObjects.descriptionText, pattern),
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(${mediaObjects.metadata}->'tags', '[]'::jsonb)) AS tag WHERE tag ILIKE ${pattern})`,
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
