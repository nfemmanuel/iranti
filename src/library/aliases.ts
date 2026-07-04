// Entity alias resolution — Layer 0c (the "textbook" fix).
//
// An alias is a durable link from a nickname phrase ("the figma file") to
// the fact it resolves to (identified by entityType/entityId/factKey). It is
// learned ONCE from an explicit declarative signal in a message — see
// src/extract/index.ts's ALIAS_PATTERNS — and applied at every retrieval
// thereafter via EXACT, deterministic stored-alias lookup. Never fuzzy or
// embedding-based (G1 determinism, see the PRD).
//
// factKey (not factId) is the stored pointer: resolving to "the live fact
// for this entity+key" means an alias survives its target fact being
// superseded (a new value written to the same key) without needing to be
// re-learned — the same durable-identity treatment iranti gives everywhere
// else to (entityType, entityId, key).
//
// Project-scoped exactly like facts.ts/rules.ts (Layer 0, D6/D7): an alias
// learned in project A must not resolve in project B — see projectFilter
// below, identical in shape and rationale to facts.ts's.
//
// Never hard-deleted (G1): archiveAlias() sets isActive = false. There is no
// delete path, matching rules.deactivateRule / facts.archiveFact exactly.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { entityAliases, type EntityAlias, type NewEntityAlias } from "../db/schema.js";
import { normalizeKey } from "./keys.js";
import { normalizeProjectId } from "./projects.js";

// ---------------------------------------------------------------------------
// Project scoping (Layer 0, D6/D7) — see facts.ts's projectFilter for the
// full rationale. Same shape: a single-element set degenerates to a plain
// equality; every id is normalized so a caller-supplied path always lands on
// the same scope a normalized read will later look for.
// ---------------------------------------------------------------------------
function projectFilter(project: string | string[]) {
  const ids = Array.isArray(project) ? project : [project];
  const normalized = ids.map(normalizeProjectId);
  return normalized.length === 1
    ? eq(entityAliases.project, normalized[0]!)
    : inArray(entityAliases.project, normalized);
}

