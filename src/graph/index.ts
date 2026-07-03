// Graph backend — Phase 2a
//
// The graph substrate for iranti's learned relevance index. Edges connect
// facts, rules, and entities that have appeared together in memory retrievals.
//
// Relations in use:
//
//   co_access — facts retrieved together in the same iranti_attend. Weight
//               accumulates over time. Canonical pair ordering so (A,B) and
//               (B,A) are a single row.
//
//   governs   — directed edge rule→fact from attend co-fire. Groundwork for
//               graph-proximity rule triggering in Phase 3.
//
//   co_write  — Phase 2.5 (CORE-29). Facts written in the same session.
//               Weight 0.5 (weaker than co_access). Canonical ordering.
//
//   about     — Phase 2.5 (CORE-29). Directed fact→entity hub edge.
//               No canonical ordering (asymmetric by type).
//
// All edge writes are best-effort. A failed edge insert never breaks core
// memory operations — the graph is an enhancement, not a blocker.
//
// Phase 3 is where the graph is consumed in retrieval (two-pass: entity+keyword
// primary, graph-hop secondary). Phase 4 adds edge decay. Phase 2a only
// accumulates signal.

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  knowledgeEdges,
  type KnowledgeEdge,
} from "../db/schema.js";

// Drizzle's relational query builder (db.query.*) can drop complex or()
// conditions inside where(). All queries here use the standard query
// builder (db.select().from().where()) so the WHERE clause is always
// compiled exactly as written.

// db.execute()'s return shape differs by engine: postgres-js resolves an
// array-like RowList<T[]> (has .map directly); PGlite resolves a
// Results<T> object (`{ rows: T[], fields, affectedRows }`). Since `db` is
// now a union of both engines (Layer 0 engine switch), normalize to a plain
// row array here rather than at every call site.
function rowsOf<T>(result: T[] | { rows: T[] }): T[] {
  return Array.isArray(result) ? result : result.rows;
}


export type { KnowledgeEdge };

// A typed reference to a node in the graph.
export interface GraphNode {
  type: string; // 'fact' | 'rule' | 'entity'
  id: string;
}

