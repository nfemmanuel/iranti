export interface ScopeNamespace {
    entityType: string;
    entityId: string;
    raw: string;
}

export interface ParsedScope {
    raw: string;
    resource: string;
    action: string;
    namespace?: ScopeNamespace;
    isWildcardAll: boolean;
}

export interface EntityScopeDecision {
    allowed: boolean;
    reason: string;
    matchedScope?: string;
}

function normalizeScopeToken(value: string): string {
    return value.trim().toLowerCase();
}

function parseNamespace(rawNamespace: string): ScopeNamespace {
    const namespace = rawNamespace.trim();
    if (!namespace) {
        throw new Error('namespace cannot be empty');
    }

    const parts = namespace.split('/');
    if (parts.length !== 2) {
        throw new Error(`namespace "${rawNamespace}" must be exactly "entityType/entityId" or "entityType/*"`);
    }

    const [entityTypeRaw, entityIdRaw] = parts;
    const entityType = entityTypeRaw.trim();
    const entityId = entityIdRaw.trim();

    if (!entityType || !entityId) {
        throw new Error(`namespace "${rawNamespace}" must include both entityType and entityId`);
    }

    if (entityType === '*' && entityId !== '*') {
        throw new Error(`namespace "${rawNamespace}" cannot use wildcard entityType with a specific entityId`);
    }

    return {
        entityType,
        entityId,
        raw: `${entityType}/${entityId}`,
    };
}

export function parseScope(rawScope: string): ParsedScope {
    const raw = rawScope.trim();
    if (!raw) {
        throw new Error('scope cannot be empty');
    }

    if (raw === '*') {
        return {
            raw,
            resource: '*',
            action: '*',
            isWildcardAll: true,
        };
    }

    const parts = raw.split(':');
    if (parts.length < 2 || parts.length > 3) {
        throw new Error(`scope "${rawScope}" must be "resource:action" or "resource:action:entityType/entityId"`);
    }

    const resource = normalizeScopeToken(parts[0]);
    const action = normalizeScopeToken(parts[1]);
    if (!resource || !action) {
        throw new Error(`scope "${rawScope}" must include both resource and action`);
    }

    const namespace = parts.length === 3 ? parseNamespace(parts[2]) : undefined;

    return {
        raw,
        resource,
        action,
        namespace,
        isWildcardAll: false,
    };
}

export function validateScopeList(scopes: string[]): void {
    for (const scope of scopes) {
        try {
            parseScope(scope);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid scope "${scope}": ${message}`);
        }
    }
}

function normalizeEntityNamespace(entityType: string, entityId: string): ScopeNamespace {
    return {
        entityType: entityType.trim(),
        entityId: entityId.trim(),
        raw: `${entityType.trim()}/${entityId.trim()}`,
    };
}

function actionAllows(granted: ParsedScope, requiredAction: string): boolean {
    return granted.action === requiredAction || granted.action === '*';
}

function resourceMatches(granted: ParsedScope, requiredResource: string): boolean {
    return granted.resource === requiredResource || granted.resource === '*';
}

function namespaceMatchesExact(granted: ParsedScope, entity: ScopeNamespace): boolean {
    if (!granted.namespace) return false;
    return granted.namespace.entityType === entity.entityType && granted.namespace.entityId === entity.entityId;
}

function namespaceMatchesWildcard(granted: ParsedScope, entity: ScopeNamespace): boolean {
    if (!granted.namespace) return false;
    return granted.namespace.entityType === entity.entityType && granted.namespace.entityId === '*';
}

function scopeGrantsGlobal(granted: ParsedScope, requiredResource: string, requiredAction: string): boolean {
    if (granted.isWildcardAll) return true;
    if (!resourceMatches(granted, requiredResource)) return false;
    if (!actionAllows(granted, requiredAction)) return false;
    return !granted.namespace;
}

export function scopeMatchesFamily(scope: string, requiredScope: string): boolean {
    let granted: ParsedScope;
    let required: ParsedScope;
    try {
        granted = parseScope(scope);
        required = parseScope(requiredScope);
    } catch {
        return false;
    }

    if (granted.isWildcardAll) return true;
    if (!resourceMatches(granted, required.resource)) return false;
    if (!actionAllows(granted, required.action)) return false;
    return true;
}

export function scopeMatchesGlobal(scope: string, requiredScope: string): boolean {
    let granted: ParsedScope;
    let required: ParsedScope;
    try {
        granted = parseScope(scope);
        required = parseScope(requiredScope);
    } catch {
        return false;
    }

    return scopeGrantsGlobal(granted, required.resource, required.action);
}

export function evaluateEntityScopeAccess(
    grantedScopes: string[],
    requiredScope: string,
    entityType: string,
    entityId: string,
): EntityScopeDecision {
    let required: ParsedScope;
    try {
        required = parseScope(requiredScope);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            allowed: false,
            reason: `Authorization misconfiguration: ${message}`,
        };
    }

    const entity = normalizeEntityNamespace(entityType, entityId);
    const parsedScopes = grantedScopes
        .map((scope) => {
            try {
                return parseScope(scope);
            } catch {
                return null;
            }
        })
        .filter((scope): scope is ParsedScope => Boolean(scope));

    const matchingResourceScopes = parsedScopes.filter((scope) => resourceMatches(scope, required.resource));

    const exactDeny = matchingResourceScopes.find((scope) => scope.action === 'deny' && namespaceMatchesExact(scope, entity));
    if (exactDeny) {
        return {
            allowed: false,
            reason: `Explicit deny rule matches entity ${entity.raw}`,
            matchedScope: exactDeny.raw,
        };
    }

    const wildcardDeny = matchingResourceScopes.find((scope) => scope.action === 'deny' && namespaceMatchesWildcard(scope, entity));
    if (wildcardDeny) {
        return {
            allowed: false,
            reason: `Explicit deny rule matches entity ${entity.raw}`,
            matchedScope: wildcardDeny.raw,
        };
    }

    const globalDeny = matchingResourceScopes.find((scope) => scope.action === 'deny' && !scope.namespace);
    if (globalDeny) {
        return {
            allowed: false,
            reason: `Explicit deny rule matches entity ${entity.raw}`,
            matchedScope: globalDeny.raw,
        };
    }

    const exactAllow = matchingResourceScopes.find((scope) => actionAllows(scope, required.action) && namespaceMatchesExact(scope, entity));
    if (exactAllow) {
        return {
            allowed: true,
            reason: `Allowed by namespace scope ${exactAllow.raw}`,
            matchedScope: exactAllow.raw,
        };
    }

    const wildcardAllow = matchingResourceScopes.find((scope) => actionAllows(scope, required.action) && namespaceMatchesWildcard(scope, entity));
    if (wildcardAllow) {
        return {
            allowed: true,
            reason: `Allowed by namespace scope ${wildcardAllow.raw}`,
            matchedScope: wildcardAllow.raw,
        };
    }

    const globalAllow = matchingResourceScopes.find((scope) => scopeGrantsGlobal(scope, required.resource, required.action));
    if (globalAllow) {
        return {
            allowed: true,
            reason: `Allowed by scope ${globalAllow.raw}`,
            matchedScope: globalAllow.raw,
        };
    }

    return {
        allowed: false,
        reason: `Key does not have access to entity namespace ${entity.raw}`,
    };
}
