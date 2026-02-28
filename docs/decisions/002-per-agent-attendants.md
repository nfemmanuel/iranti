# ADR 002: Per-Agent Attendant Instances

**Status:** Accepted

**Date:** 2024-01-12

**Deciders:** Core team

---

## Context

The Attendant manages working memory for agents. We need to decide: should there be one shared Attendant for all agents, or one Attendant instance per agent?

**Key requirements:**
1. Each agent needs personalized working memory
2. Working memory must persist across sessions
3. Multiple agents may run concurrently
4. Context must be recoverable if an agent loses state
5. System must scale to hundreds of agents

**The problem with shared state:**

If we use a single Attendant for all agents:
- How do we track which working memory belongs to which agent?
- How do we handle concurrent access?
- How do we persist state per-agent?
- How do we prevent memory leaks as agents come and go?

---

## Decision

We will use **per-agent Attendant instances** with a **singleton registry pattern**.

Each agent gets its own `AttendantInstance` object. The registry ensures the same `agentId` always returns the same instance within a process.

---

## Architecture

### AttendantInstance Class

```typescript
class AttendantInstance {
    private agentId: string;
    private workingMemory: WorkingMemoryBrief | null = null;
    private contextCallCount: number = 0;

    async handshake(input: HandshakeInput): Promise<WorkingMemoryBrief>
    async reconvene(input: HandshakeInput): Promise<WorkingMemoryBrief>
    async updateWorkingMemory(entries: WorkingMemoryEntry[]): void
    async onContextLow(): Promise<void>
    async persistState(): Promise<void>
}
```

Each instance:
- Holds working memory in-memory
- Tracks context call count
- Persists state to the knowledge base
- Recovers state from the knowledge base on restart

### Singleton Registry

```typescript
// src/attendant/registry.ts
const attendants = new Map<string, AttendantInstance>();

export function getAttendant(agentId: string): AttendantInstance {
    if (!attendants.has(agentId)) {
        attendants.set(agentId, new AttendantInstance(agentId));
    }
    return attendants.get(agentId)!;
}
```

The registry ensures:
- Same `agentId` → same instance (within a process)
- Instances are created lazily
- No manual lifecycle management needed

### State Persistence

Each Attendant persists its state to the knowledge base:

```typescript
// Written to: agent / {agentId} / attendant_state
{
    workingMemory: [...],
    sessionStarted: "2024-01-12T10:00:00Z",
    contextCallCount: 15,
    lastTask: "Research publication history"
}
```

On restart, the Attendant loads this state and continues where it left off.

---

## Rationale

### Why Per-Agent Instances?

**1. Isolation**

Each agent's working memory is completely isolated. No risk of:
- Agent A seeing Agent B's memory
- Concurrent modification bugs
- State leaking between agents

**2. Simplicity**

The code is simpler:

```typescript
// Per-agent (simple)
const attendant = getAttendant('agent_001');
const brief = await attendant.handshake({...});

// vs. Shared (complex)
const attendant = getSharedAttendant();
const brief = await attendant.handshake('agent_001', {...});
// Now attendant must track state per agent internally
```

**3. Natural Lifecycle**

Each instance has a natural lifecycle:
- Created on first use
- Lives as long as needed
- Garbage collected when agent stops

No manual cleanup needed.

**4. Concurrent Safety**

Multiple agents can call their Attendants concurrently without locks:

```typescript
// These run in parallel, no conflicts
await Promise.all([
    getAttendant('agent_001').handshake({...}),
    getAttendant('agent_002').handshake({...}),
    getAttendant('agent_003').handshake({...}),
]);
```

### Why Singleton Registry?

**1. Consistency**

Same `agentId` always returns the same instance:

```typescript
const a1 = getAttendant('agent_001');
const a2 = getAttendant('agent_001');
// a1 === a2 (same object)
```

This ensures:
- Working memory stays consistent
- Context call count is accurate
- No duplicate state

**2. Lazy Creation**

Instances are created only when needed:

