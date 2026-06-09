// Agent registry — Phase 0
//
// Every writer of facts in iranti must first register as an agent. This
// module handles registration and lookup. In Phase 5 (MCP), the handshake
// call triggers agent registration automatically. For now it is explicit.

import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { agents, type Agent, type NewAgent } from "../db/schema.js";

// Register a new agent. If an agent with this name already exists, return
// the existing record rather than creating a duplicate.
export async function registerAgent(
  input: Pick<NewAgent, "name" | "description" | "metadata">,
): Promise<Agent> {
  // Check if an agent with this name already exists.
  const existing = await db.query.agents.findFirst({
    where: eq(agents.name, input.name),
  });

  if (existing) {
    return existing;
  }

  // Insert and return the new agent.
  const [agent] = await db.insert(agents).values(input).returning();

  // The non-null assertion is safe: insert().returning() always returns
  // at least one row when no error is thrown.
  return agent!;
}

// Look up an agent by its ID. Returns undefined if not found.
export async function getAgentById(id: string): Promise<Agent | undefined> {
  return db.query.agents.findFirst({
    where: eq(agents.id, id),
  });
}

// Look up an agent by name. Returns undefined if not found.
export async function getAgentByName(name: string): Promise<Agent | undefined> {
  return db.query.agents.findFirst({
    where: eq(agents.name, name),
  });
}
