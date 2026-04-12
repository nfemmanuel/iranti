/**
 * Input validation middleware for the iranti API.
 *
 * Validates request bodies against named schema definitions before they reach
 * route handlers. Each schema entry describes field-level constraints
 * (type, required, maxLength, pattern, min/max, maxSize).
 *
 * Key exports:
 *  validateInput(schemaName)       — express middleware factory; rejects with 400 on failure
 *  validateSessionListQuery(query) — parses + validates GET /sessions query string
 *  validateSessionLedgerQuery(q)   — parses + validates GET /ledger query string
 *  sanitizeString(str)             — XSS-escapes a string value
 *  validateEntity(entity)          — returns true if entity matches entityType/entityId pattern
 *  validateKey(key)                — returns true if key is alphanumeric+underscore/hyphen
 */

import { Request, Response, NextFunction } from 'express';
import type { SessionListInput, SessionListSort, SessionOperatorState } from '../../sdk';
import type { EventLevel } from '../../lib/staffEventEmitter';
import type { IrantiAuthContext } from './auth';

/** Constraint descriptor for a single field in a validation schema. */
interface FieldSchema {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
    required: boolean;
    maxLength?: number;
    pattern?: RegExp;
    maxSize?: number;
    min?: number;
    max?: number;
    default?: unknown;
}

// Validation schemas
const schemas: Record<string, Record<string, FieldSchema>> = {
  write: {
    entity: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+$/, maxLength: 200 },
    key: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 100 },
    value: { type: 'any', required: true, maxSize: 100000 }, // 100KB max
    summary: { type: 'string', required: true, maxLength: 500 },
    confidence: { type: 'number', required: true, min: 0, max: 100 },
    source: { type: 'string', required: true, maxLength: 200 },
    agent: { type: 'string', required: true, maxLength: 200 },
    properties: { type: 'object', required: false, maxSize: 10000 },
    validFrom: { type: 'string', required: false, maxLength: 50 },
    requestId: { type: 'string', required: false, maxLength: 100 }
  },
  observe: {
    agent: { type: 'string', required: false, maxLength: 200 },
    agentId: { type: 'string', required: false, maxLength: 200 },
    currentContext: { type: 'string', required: false, maxLength: 50000 },
    maxFacts: { type: 'number', required: false, min: 1, max: 100, default: 10 },
    entityHints: { type: 'array', required: false, maxLength: 100 }
  },
  handshake: {
    agent: { type: 'string', required: false, maxLength: 200 },
    agentId: { type: 'string', required: false, maxLength: 200 },
    task: { type: 'string', required: true, maxLength: 1000 },
    recentMessages: { type: 'array', required: false, maxLength: 100 }
  },
  reconvene: {
    agent: { type: 'string', required: false, maxLength: 200 },
    agentId: { type: 'string', required: false, maxLength: 200 },
    task: { type: 'string', required: true, maxLength: 1000 },
    recentMessages: { type: 'array', required: false, maxLength: 100 }
  },
  checkpoint: {
    agent: { type: 'string', required: false, maxLength: 200 },
    agentId: { type: 'string', required: false, maxLength: 200 },
    task: { type: 'string', required: true, maxLength: 1000 },
    recentMessages: { type: 'array', required: true, maxLength: 100 },
    checkpoint: { type: 'any', required: true, maxSize: 20000 },
    sessionId: { type: 'string', required: false, maxLength: 200 },
    heartbeatAt: { type: 'string', required: false, maxLength: 50 }
  },
  sessionAction: {
    agent: { type: 'string', required: false, maxLength: 200 },
    agentId: { type: 'string', required: false, maxLength: 200 },
    sessionId: { type: 'string', required: false, maxLength: 200 }
  },
  sessionInspect: {
    agent: { type: 'string', required: false, maxLength: 200 },
    agentId: { type: 'string', required: false, maxLength: 200 },
    task: { type: 'string', required: false, maxLength: 1000 },
    recentMessages: { type: 'array', required: false, maxLength: 100 }
  },
  attend: {
    agent: { type: 'string', required: false, maxLength: 200 },
    agentId: { type: 'string', required: false, maxLength: 200 },
    currentContext: { type: 'string', required: false, maxLength: 50000 },
    latestMessage: { type: 'string', required: false, maxLength: 10000 },
    maxFacts: { type: 'number', required: false, min: 1, max: 100, default: 10 },
    entityHints: { type: 'array', required: false, maxLength: 100 },
    forceInject: { type: 'boolean', required: false },
    suppressEvents: { type: 'boolean', required: false },
    phase: { type: 'string', required: false, maxLength: 20 },
    // M2: tool-result extraction. The host passes the content of a just-completed
    // read-only tool call (Read/Grep/Bash/etc.) and Iranti extracts durable facts
    // from it automatically. Capped generously — raw file reads can be large.
    pendingToolCall: { type: 'object', required: false, maxSize: 5000 },
    toolResult: { type: 'object', required: false, maxSize: 200000 }
  },
  relate: {
    fromEntity: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+$/, maxLength: 200 },
    toEntity: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+$/, maxLength: 200 },
    relationshipType: { type: 'string', required: true, maxLength: 100 },
    createdBy: { type: 'string', required: true, maxLength: 200 },
    properties: { type: 'object', required: false, maxSize: 10000 }
  },
  search: {
    query: { type: 'string', required: true, maxLength: 500 },
    limit: { type: 'number', required: false, min: 1, max: 50, default: 10 },
    entityType: { type: 'string', required: false, maxLength: 100 },
    entityId: { type: 'string', required: false, maxLength: 200 },
    lexicalWeight: { type: 'number', required: false, min: 0, max: 1, default: 0.45 },
    vectorWeight: { type: 'number', required: false, min: 0, max: 1, default: 0.55 },
    minScore: { type: 'number', required: false, min: 0, max: 1, default: 0 }
  }
};