export interface GetNeighborsOpts {
  depth?: number;    // how many hops to traverse; default 1
  minWeight?: number; // minimum edge weight to include; default 0
  limit?: number;    // maximum edges to return; default 20
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface GraphBackend {
  // Insert or upsert an edge. On conflict, increments weight + coAccessCount.
  addEdge(edge: {
    tenantId?: string;
    sourceType: string;
    sourceId: string;
    targetType: string;
    targetId: string;
    relation: string;
    weight?: number;
  }): Promise<KnowledgeEdge>;

  // Strengthen an existing edge (or create it if absent).
  // co_access edges are automatically canonicalized (smaller key first).
  // governs edges preserve direction (source = rule, target = fact).
  reinforceEdge(
    a: GraphNode,
    b: GraphNode,
    relation: string,
    delta?: number,
    tenantId?: string,
  ): Promise<void>;

  // Return neighbours of a node. Depth 1 uses a simple query; depth > 1
  // uses a recursive CTE so the same interface works for multi-hop traversal
  // in Phase 3 without changing call sites.
  getNeighbors(
    node: GraphNode,
    opts?: GetNeighborsOpts,
    tenantId?: string,
  ): Promise<KnowledgeEdge[]>;

  // Return the single edge between two nodes for a given relation, or
  // undefined if it does not exist.
  getEdge(
    a: GraphNode,
    b: GraphNode,
    relation: string,
    tenantId?: string,
  ): Promise<KnowledgeEdge | undefined>;
}

// ---------------------------------------------------------------------------
// Canonical pair ordering
// ---------------------------------------------------------------------------

// Ensure (A, B) and (B, A) collapse to the same row for undirected edges.
// Compares lexicographically on "type/id" so the ordering is deterministic.
function canonicalize(a: GraphNode, b: GraphNode): [GraphNode, GraphNode] {
  const aKey = `${a.type}/${a.id}`;
  const bKey = `${b.type}/${b.id}`;
  return aKey <= bKey ? [a, b] : [b, a];
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation
// ---------------------------------------------------------------------------

export class PostgresGraphBackend implements GraphBackend {
  async addEdge(edge: {
    tenantId?: string;
    sourceType: string;
    sourceId: string;
    targetType: string;
    targetId: string;
    relation: string;
    weight?: number;
  }): Promise<KnowledgeEdge> {
    const tenantId = edge.tenantId ?? "default";
    const w = edge.weight ?? 1;

    // Canonicalize undirected relations so addEdge and getEdge agree on the row key.
    const undirected = edge.relation === "co_access" || edge.relation === "co_write";
    const [src, tgt] = undirected
      ? canonicalize({ type: edge.sourceType, id: edge.sourceId }, { type: edge.targetType, id: edge.targetId })
      : [{ type: edge.sourceType, id: edge.sourceId }, { type: edge.targetType, id: edge.targetId }];

    const [result] = await db
      .insert(knowledgeEdges)
      .values({
        tenantId,
        sourceType: src.type,
        sourceId: src.id,
        targetType: tgt.type,
        targetId: tgt.id,
        relation: edge.relation,
        weight: w,
        coAccessCount: undirected ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [
          knowledgeEdges.tenantId,
          knowledgeEdges.sourceType,
          knowledgeEdges.sourceId,
          knowledgeEdges.targetType,
          knowledgeEdges.targetId,
          knowledgeEdges.relation,
        ],
        set: {
          weight: sql`${knowledgeEdges.weight} + ${w}`,
          coAccessCount:
            edge.relation === "co_access"
              ? sql`${knowledgeEdges.coAccessCount} + 1`
              : knowledgeEdges.coAccessCount,
          lastReinforcedAt: new Date(),
        },
      })
      .returning();

    return result!;
  }

  async reinforceEdge(
    a: GraphNode,
    b: GraphNode,
    relation: string,
    delta = 1,
    tenantId = "default",
  ): Promise<void> {
    // Canonicalize undirected relations so (A,B) and (B,A) are the same row.
    // governs and about edges are directed — preserve their direction.
    const isUndirected = relation === "co_access" || relation === "co_write";
    const [src, tgt] = isUndirected ? canonicalize(a, b) : [a, b];

    await db
      .insert(knowledgeEdges)
      .values({
        tenantId,
        sourceType: src.type,
        sourceId: src.id,
        targetType: tgt.type,
        targetId: tgt.id,
        relation,
        weight: delta,
        coAccessCount: isUndirected ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [
          knowledgeEdges.tenantId,
          knowledgeEdges.sourceType,
          knowledgeEdges.sourceId,
          knowledgeEdges.targetType,
          knowledgeEdges.targetId,
          knowledgeEdges.relation,
        ],
        set: {
          weight: sql`${knowledgeEdges.weight} + ${delta}`,
          coAccessCount: isUndirected
            ? sql`${knowledgeEdges.coAccessCount} + 1`
            : knowledgeEdges.coAccessCount,
          lastReinforcedAt: new Date(),
        },
      });
  }

  async getNeighbors(
    node: GraphNode,
    opts: GetNeighborsOpts = {},
    tenantId = "default",
  ): Promise<KnowledgeEdge[]> {
    const { depth = 1, minWeight = 0, limit = 20 } = opts;

    if (depth <= 1) {
      // Use raw SQL to guarantee the OR condition is not dropped.
      // Drizzle's relational and standard query builders can silently discard
      // or() expressions with nested and() in some versions; raw SQL is the
      // safest path for a compound OR condition.
      type Row = {
        id: string;
        tenant_id: string;
        source_type: string;
        source_id: string;
        target_type: string;
        target_id: string;
        relation: string;
        weight: string | number;
        co_access_count: string | number;
        created_at: Date | string;
        last_reinforced_at: Date | string;
      };

      const result = await db.execute<Row>(sql`
        SELECT id, tenant_id, source_type, source_id, target_type, target_id,
               relation, weight, co_access_count, created_at, last_reinforced_at
        FROM knowledge_edges
        WHERE tenant_id = ${tenantId}
          AND weight >= ${minWeight}
          AND (
            (source_type = ${node.type} AND source_id = ${node.id})
            OR
            (target_type = ${node.type} AND target_id = ${node.id})
          )
        ORDER BY weight DESC
        LIMIT ${limit}
      `);

      return rowsOf(result).map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        sourceType: r.source_type,
        sourceId: r.source_id,
        targetType: r.target_type,
        targetId: r.target_id,
        relation: r.relation,
        weight: Number(r.weight),
        coAccessCount: Number(r.co_access_count),
        createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
        lastReinforcedAt:
          r.last_reinforced_at instanceof Date
            ? r.last_reinforced_at
            : new Date(r.last_reinforced_at),
      }));
    }

    // Recursive CTE for depth > 1. Phase 3 retrieval calls this to follow
    // strong edges from entity-scoped facts to historically related facts.
    type RawEdgeRow = {
      id: string;
      tenant_id: string;
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
      relation: string;
      weight: string | number;
      co_access_count: string | number;
      created_at: Date | string;
      last_reinforced_at: Date | string;
    };