// Normalize an alias phrase for storage/lookup: lowercase, collapse
// whitespace, trim. Distinct from normalizeKey (which targets fact-key
// syntax — kebab-case with a category prefix) because an alias is free-form
// prose ("the figma file"), not a structured key.
export function normalizeAlias(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// Learn (or re-learn) an alias. Upserts on (tenantId, project, entityType,
// entityId, normalizedAlias) — re-learning the SAME alias text for the same
// entity updates the target factKey/rawAlias/source/confidence and
// reactivates it if it had been archived, rather than creating a duplicate
// row. This mirrors writeFact's upsert posture.
export async function learnAlias(
  input: Pick<
    NewEntityAlias,
    "entityType" | "entityId" | "rawAlias" | "factKey" | "source" | "tenantId" | "project"
  > & { confidence?: number },
): Promise<EntityAlias> {
  const tenantId = input.tenantId ?? "default";
  const project = normalizeProjectId(input.project ?? "default");
  const alias = normalizeAlias(input.rawAlias);

  if (!alias) {
    throw new Error("Alias text normalizes to an empty string and cannot be stored.");
  }

  const factKey = normalizeKey(input.factKey);

  const [row] = await db
    .insert(entityAliases)
    .values({
      tenantId,
      project,
      entityType: input.entityType,
      entityId: input.entityId,
      alias,
      rawAlias: input.rawAlias,
      factKey,
      source: input.source,
      confidence: input.confidence ?? 0.85,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [
        entityAliases.tenantId,
        entityAliases.project,
        entityAliases.entityType,
        entityAliases.entityId,
        entityAliases.alias,
      ],
      set: {
        rawAlias: input.rawAlias,
        factKey,
        source: input.source,
        confidence: input.confidence ?? 0.85,
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();

  return row!;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Resolve a message against an entity's known active aliases. Returns the
// FULL matched alias row (not just the target factKey) so callers can also
// use the alias's own normalized phrase — e.g. mcp/tools/attend.ts's read
// path synthesizes a retrievable "alias:<slug>" key from it, matching how
// the Layer 0b bench corpus's gold facts model an alias (a distinct
// key/value pair alongside the artifact it names, both holding the same
// value — see docs/prds/phases/layer-0c-entity-resolution.md's bench
// verification). Exact substring lookup only — no fuzzy/similarity scoring
// (G1).
//
// When multiple aliases match, the longest alias phrase wins (most specific
// match) — deterministic given a fixed alias set, and avoids a short alias
// ("the doc") shadowing a more specific one ("the reconciliation doc") that
// also matches the same message.
export async function resolveAlias(
  entityType: string,
  entityId: string,
  message: string,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<EntityAlias | undefined> {
  if (!message) return undefined;
  const normalizedMessage = normalizeAlias(message);
  if (!normalizedMessage) return undefined;

  const candidates = await db.query.entityAliases.findMany({
    where: and(
      eq(entityAliases.tenantId, tenantId),
      projectFilter(project),
      eq(entityAliases.entityType, entityType),
      eq(entityAliases.entityId, entityId),
      eq(entityAliases.isActive, true),
    ),
  });

  // Deterministic candidate order BEFORE matching (review finding: the DB
  // query has no ORDER BY, so equal-length ties would otherwise fall to
  // physical row order — not guaranteed stable across engines or after a
  // vacuum). Longest alias first (most specific), then oldest, then id.
  const ordered = [...candidates].sort(
    (a, b) =>
      b.alias.length - a.alias.length ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  for (const candidate of ordered) {
    if (matchesWholePhrase(normalizedMessage, candidate.alias)) return candidate;
  }
  return undefined;
}

// Whole-phrase containment: the alias must appear bounded by non-word
// characters (or string edges), not merely as a raw substring — a plain
// .includes() would let alias "the doc" fire inside "where is the docker
// file?" (review finding). Still exact/deterministic per G1: no fuzziness,
// just a boundary rule on both ends of the stored phrase.
function matchesWholePhrase(message: string, alias: string): boolean {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    "u",
  ).test(message);
}

// List every alias (active and archived) for an entity — correctability/audit.
export async function listAliasesForEntity(
  entityType: string,
  entityId: string,
  tenantId: string = "default",
  project: string | string[] = "default",
): Promise<EntityAlias[]> {
  return db.query.entityAliases.findMany({
    where: and(
      eq(entityAliases.tenantId, tenantId),
      projectFilter(project),
      eq(entityAliases.entityType, entityType),
      eq(entityAliases.entityId, entityId),
    ),
    orderBy: desc(entityAliases.createdAt),
  });
}

// Layer 0h: list aliases across ALL entities in a project scope — the audit
// surface behind iranti_aliases_list. Active-only by default; a host
// auditing its learned vocabulary doesn't know which entities carry it.
export async function listAliasesForProject(
  tenantId: string = "default",
  project: string | string[] = "default",
  includeInactive = false,
): Promise<EntityAlias[]> {
  const conditions = [eq(entityAliases.tenantId, tenantId), projectFilter(project)];
  if (!includeInactive) conditions.push(eq(entityAliases.isActive, true));
  return db.query.entityAliases.findMany({
    where: and(...conditions),
    orderBy: desc(entityAliases.createdAt),
  });
}

// ---------------------------------------------------------------------------
// Archive (G1 — never a hard delete)
// ---------------------------------------------------------------------------

// Deactivate an alias. It will no longer be applied by resolveAlias. The
// record is kept — matches rules.deactivateRule / facts.archiveFact.
//
// `project`: the caller's effective project scope. When provided, an alias
// belonging to another project is treated exactly like a nonexistent one
// (returns false) — same indistinguishable-from-missing posture as
// archiveFact, so cross-project ids can't be probed for existence.
export async function archiveAlias(
  id: string,
  project?: string | string[],
): Promise<boolean> {
  const existing = await db.query.entityAliases.findFirst({
    where: eq(entityAliases.id, id),
  });
  if (!existing || !existing.isActive) return false;

  if (project !== undefined) {
    const allowed = (Array.isArray(project) ? project : [project]).map(normalizeProjectId);
    if (!allowed.includes(existing.project)) return false;
  }

  await db
    .update(entityAliases)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(entityAliases.id, id));
  return true;
}