```typescript
// No instances exist yet
getAttendant('agent_001');  // Creates instance
getAttendant('agent_002');  // Creates instance
getAttendant('agent_001');  // Returns existing instance
```

No upfront cost for agents that never run.

**3. Automatic Cleanup**

When an agent stops, its instance can be garbage collected:

```typescript
// In production, add cleanup:
export function releaseAttendant(agentId: string): void {
    const attendant = attendants.get(agentId);
    if (attendant) {
        await attendant.persistState();
        attendants.delete(agentId);
    }
}
```

### Why Persist State?

**1. Crash Recovery**

If the process crashes, agents can resume:

```typescript
// Before crash
const attendant = getAttendant('agent_001');
await attendant.handshake({...});
// State persisted to KB

// After restart
const attendant = getAttendant('agent_001');
// Loads state from KB, continues where it left off
```

**2. Multi-Process**

If agents run in different processes, they can share state via the knowledge base:

```
Process A: Agent 001 writes state to KB
Process B: Agent 001 reads state from KB
```

**3. Audit Trail**

Persisted state provides an audit trail:
- When did the agent start?
- What task was it working on?
- How many LLM calls has it made?

---

## Consequences

### Positive

1. **Simple mental model** — One agent = one Attendant
2. **No shared state bugs** — Each instance is isolated
3. **Concurrent safe** — No locks needed
4. **Crash recoverable** — State persists to KB
5. **Scalable** — Instances created lazily, cleaned up automatically

### Negative

1. **Memory per agent** — Each instance holds working memory in RAM
2. **Not distributed** — Registry is per-process, not global
3. **Cleanup needed** — Long-running processes should clean up inactive agents

### Neutral

1. **Process-local** — Registry is per-process. If you run multiple processes, each has its own registry. This is fine because state persists to the KB.

2. **Manual cleanup optional** — For short-lived processes (scripts, tests), cleanup isn't needed. For long-running processes (servers), add cleanup for inactive agents.

---

## Alternatives Considered

### Shared Attendant with Internal State Map

**Design:**

```typescript
class SharedAttendant {
    private agentStates = new Map<string, WorkingMemoryBrief>();

    async handshake(agentId: string, input: HandshakeInput) {
        let state = this.agentStates.get(agentId);
        // ...
    }
}

const attendant = new SharedAttendant();
```

**Pros:**
- Single object
- Centralized state

**Cons:**
- More complex code
- Concurrent access requires locks
- State map grows unbounded
- Harder to reason about lifecycle

**Rejected because:** More complex with no benefits.

### Stateless Attendant (Load from KB Every Time)

**Design:**

```typescript
async function handshake(agentId: string, input: HandshakeInput) {
    // Load state from KB
    const state = await loadStateFromKB(agentId);
    // Generate brief
    const brief = await generateBrief(state, input);
    // Save state to KB
    await saveStateToKB(agentId, brief);
    return brief;
}
```

**Pros:**
- No in-memory state
- Naturally distributed
- No cleanup needed

**Cons:**
- DB round trip on every call
- Slower (2x DB queries per handshake)
- Can't track context call count in-memory

**Rejected because:** Too slow. Working memory should be fast.

### Global Registry (Across Processes)

**Design:**

Use Redis or similar to maintain a global registry across processes.

**Pros:**
- Works across processes
- Centralized state

**Cons:**
- Requires Redis
- More complex
- Slower (network round trip)
- Overkill for most deployments

**Rejected because:** Adds complexity without clear benefit. State persistence to KB is sufficient for multi-process scenarios.

---

## Implementation

### File Structure

```
src/attendant/
├── index.ts              — Re-exports + legacy functional API
├── AttendantInstance.ts  — Per-agent class
└── registry.ts           — Singleton map
```

### AttendantInstance.ts

