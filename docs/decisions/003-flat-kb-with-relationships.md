# ADR 003: Flat Key-Value KB with Separate Relationships Table

**Status:** Accepted

**Date:** 2024-01-13

**Deciders:** Core team

---

## Context

We need to design the knowledge base schema. The core question: how do we store facts about entities?

**Requirements:**
1. Store atomic facts about entities
2. Support arbitrary entity types (not hardcoded)
3. Support arbitrary fact keys (not hardcoded)
4. Support relationships between entities
5. Query efficiently
6. Never lose data (full provenance)
7. Support caller-defined metadata

**Options:**
1. **Flat key-value** — One row per fact
2. **Document store** — One document per entity
3. **Graph database** — Nodes and edges
4. **EAV (Entity-Attribute-Value)** — Generic triple store
5. **Hybrid** — Flat key-value + separate relationships table

---

## Decision

We will use a **flat key-value knowledge base** with a **separate relationships table**.

**Schema:**

```sql
-- Active truth
CREATE TABLE knowledge_base (
    id SERIAL PRIMARY KEY,
    entityType VARCHAR NOT NULL,
    entityId VARCHAR NOT NULL,
    key VARCHAR NOT NULL,
    valueRaw JSONB NOT NULL,
    valueSummary TEXT NOT NULL,
    confidence INT NOT NULL,
    source VARCHAR NOT NULL,
    validUntil TIMESTAMP,
    createdBy VARCHAR NOT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT NOW(),
    updatedAt TIMESTAMP NOT NULL DEFAULT NOW(),
    conflictLog JSONB NOT NULL DEFAULT '[]',
    isProtected BOOLEAN NOT NULL DEFAULT FALSE,
    properties JSONB NOT NULL DEFAULT '{}',
    UNIQUE(entityType, entityId, key)
);

-- Full provenance
CREATE TABLE archive (
    -- Same columns as knowledge_base, plus:
    archivedAt TIMESTAMP NOT NULL DEFAULT NOW(),
    archivedReason VARCHAR NOT NULL,
    supersededBy INT
);

-- Relationships
CREATE TABLE entity_relationships (
    id SERIAL PRIMARY KEY,
    fromType VARCHAR NOT NULL,
    fromId VARCHAR NOT NULL,
    relationshipType VARCHAR NOT NULL,
    toType VARCHAR NOT NULL,
    toId VARCHAR NOT NULL,
    properties JSONB NOT NULL DEFAULT '{}',
    createdBy VARCHAR NOT NULL,
    createdAt TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(fromType, fromId, relationshipType, toType, toId)
);
```

---

## Rationale

### Why Flat Key-Value?

**1. Atomic Facts Principle**

Each row is one atomic fact:

```
researcher/jane_smith | affiliation | {"institution": "MIT"} | 85 | OpenAlex
researcher/jane_smith | pub_count   | {"count": 24}          | 90 | ORCID
```

This makes conflict resolution simple:
- Conflicts are per-key, not per-entity
- Each fact has its own confidence score
- Each fact has its own source
- Each fact can expire independently

**2. No Schema Migrations for New Fact Types**

Adding a new fact type requires no migration:

```typescript
// Day 1: Only affiliation
await iranti.write({
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'MIT' },
    ...
});

// Day 2: Add publication count (no migration needed)
await iranti.write({
    entity: 'researcher/jane_smith',
    key: 'publication_count',
    value: { count: 24 },
    ...
});

// Day 3: Add h-index (no migration needed)
await iranti.write({
    entity: 'researcher/jane_smith',
    key: 'h_index',
    value: { score: 12 },
    ...
});
```

The schema is domain-agnostic. It works for:
- Researchers
- Companies
- Products
- Markets
- Anything

**3. Efficient Queries**

The unique constraint `(entityType, entityId, key)` makes queries fast:

```sql
-- Query one fact (index hit)
SELECT * FROM knowledge_base
WHERE entityType = 'researcher'
  AND entityId = 'jane_smith'
  AND key = 'affiliation';

-- Query all facts for an entity (index scan)
SELECT * FROM knowledge_base
WHERE entityType = 'researcher'
  AND entityId = 'jane_smith';
```

**4. Simple Conflict Detection**

Conflicts are easy to detect:

```sql
-- Check if key exists
SELECT * FROM knowledge_base
WHERE entityType = ? AND entityId = ? AND key = ?;

-- If exists and value differs → conflict
```

### Why Separate Relationships Table?

**1. Directional Relationships**

Relationships are directional:

```
jane_smith MEMBER_OF mit_csail
jane_smith AUTHORED paper_123
paper_123 CITES paper_456
```