    // frontier_type/frontier_id = the far end of each edge (the node to expand
    // from next). The prior bug used t.source_type/id in the recursive JOIN,
    // which walked BACK toward the origin instead of forward — second OR branch
    // matched edges ending at t.source (already visited). Fix: carry the far
    // end explicitly and JOIN on frontier_* in the recursive term.
    // Second bug: DISTINCT ON (id) ORDER BY id LIMIT applied the cap before
    // weight ordering. Fix: dedup in a subquery, then ORDER BY weight DESC LIMIT.
    const result = await db.execute<RawEdgeRow>(sql`
      WITH RECURSIVE traversal AS (
        -- Depth 1: direct edges from the origin node.
        -- frontier_type/id tracks the far end to expand from next hop.
        SELECT e.id, e.tenant_id, e.source_type, e.source_id,
               e.target_type, e.target_id, e.relation, e.weight,
               e.co_access_count, e.created_at, e.last_reinforced_at,
               1 AS depth,
               CASE WHEN e.source_type = ${node.type} AND e.source_id = ${node.id}
                    THEN e.target_type ELSE e.source_type END AS frontier_type,
               CASE WHEN e.source_type = ${node.type} AND e.source_id = ${node.id}
                    THEN e.target_id   ELSE e.source_id   END AS frontier_id
        FROM knowledge_edges e
        WHERE e.tenant_id = ${tenantId}
          AND e.weight >= ${minWeight}
          AND (
            (e.source_type = ${node.type} AND e.source_id = ${node.id})
            OR (e.target_type = ${node.type} AND e.target_id = ${node.id})
          )

        UNION

        -- Depth N+1: edges from the frontier of the previous depth.
        -- JOIN on t.frontier_* (the far end), not t.source_* (the origin side).
        SELECT e.id, e.tenant_id, e.source_type, e.source_id,
               e.target_type, e.target_id, e.relation, e.weight,
               e.co_access_count, e.created_at, e.last_reinforced_at,
               t.depth + 1,
               CASE WHEN e.source_type = t.frontier_type AND e.source_id = t.frontier_id
                    THEN e.target_type ELSE e.source_type END AS frontier_type,
               CASE WHEN e.source_type = t.frontier_type AND e.source_id = t.frontier_id
                    THEN e.target_id   ELSE e.source_id   END AS frontier_id
        FROM knowledge_edges e
        INNER JOIN traversal t ON (
          (e.source_type = t.frontier_type AND e.source_id = t.frontier_id)
          OR (e.target_type = t.frontier_type AND e.target_id = t.frontier_id)
        )
        WHERE t.depth < ${depth}
          AND e.tenant_id = ${tenantId}
          AND e.weight >= ${minWeight}
      )
      SELECT id, tenant_id, source_type, source_id,
             target_type, target_id, relation, weight, co_access_count,
             created_at, last_reinforced_at
      FROM (
        SELECT DISTINCT ON (id)
               id, tenant_id, source_type, source_id,
               target_type, target_id, relation, weight, co_access_count,
               created_at, last_reinforced_at
        FROM traversal
        ORDER BY id
      ) deduped
      ORDER BY weight DESC
      LIMIT ${limit}
    `);

    return rowsOf(result).map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      targetType: r.target_type,
      targetId: r.target_id,
      relation: r.relation,
      weight: Number(r.weight),
      coAccessCount: Number(r.co_access_count),
      createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
      lastReinforcedAt:
        r.last_reinforced_at instanceof Date
          ? r.last_reinforced_at
          : new Date(r.last_reinforced_at),
    }));
  }

  async getEdge(
    a: GraphNode,
    b: GraphNode,
    relation: string,
    tenantId = "default",
  ): Promise<KnowledgeEdge | undefined> {
    // Canonicalize undirected relations so (A,B) and (B,A) find the same row.
    const [src, tgt] =
      relation === "co_access" || relation === "co_write" ? canonicalize(a, b) : [a, b];

    const rows = await db
      .select()
      .from(knowledgeEdges)
      .where(
        and(
          eq(knowledgeEdges.tenantId, tenantId),
          eq(knowledgeEdges.sourceType, src.type),
          eq(knowledgeEdges.sourceId, src.id),
          eq(knowledgeEdges.targetType, tgt.type),
          eq(knowledgeEdges.targetId, tgt.id),
          eq(knowledgeEdges.relation, relation),
        ),
      )
      .limit(1);

    return rows[0];
  }
}

// Singleton — import this everywhere instead of instantiating directly.
// Swap out for a different backend by reassigning or providing via DI.
export const graph: GraphBackend = new PostgresGraphBackend();
