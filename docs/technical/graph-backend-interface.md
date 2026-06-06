# Graph backend interface

**Status:** template  
**Needed by:** Phase 0  
**[Back to map](../MAP.md)**

---

> This interface must be fully designed before Phase 2 implementation begins. The Librarian and Attendant call only this interface — they are never aware of which implementation is active.

## Purpose

Define the TypeScript interface that both the PostgreSQL graph backend and the Apache AGE graph backend must satisfy. The interface is the contract. Any implementation that satisfies it can be swapped in via config change.

## Design principles

- The interface should be minimal — only operations the Librarian and Attendant actually need
- Every method must be possible in both PostgreSQL (CTEs) and Apache AGE (Cypher) — if a method cannot be implemented identically in both, it does not belong in the interface
- Errors are typed and specific — no generic database errors surface through the interface
- All operations are async

## Interface methods (draft)

```typescript
interface GraphBackend {
  // Vertex operations
  createVertex(factId: string, metadata: VertexMetadata): Promise<void>
  archiveVertex(factId: string): Promise<void>

  // Edge operations
  createEdge(
    fromFactId: string,
    toFactId: string,
    type: RelationshipType,
    initialConfidence: number
  ): Promise<void>
  updateEdgeConfidence(edgeId: string, delta: number): Promise<void>

  // Traversal
  traverse(
    startingFactIds: string[],
    maxDepth: number,
    minEdgeConfidence?: number
  ): Promise<TraversalResult[]>

  // Query
  getEdgesByEntity(entityType: string, entityId: string): Promise<Edge[]>
  getNeighbours(factId: string, depth?: number): Promise<string[]>
}
```

## Types to define

```typescript
type RelationshipType =
  | 'temporal_cooccurrence'
  | 'entity_overlap'
  | 'semantic_similarity'

interface VertexMetadata {
  entityType: string
  entityId: string
  key: string
  sessionId: string
}

interface TraversalResult {
  factId: string
  depth: number
  pathConfidence: number  // product of edge confidences along the path
}

interface Edge {
  id: string
  fromFactId: string
  toFactId: string
  type: RelationshipType
  confidence: number
  createdAt: Date
  lastReinforcedAt: Date
}
```

## Implementation notes

_Fill in when designing both implementations (Phase 0 for interface, Phase 2 for PostgreSQL, parallel for AGE):_

### PostgreSQL implementation

The PostgreSQL implementation uses recursive CTEs on the `relationships` table. Traversal is a recursive CTE that walks the graph from the starting nodes. Edge confidence is updated directly on the relationships table.

_Document the CTE structure and any performance considerations._

### Apache AGE implementation

Apache AGE adds native graph capabilities to PostgreSQL using the Cypher query language. The AGE implementation must satisfy exactly the same interface but uses Cypher for traversal and vertex/edge management.

_Document the Cypher equivalents of each interface method._

## Switching implementations

Switching from PostgreSQL to AGE requires:
1. A config change (`GRAPH_BACKEND=age`)
2. A migration that creates AGE graph structures from the existing relationships table
3. No changes to Librarian or Attendant code

_Document the migration procedure here._

## Related specs

- [Knowledge graph](../specs/memory-storage/knowledge-graph.md) — the graph this interface serves
- [Graph backend abstraction](../specs/integration/graph-backend-abstraction.md) — integration feature spec
- [Graph traversal retrieval](../specs/retrieval/graph-traversal-retrieval.md) — uses traversal()
- [Hebbian reinforcement](../specs/lifecycle/hebbian-reinforcement.md) — uses updateEdgeConfidence()