These don't fit naturally in the key-value model because:
- They connect two entities
- They have a type (MEMBER_OF, AUTHORED, CITES)
- They're not properties of a single entity

**2. Graph Traversal**

Separate table enables efficient graph queries:

```sql
-- Find all entities related to jane_smith
SELECT * FROM entity_relationships
WHERE fromType = 'researcher' AND fromId = 'jane_smith';

-- Find all entities that cite paper_123
SELECT * FROM entity_relationships
WHERE toType = 'paper' AND toId = 'paper_123'
  AND relationshipType = 'CITES';

-- Deep traversal (recursive CTE)
WITH RECURSIVE related AS (
    SELECT * FROM entity_relationships WHERE fromId = 'jane_smith'
    UNION
    SELECT r.* FROM entity_relationships r
    JOIN related ON r.fromId = related.toId
)
SELECT * FROM related;
```

**3. Relationship Metadata**

Relationships can have their own metadata:

```typescript
await iranti.relate(
    'researcher/jane_smith',
    'MEMBER_OF',
    'lab/mit_csail',
    {
        createdBy: 'agent_001',
        properties: {
            since: '2020-01-01',
            role: 'Principal Investigator',
        },
    }
);
```

This doesn't fit in the key-value model.

### Why Not a Graph Database?

**Considered:** Neo4j, ArangoDB, DGraph

**Pros:**
- Native graph queries
- Optimized for traversal
- Rich query language

**Cons:**
- Adds complexity (another database)
- Overkill for our use case
- Most queries are simple (1-2 hops)
- PostgreSQL can handle graph queries with recursive CTEs

**Decision:** PostgreSQL with a relationships table is sufficient. We can always migrate to a graph DB later if needed.

### Why Properties Column?

The `properties` JSONB column is an escape hatch for caller-defined metadata:

```typescript
await iranti.write({
    entity: 'researcher/jane_smith',
    key: 'affiliation',
    value: { institution: 'MIT' },
    summary: 'Affiliated with MIT',
    confidence: 85,
    source: 'OpenAlex',
    agent: 'agent_001',
    // Custom metadata
    properties: {
        verifiedBy: 'human',
        verificationDate: '2024-01-15',
        notes: 'Confirmed via personal website',
    },
});
```

This allows:
- Domain-specific metadata without schema changes
- Experimentation without migrations
- Backward compatibility (old code ignores new properties)

---

## Consequences

### Positive

1. **No migrations for new fact types** — Add new keys without schema changes
2. **Domain-agnostic** — Works for any entity type
3. **Simple conflict resolution** — One fact = one row
4. **Efficient queries** — Indexed on (entityType, entityId, key)
5. **Full provenance** — Archive table keeps everything
6. **Flexible metadata** — Properties column for custom data
7. **Graph queries** — Relationships table enables traversal

### Negative

1. **Not a "true" graph DB** — Graph queries require recursive CTEs
2. **Denormalized** — Entity data spread across multiple rows
3. **No schema validation** — valueRaw can be any JSON

### Neutral

1. **PostgreSQL-specific** — Uses JSONB, recursive CTEs
2. **Requires unique constraint** — (entityType, entityId, key) must be unique

---

## Alternatives Considered

### Document Store (One Document Per Entity)

**Design:**

```sql
CREATE TABLE entities (
    entityType VARCHAR NOT NULL,
    entityId VARCHAR NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (entityType, entityId)
);

-- Example row:
{
    "entityType": "researcher",
    "entityId": "jane_smith",
    "data": {
        "affiliation": {"institution": "MIT", "confidence": 85, "source": "OpenAlex"},
        "publication_count": {"count": 24, "confidence": 90, "source": "ORCID"}
    }
}
```

**Pros:**
- One row per entity
- Natural for some queries

**Cons:**
- Conflict resolution is complex (which field changed?)
- Can't have per-field confidence scores
- Can't have per-field sources
- Can't expire individual facts
- Hard to query specific facts

**Rejected because:** Doesn't support atomic facts principle.

### EAV (Entity-Attribute-Value)

**Design:**

```sql
CREATE TABLE facts (
    entity VARCHAR NOT NULL,
    attribute VARCHAR NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (entity, attribute)
);
```

**Pros:**
- Very flexible
- No schema changes needed

**Cons:**
- No type safety (everything is TEXT)
- No metadata per fact (confidence, source, etc.)
- Requires separate tables for metadata
- Complex queries

**Rejected because:** Too generic, loses type information.

### Pure Graph Database

**Design:**

Use Neo4j or similar. Entities are nodes, facts are properties, relationships are edges.