```typescript
export class AttendantInstance {
    private agentId: string;
    private workingMemory: WorkingMemoryBrief | null = null;
    private contextCallCount: number = 0;
    private sessionStarted: string | null = null;

    constructor(agentId: string) {
        this.agentId = agentId;
    }

    async handshake(input: HandshakeInput): Promise<WorkingMemoryBrief> {
        // Load operating rules from Staff Namespace
        // Infer task type from recent messages
        // Filter KB for relevant entries
        // Build working memory brief
        // Persist state
        // Return brief
    }

    async reconvene(input: HandshakeInput): Promise<WorkingMemoryBrief> {
        // Check if task has changed
        // If changed, rebuild working memory
        // If unchanged, return existing brief with updated timestamp
    }

    async onContextLow(): Promise<void> {
        // Re-read operating rules from Staff Namespace
        // Reset context call count
    }

    async persistState(): Promise<void> {
        // Write state to agent / {agentId} / attendant_state
    }
}
```

### registry.ts

```typescript
const attendants = new Map<string, AttendantInstance>();

export function getAttendant(agentId: string): AttendantInstance {
    if (!attendants.has(agentId)) {
        const instance = new AttendantInstance(agentId);
        attendants.set(agentId, instance);
    }
    return attendants.get(agentId)!;
}

export function releaseAttendant(agentId: string): void {
    const attendant = attendants.get(agentId);
    if (attendant) {
        attendant.persistState();
        attendants.delete(agentId);
    }
}

export function listActiveAttendants(): string[] {
    return Array.from(attendants.keys());
}
```

### SDK Integration

```typescript
export class Iranti {
    async handshake(input: HandshakeInput): Promise<WorkingMemoryBrief> {
        const attendant = getAttendant(input.agent);
        return attendant.handshake(input);
    }

    getAttendant(agentId: string): AttendantInstance {
        return getAttendant(agentId);
    }
}
```

---

## Context Recovery

After 20 LLM calls, the Attendant re-reads operating rules from the Staff Namespace:

```typescript
async complete(messages: LLMMessage[]): Promise<LLMResponse> {
    this.contextCallCount++;

    if (this.contextCallCount >= 20) {
        await this.onContextLow();
    }

    return route('task_type', messages);
}
```

This prevents the agent from hallucinating behavior after long sessions.

---

## Testing

### Unit Tests

```typescript
test('same agentId returns same instance', () => {
    const a1 = getAttendant('agent_001');
    const a2 = getAttendant('agent_001');
    expect(a1).toBe(a2);
});

test('different agentIds return different instances', () => {
    const a1 = getAttendant('agent_001');
    const a2 = getAttendant('agent_002');
    expect(a1).not.toBe(a2);
});

test('state persists across handshakes', async () => {
    const attendant = getAttendant('agent_001');
    await attendant.handshake({...});
    expect(attendant.contextCallCount).toBe(1);
    await attendant.handshake({...});
    expect(attendant.contextCallCount).toBe(2);
});
```

### Integration Tests

```typescript
test('state persists to KB', async () => {
    const attendant = getAttendant('agent_001');
    await attendant.handshake({...});
    await attendant.persistState();

    // Check KB
    const state = await queryEntry({
        entityType: 'agent',
        entityId: 'agent_001',
        key: 'attendant_state',
    });
    expect(state.found).toBe(true);
});

test('state recovers after restart', async () => {
    // First session
    const a1 = getAttendant('agent_001');
    await a1.handshake({...});
    await a1.persistState();

    // Simulate restart (clear registry)
    attendants.clear();

    // Second session
    const a2 = getAttendant('agent_001');
    // Should load state from KB
    expect(a2.contextCallCount).toBe(1);
});
```

---

## Migration Path

If we need to change this design later:

1. **To shared Attendant:** Refactor `AttendantInstance` to be internal, expose shared API
2. **To distributed registry:** Replace Map with Redis, keep same API
3. **To stateless:** Remove in-memory state, load from KB every time

The registry pattern makes these changes possible without breaking the SDK API.

---

## References

- [Singleton Pattern](https://refactoring.guru/design-patterns/singleton)
- [Registry Pattern](https://martinfowler.com/eaaCatalog/registry.html)
- [Per-Request State in Express](https://expressjs.com/en/guide/using-middleware.html)

---

## Revision History

- **2024-01-12:** Initial decision (per-agent instances with singleton registry)
