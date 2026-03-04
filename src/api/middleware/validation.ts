/**
 * Input Validation Middleware
 * Validates and sanitizes API request inputs
 */

import { Request, Response, NextFunction } from 'express';

// Validation schemas
const schemas = {
  write: {
    entity: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+$/, maxLength: 200 },
    key: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 100 },
    value: { type: 'any', required: true, maxSize: 100000 }, // 100KB max
    summary: { type: 'string', required: true, maxLength: 500 },
    confidence: { type: 'number', required: true, min: 0, max: 100 },
    source: { type: 'string', required: true, maxLength: 200 },
    agent: { type: 'string', required: true, maxLength: 200 },
    validUntil: { type: 'string', required: false, maxLength: 50 },
    requestId: { type: 'string', required: false, maxLength: 100 }
  },
  observe: {
    agentId: { type: 'string', required: true, maxLength: 200 },
    currentContext: { type: 'string', required: true, maxLength: 50000 },
    maxFacts: { type: 'number', required: false, min: 1, max: 100, default: 10 }
  },
  handshake: {
    agent: { type: 'string', required: true, maxLength: 200 },
    task: { type: 'string', required: true, maxLength: 1000 },
    recentMessages: { type: 'array', required: false, maxLength: 100 }
  },
  relate: {
    fromEntity: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+$/, maxLength: 200 },
    toEntity: { type: 'string', required: true, pattern: /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_/-]+$/, maxLength: 200 },
    relationshipType: { type: 'string', required: true, maxLength: 100 },
    createdBy: { type: 'string', required: true, maxLength: 200 },
    properties: { type: 'object', required: false, maxSize: 10000 }
  }
};

function validateField(value: any, schema: any, fieldName: string): string | null {
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

  // String validations
  if (schema.type === 'string') {
    if (schema.maxLength && value.length > schema.maxLength) {
      return `${fieldName} exceeds maximum length of ${schema.maxLength}`;
    }
    if (schema.pattern && !schema.pattern.test(value)) {
      return `${fieldName} has invalid format`;
    }
  }

  // Number validations
  if (schema.type === 'number') {
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

  // Array validations
  if (schema.type === 'array') {
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
        data[fieldName] = (fieldSchema as any).default;
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

    next();
  };
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
