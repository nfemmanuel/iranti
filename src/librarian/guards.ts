export const STAFF_WRITERS = new Set([
  "Librarian",
  "Archivist",
  "Seed",
  "System",
  "Attendant",
]);

// Reserved keys that only specific staffers may write
export const RESERVED_KEY_WRITERS: Record<string, Set<string>> = {
  // Only Attendant should write the per-agent state blob
  "attendant_state": new Set(["Attendant", "Librarian", "Archivist"]),

  // Only seed/system migration logic should write schema version
  "schema_version": new Set(["Seed", "System", "Librarian"]),

  // Agent registry profile
  "agent_profile": new Set(["Librarian", "Archivist", "Seed", "System"]),

  // Add more as you need
};

// Helper: throws if forbidden
export function enforceWritePermissions(input: {
  entityType: string;
  entityId: string;
  key: string;
  createdBy: string;
}) {
  const { entityType, entityId, key, createdBy } = input;

  // 1) System namespace is always protected
  if (entityType === "system") {
    if (!STAFF_WRITERS.has(createdBy)) {
      throw new Error("Write blocked: system namespace is staff-only.");
    }
  }

  // 2) Reserved key protection
  if (RESERVED_KEY_WRITERS[key]) {
    if (!RESERVED_KEY_WRITERS[key].has(createdBy)) {
      throw new Error(`Write blocked: key '${key}' is reserved.`);
    }
  }

  // 3) Agent namespace cross-write protection
  if (entityType === "agent") {
    if (!STAFF_WRITERS.has(createdBy)) {
      // Normal agents can only write to their own namespace
      if (createdBy !== entityId) {
        throw new Error("Write blocked: agents may only write to their own agent namespace.");
      }
    }
  }

  // 4) Reserved prefix protection
  if (key.startsWith("_") && !STAFF_WRITERS.has(createdBy)) {
    throw new Error("Write blocked: underscore-prefixed keys are reserved.");
  }
}
