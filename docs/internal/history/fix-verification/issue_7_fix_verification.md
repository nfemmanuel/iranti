# Issue 7 Fix Verification

## Implementation Complete

### Changes Made

#### 1. Reserved Keys Expansion (src/librarian/guards.ts)
**Added agent_profile to reserved keys:**
```ts
export const RESERVED_KEY_WRITERS: Record<string, Set<string>> = {
  "attendant_state": new Set(["Attendant", "Librarian", "Archivist"]),
  "schema_version": new Set(["Seed", "System", "Librarian"]),
  "agent_profile": new Set(["Librarian", "Archivist", "Seed", "System"]),
};
```

#### 2. Cross-Agent Write Protection (src/librarian/guards.ts)
**Added agent namespace isolation:**
```ts
// 3) Agent namespace cross-write protection
if (entityType === "agent") {
    if (!STAFF_WRITERS.has(createdBy)) {
        // Normal agents can only write to their own namespace
        if (createdBy !== entityId) {
            throw new Error("Write blocked: agents may only write to their own agent namespace.");
        }
    }
}
```

**Protection:**
- AgentA can write to `agent/agentA/*`
- AgentA CANNOT write to `agent/agentB/*`
- Staff can write to any agent namespace

#### 3. Reserved Prefix Protection (src/librarian/guards.ts)
**Added underscore-prefix rule:**
```ts
// 4) Reserved prefix protection
if (key.startsWith("_") && !STAFF_WRITERS.has(createdBy)) {
    throw new Error("Write blocked: underscore-prefixed keys are reserved.");
}
```

**Protection:**
- Normal agents cannot write keys starting with `_`
- Staff can write underscore-prefixed keys
- Future-proofs internal keys without constant allowlist updates

#### 4. Attendant Verification
**Already correct:**
```ts
createdBy: 'Attendant',
source: 'attendant',
```

Attendant writes with correct identity, so reserved key writes succeed.

#### 5. Test Script (scripts/test_reserved_key_poisoning.ts)
Validates 7 scenarios:
1. Agent writes attendant_state → blocked
2. Attendant writes attendant_state → succeeds
3. AgentA writes to AgentB namespace → blocked
4. AgentA writes to own namespace → succeeds
5. Agent writes underscore-prefixed key → blocked
6. Staff writes underscore-prefixed key → succeeds
7. Agent writes agent_profile → blocked

## Protection Layers

### Layer 1: System Namespace
```ts
if (entityType === "system") {
    if (!STAFF_WRITERS.has(createdBy)) {
        throw new Error("Write blocked: system namespace is staff-only.");
    }
}
```

### Layer 2: Reserved Keys
```ts
if (RESERVED_KEY_WRITERS[key]) {
    if (!RESERVED_KEY_WRITERS[key].has(createdBy)) {
        throw new Error(`Write blocked: key '${key}' is reserved.`);
    }
}
```

### Layer 3: Agent Namespace Isolation
```ts
if (entityType === "agent") {
    if (!STAFF_WRITERS.has(createdBy)) {
        if (createdBy !== entityId) {
            throw new Error("Write blocked: agents may only write to their own agent namespace.");
        }
    }
}
```

### Layer 4: Reserved Prefix
```ts
if (key.startsWith("_") && !STAFF_WRITERS.has(createdBy)) {
    throw new Error("Write blocked: underscore-prefixed keys are reserved.");
}
```

## Attack Scenarios Prevented

### Scenario 1: Attendant State Poisoning
```ts
// Malicious agent tries to corrupt another agent's state
await librarianWrite({
    entityType: 'agent',
    entityId: 'victimAgent',
    key: 'attendant_state',
    valueRaw: { malicious: 'payload' },
    createdBy: 'attackerAgent',
});
// BLOCKED: Reserved key + cross-agent protection
```

### Scenario 2: Profile Hijacking
```ts
// Agent tries to modify agent registry profile
await librarianWrite({
    entityType: 'agent',
    entityId: 'someAgent',
    key: 'agent_profile',
    valueRaw: { fake: 'profile' },
    createdBy: 'attackerAgent',
});
// BLOCKED: Reserved key protection
```

### Scenario 3: Internal State Corruption
```ts
// Agent tries to write internal control key
await librarianWrite({
    entityType: 'researcher',
    entityId: 'test',
    key: '_internal_cache',
    valueRaw: { poisoned: 'cache' },
    createdBy: 'attackerAgent',
});
// BLOCKED: Reserved prefix protection
```

### Scenario 4: Cross-Agent Data Poisoning
```ts
// AgentA tries to corrupt AgentB's notes
await librarianWrite({
    entityType: 'agent',
    entityId: 'agentB',
    key: 'notes',
    valueRaw: { fake: 'notes' },
    createdBy: 'agentA',
});
// BLOCKED: Cross-agent protection
```

## Legitimate Operations Still Work

### Attendant Persists State
```ts
await librarianWrite({
    entityType: 'agent',
    entityId: 'agentA',
    key: 'attendant_state',
    valueRaw: { valid: 'state' },
    createdBy: 'Attendant', // Staff writer
});
// SUCCEEDS: Attendant is in STAFF_WRITERS and RESERVED_KEY_WRITERS
```

### Agent Writes Own Data
```ts
await librarianWrite({
    entityType: 'agent',
    entityId: 'agentA',
    key: 'notes',
    valueRaw: { my: 'notes' },
    createdBy: 'agentA', // Matches entityId
});
// SUCCEEDS: Self-write allowed
```

### Staff Writes Internal Keys
```ts
await librarianWrite({
    entityType: 'researcher',
    entityId: 'test',
    key: '_internal_state',
    valueRaw: { valid: 'state' },
    createdBy: 'Librarian', // Staff writer
});
// SUCCEEDS: Staff can write underscore-prefixed keys
```

## Acceptance Criteria ✓

- [x] Normal agents cannot write `attendant_state`
- [x] Normal agents cannot write other agents' namespaces
- [x] Attendant can still persist state (createdBy correct)
- [x] Governance protects both system rules and internal control plane keys
- [x] Reserved prefix protection future-proofs internal keys
- [x] Cross-agent isolation prevents namespace poisoning

## Reserved Keys Registry

| Key | Allowed Writers | Purpose |
|---|---|---|
| `attendant_state` | Attendant, Librarian, Archivist | Per-agent working memory state |
| `schema_version` | Seed, System, Librarian | Library schema version tracking |
| `agent_profile` | Librarian, Archivist, Seed, System | Agent registry profiles |
| `_*` (prefix) | All staff writers | Future internal keys |

## Result

**Issue 7 is FIXED.**

Internal state keys protected. Cross-agent poisoning impossible. Reserved prefix future-proofs. Attendant state secure.