**Pros:**
- Native graph queries
- Optimized for traversal
- Rich query language (Cypher)

**Cons:**
- Adds complexity (another database)
- Overkill for most queries (1-2 hops)
- Harder to deploy (requires Neo4j)
- Less familiar to developers

**Rejected because:** PostgreSQL is sufficient for our needs.

### Hybrid: Key-Value + Graph DB

**Design:**

Use PostgreSQL for facts, Neo4j for relationships.

**Pros:**
- Best of both worlds
- Optimized for each use case

**Cons:**
- Two databases to manage
- Complex deployment
- Data consistency challenges
- Overkill for current scale

**Rejected because:** Too complex. Can revisit if we need it.

---

## Implementation

### Prisma Schema

```prisma
model KnowledgeEntry {
    id           Int       @id @default(autoincrement())
    entityType   String
    entityId     String
    key          String
    valueRaw     Json
    valueSummary String
    confidence   Int       @default(50)
    source       String
    validUntil   DateTime?
    createdBy    String
    createdAt    DateTime  @default(now())
    updatedAt    DateTime  @updatedAt
    conflictLog  Json      @default("[]")
    isProtected  Boolean   @default(false)
    properties   Json      @default("{}")

    @@unique([entityType, entityId, key])
    @@index([entityType, entityId, key])
    @@map("knowledge_base")
}

model Archive {
    id             Int       @id @default(autoincrement())
    entityType     String
    entityId       String
    key            String
    valueRaw       Json
    valueSummary   String
    confidence     Int
    source         String
    validUntil     DateTime?
    createdBy      String
    createdAt      DateTime
    conflictLog    Json      @default("[]")
    properties     Json      @default("{}")
    archivedAt     DateTime  @default(now())
    archivedReason String
    supersededBy   Int?

    @@index([entityType, entityId, key])
    @@map("archive")
}

model EntityRelationship {
    id               Int      @id @default(autoincrement())
    fromType         String
    fromId           String
    relationshipType String
    toType           String
    toId             String
    properties       Json     @default("{}")
    createdBy        String
    createdAt        DateTime @default(now())

    @@unique([fromType, fromId, relationshipType, toType, toId])
    @@index([fromType, fromId])
    @@index([toType, toId])
}
```

### Query Examples

**Write a fact:**

```typescript
await prisma.knowledgeEntry.upsert({
    where: {
        entityType_entityId_key: {
            entityType: 'researcher',
            entityId: 'jane_smith',
            key: 'affiliation',
        },
    },
    create: {
        entityType: 'researcher',
        entityId: 'jane_smith',
        key: 'affiliation',
        valueRaw: { institution: 'MIT' },
        valueSummary: 'Affiliated with MIT',
        confidence: 85,
        source: 'OpenAlex',
        createdBy: 'agent_001',
    },
    update: {
        valueRaw: { institution: 'MIT' },
        confidence: 85,
        updatedAt: new Date(),
    },
});
```

**Query all facts for an entity:**

```typescript
const facts = await prisma.knowledgeEntry.findMany({
    where: {
        entityType: 'researcher',
        entityId: 'jane_smith',
    },
});
```

**Create a relationship:**

```typescript
await prisma.entityRelationship.create({
    data: {
        fromType: 'researcher',
        fromId: 'jane_smith',
        relationshipType: 'MEMBER_OF',
        toType: 'lab',
        toId: 'mit_csail',
        createdBy: 'agent_001',
    },
});
```

**Query relationships:**

```typescript
const related = await prisma.entityRelationship.findMany({
    where: {
        fromType: 'researcher',
        fromId: 'jane_smith',
    },
});
```

---

## Migration Path

If we need to change this design later:

### To Document Store

1. Group facts by entity
2. Migrate to single document per entity
3. Keep archive as-is for provenance

### To Graph Database

1. Export entities as nodes
2. Export relationships as edges
3. Keep PostgreSQL for metadata
4. Use graph DB for traversal only

### To Separate Tables Per Entity Type

1. Create `researchers` table
2. Create `companies` table
3. Migrate data
4. Keep generic table for new types

The flat schema makes these migrations possible without data loss.

---

## References

- [EAV Pattern](https://en.wikipedia.org/wiki/Entity%E2%80%93attribute%E2%80%93value_model)
- [Graph Databases](https://neo4j.com/developer/graph-database/)
- [PostgreSQL JSONB](https://www.postgresql.org/docs/current/datatype-json.html)
- [Recursive CTEs](https://www.postgresql.org/docs/current/queries-with.html)

---

## Revision History

- **2024-01-13:** Initial decision (flat key-value + relationships table)
