// Graph backend — Phase 2a
//
// The graph substrate for iranti's learned relevance index. Edges connect
// facts, rules, and entities that have appeared together in memory retrievals.
//
// Two relations are used in Phase 2a:
//
//   co_access — facts retrieved together in the same iranti_attend. Weight
//               accumulates over time: high weight = "historically useful
//               together." Stored with canonical pair ordering so (A,B) and
//               (B,A) are a single row.
//
//   governs   — directed edge rule→fact created when a rule and a fact are
//               injected together in an attend. Groundwork for graph-proximity
//               rule triggering in Phase 3.
//
// All edge writes are best-effort. A failed edge insert never breaks core
// memory operations — the graph is an enhancement, not a blocker.
//
// Phase 3 is where the graph is consumed in retrieval (two-pass: entity+keyword
// primary, graph-hop secondary). Phase 4 adds edge decay. Phase 2a only
// accumulates signal.

import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  knowledgeEdges,
  type KnowledgeEdge,
} from "../db/schema.js";

// Drizzle's relational query builder (db.query.*) can drop complex or()
// conditions inside where(). All queries here use the standard query
// builder (db.select().from().where()) so the WHERE clause is always
// compiled exactly as written.


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

    // Canonicalize co_access so addEdge and getEdge agree on the row key.
    const [src, tgt] =
      edge.relation === "co_access"
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
        coAccessCount: edge.relation === "co_access" ? 1 : 0,
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
    // Canonicalize co_access so (A,B) and (B,A) are the same row.
    // governs edges are directed (rule→fact) — preserve direction.
    const [src, tgt] = relation === "co_access" ? canonicalize(a, b) : [a, b];

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
        coAccessCount: relation === "co_access" ? 1 : 0,
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
          coAccessCount:
            relation === "co_access"
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

      const rows = await db.execute<Row>(sql`
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

      return rows.map((r) => ({
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

    const rows = await db.execute<RawEdgeRow>(sql`
      WITH RECURSIVE traversal AS (
        SELECT e.id, e.tenant_id, e.source_type, e.source_id,
               e.target_type, e.target_id, e.relation, e.weight,
               e.co_access_count, e.created_at, e.last_reinforced_at,
               1 AS depth
        FROM knowledge_edges e
        WHERE e.tenant_id = ${tenantId}
          AND e.weight >= ${minWeight}
          AND (
            (e.source_type = ${node.type} AND e.source_id = ${node.id})
            OR (e.target_type = ${node.type} AND e.target_id = ${node.id})
          )

        UNION

        SELECT e.id, e.tenant_id, e.source_type, e.source_id,
               e.target_type, e.target_id, e.relation, e.weight,
               e.co_access_count, e.created_at, e.last_reinforced_at,
               t.depth + 1
        FROM knowledge_edges e
        INNER JOIN traversal t ON (
          (e.source_type = t.target_type AND e.source_id = t.target_id)
          OR (e.target_type = t.source_type AND e.target_id = t.source_id)
        )
        WHERE t.depth < ${depth}
          AND e.tenant_id = ${tenantId}
          AND e.weight >= ${minWeight}
      )
      SELECT DISTINCT ON (id) id, tenant_id, source_type, source_id,
             target_type, target_id, relation, weight, co_access_count,
             created_at, last_reinforced_at
      FROM traversal
      ORDER BY id
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
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
    // Canonicalize co_access lookups so (A,B) and (B,A) find the same row.
    const [src, tgt] = relation === "co_access" ? canonicalize(a, b) : [a, b];

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