function validateField(value: unknown, schema: FieldSchema, fieldName: string): string | null {
  // Required check
  if (schema.required && (value === undefined || value === null)) {
    return `Missing required field: ${fieldName}`;
  }

  if (value === undefined || value === null) {
    return null; // Optional field not provided
  }

  // Type check
  const actualType = Array.isArray(value) ? 'array' : typeof value;
  if (schema.type !== 'any' && actualType !== schema.type) {
    return `Invalid type for ${fieldName}: expected ${schema.type}, got ${actualType}`;
  }

  // String validations — type guard mirrors the actualType check above
  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.maxLength && value.length > schema.maxLength) {
      return `${fieldName} exceeds maximum length of ${schema.maxLength}`;
    }
    if (schema.pattern && !schema.pattern.test(value)) {
      return `${fieldName} has invalid format`;
    }
  }

  // Number validations — type guard mirrors the actualType check above
  if (schema.type === 'number' && typeof value === 'number') {
    if (schema.min !== undefined && value < schema.min) {
      return `${fieldName} must be at least ${schema.min}`;
    }
    if (schema.max !== undefined && value > schema.max) {
      return `${fieldName} must be at most ${schema.max}`;
    }
  }

  // Size validations for JSON payloads
  if (schema.maxSize !== undefined) {
    const size = JSON.stringify(value).length;
    if (size > schema.maxSize) {
      return `${fieldName} exceeds maximum size of ${schema.maxSize} bytes`;
    }
  }

  // Array validations — type guard mirrors the actualType check above
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.maxLength && value.length > schema.maxLength) {
      return `${fieldName} exceeds maximum length of ${schema.maxLength}`;
    }
  }

  return null;
}

export function validateInput(schemaName: keyof typeof schemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    const schema = schemas[schemaName];
    const data = req.body;

    // Validate each field
    for (const [fieldName, fieldSchema] of Object.entries(schema)) {
      const error = validateField(data[fieldName], fieldSchema, fieldName);
      if (error) {
        return res.status(400).json({
          error,
          code: 'VALIDATION_ERROR',
          field: fieldName
        });
      }

      // Apply defaults
      if (data[fieldName] === undefined && 'default' in fieldSchema) {
        data[fieldName] = fieldSchema.default;
      }
    }

    // Check for unexpected fields
    const allowedFields = Object.keys(schema);
    const providedFields = Object.keys(data);
    const unexpectedFields = providedFields.filter(f => !allowedFields.includes(f));
    
    if (unexpectedFields.length > 0) {
      return res.status(400).json({
        error: `Unexpected fields: ${unexpectedFields.join(', ')}`,
        code: 'VALIDATION_ERROR'
      });
    }

    if (
      schemaName === 'handshake'
      || schemaName === 'reconvene'
      || schemaName === 'checkpoint'
      || schemaName === 'sessionAction'
      || schemaName === 'sessionInspect'
      || schemaName === 'observe'
      || schemaName === 'attend'
    ) {
      const agent = typeof data.agent === 'string' ? data.agent.trim() : '';
      const agentId = typeof data.agentId === 'string' ? data.agentId.trim() : '';
      const auth = (req as Request & { irantiAuth?: IrantiAuthContext }).irantiAuth;
      const authBackedAgent = typeof auth?.keyId === 'string' && auth.keyId.trim().length > 0;
      if (!agent && !agentId && !authBackedAgent) {
        return res.status(400).json({
          error: 'agentId is required (agent is accepted as a legacy alias).',
          code: 'VALIDATION_ERROR',
          field: 'agentId'
        });
      }
    }

    if (schemaName === 'observe') {
      const currentContext = typeof data.currentContext === 'string' ? data.currentContext.trim() : '';
      const hasEntityHints = Array.isArray(data.entityHints)
        && data.entityHints.some((hint: unknown) => typeof hint === 'string' && hint.trim().length > 0);

      if (currentContext.length === 0 && !hasEntityHints) {
        return res.status(400).json({
          error: 'currentContext or entityHints is required for observe.',
          code: 'VALIDATION_ERROR',
          field: 'currentContext',
        });
      }
    }

    if (schemaName === 'attend' && data.phase !== undefined) {
      const allowedPhases = ['pre-response', 'post-response', 'mid-turn'];
      if (typeof data.phase !== 'string' || !allowedPhases.includes(data.phase)) {
        return res.status(400).json({
          error: `phase must be one of: ${allowedPhases.join(', ')}`,
          code: 'VALIDATION_ERROR',
          field: 'phase'
        });
      }
    }

    next();
  };
}

