// Session management — Phase 0
//
// A session groups everything written during one continuous interaction.
// Sessions have a start and (optionally) an end time. Facts written during
// a session are tagged with its ID, enabling queries like "what did the
// agent learn in the last session?" or "show me all facts from this week."

import { eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { sessions, type NewSession, type Session } from "../db/schema.js";

// Open a new session for an agent.
export async function openSession(
  agentId: string,
  metadata?: NewSession["metadata"],
): Promise<Session> {
  const [session] = await db
    .insert(sessions)
    .values({ agentId, metadata })
    .returning();

  return session!;
}

// Close a session by setting its endedAt timestamp.
// Calling this on an already-closed session is a no-op.
export async function closeSession(sessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ endedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

// Get a session by ID.
export async function getSession(
  sessionId: string,
): Promise<Session | undefined> {
  return db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });
}

// Get all open sessions for an agent (sessions with no endedAt).
// In normal operation there should only be one, but this handles edge cases.
export async function getOpenSessions(agentId: string): Promise<Session[]> {
  return db.query.sessions.findMany({
    where: (s, { and }) => and(eq(s.agentId, agentId), isNull(s.endedAt)),
  });
}