function readQueryValue(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    return typeof raw[0] === 'string' ? raw[0] : undefined;
  }
  return typeof raw === 'string' ? raw : undefined;
}

export function validateSessionListQuery(query: Request['query']): SessionListInput {
  const agentId = readQueryValue(query.agentId)?.trim();
  const operatorStateRaw = readQueryValue(query.operatorState)?.trim();
  const staleOnlyRaw = readQueryValue(query.staleOnly)?.trim().toLowerCase();
  const limitRaw = readQueryValue(query.limit)?.trim();
  const sortRaw = readQueryValue(query.sort)?.trim();

  const result: SessionListInput = {};

  if (agentId) {
    if (agentId.length > 200) {
      throw new Error('agentId exceeds maximum length of 200.');
    }
    result.agentId = agentId;
  }

  if (operatorStateRaw) {
    const allowedStates: SessionOperatorState[] = ['none', 'active', 'interrupted', 'completed', 'abandoned'];
    if (!allowedStates.includes(operatorStateRaw as SessionOperatorState)) {
      throw new Error(`operatorState must be one of: ${allowedStates.join(', ')}`);
    }
    result.operatorState = operatorStateRaw as SessionOperatorState;
  }

  if (staleOnlyRaw !== undefined) {
    if (staleOnlyRaw !== 'true' && staleOnlyRaw !== 'false') {
      throw new Error('staleOnly must be true or false.');
    }
    result.staleOnly = staleOnlyRaw === 'true';
  }

  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
      throw new Error('limit must be an integer between 1 and 100.');
    }
    result.limit = parsed;
  }

  if (sortRaw) {
    const allowedSorts: SessionListSort[] = ['operator', 'updated_desc', 'agent_asc'];
    if (!allowedSorts.includes(sortRaw as SessionListSort)) {
      throw new Error(`sort must be one of: ${allowedSorts.join(', ')}`);
    }
    result.sort = sortRaw as SessionListSort;
  }

  return result;
}

export function validateSessionLedgerQuery(query: Request['query']): {
  agentId?: string;
  sessionId?: string;
  actionType?: string;
  source?: string;
  host?: string;
  level?: EventLevel;
  since?: Date;
  until?: Date;
  limit?: number;
} {
  const agentId = readQueryValue(query.agentId)?.trim();
  const sessionId = readQueryValue(query.sessionId)?.trim();
  const actionType = readQueryValue(query.actionType)?.trim();
  const source = readQueryValue(query.source)?.trim();
  const host = readQueryValue(query.host)?.trim();
  const levelRaw = readQueryValue(query.level)?.trim();
  const sinceRaw = readQueryValue(query.since)?.trim();
  const untilRaw = readQueryValue(query.until)?.trim();
  const limitRaw = readQueryValue(query.limit)?.trim();

  const result: {
    agentId?: string;
    sessionId?: string;
    actionType?: string;
    source?: string;
    host?: string;
    level?: EventLevel;
    since?: Date;
    until?: Date;
    limit?: number;
  } = {};

  if (agentId) {
    if (agentId.length > 200) throw new Error('agentId exceeds maximum length of 200.');
    result.agentId = agentId;
  }

  if (sessionId) {
    if (sessionId.length > 200) throw new Error('sessionId exceeds maximum length of 200.');
    result.sessionId = sessionId;
  }

  if (actionType) {
    if (actionType.length > 120) throw new Error('actionType exceeds maximum length of 120.');
    result.actionType = actionType;
  }

  if (source) {
    if (source.length > 80) throw new Error('source exceeds maximum length of 80.');
    result.source = source;
  }

  if (host) {
    if (host.length > 120) throw new Error('host exceeds maximum length of 120.');
    result.host = host;
  }

  if (levelRaw) {
    if (levelRaw !== 'audit' && levelRaw !== 'debug') {
      throw new Error('level must be audit or debug.');
    }
    result.level = levelRaw;
  }

  if (sinceRaw) {
    const since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) throw new Error('since must be a valid ISO 8601 timestamp.');
    result.since = since;
  }

  if (untilRaw) {
    const until = new Date(untilRaw);
    if (Number.isNaN(until.getTime())) throw new Error('until must be a valid ISO 8601 timestamp.');
    result.until = until;
  }

  if (limitRaw) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 500) {
      throw new Error('limit must be an integer between 1 and 500.');
    }
    result.limit = parsed;
  }

  return result;
}

// Sanitize strings to prevent XSS
export function sanitizeString(str: string): string {
  return str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// Validate entity format
export function validateEntity(entity: string): boolean {
  return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+$/.test(entity);
}

// Validate key format
export function validateKey(key: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(key);
}
