import { getDb } from './client';
import { Prisma } from '../generated/prisma/client';
import { createRelationship } from './relationships';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentProfile {
    agentId: string;
    name: string;
    description: string;
    capabilities: string[];
    model?: string;
    properties?: Record<string, unknown>;
}

export interface AgentStats {
    totalWrites: number;
    totalRejections: number;
    totalEscalations: number;
    avgConfidence: number;
    lastSeen: string;
    isActive: boolean;
}

export interface AgentRecord {
    profile: AgentProfile;
    stats: AgentStats;
}

// ─── Register ────────────────────────────────────────────────────────────────

export async function registerAgent(profile: AgentProfile): Promise<void> {
    const store = {
        ...profile,
        registeredAt: new Date().toISOString(),
    };

    await getDb().knowledgeEntry.upsert({
        where: {
            entityType_entityId_key: {
                entityType: 'agent',
                entityId: profile.agentId,
                key: 'profile',
            },
        },
        update: {
            valueRaw: store as unknown as Prisma.InputJsonValue,
            valueSummary: `Agent ${profile.name}: ${profile.description}`,
            updatedAt: new Date(),
        },
        create: {
            entityType: 'agent',
            entityId: profile.agentId,
            key: 'profile',
            valueRaw: store as unknown as Prisma.InputJsonValue,
            valueSummary: `Agent ${profile.name}: ${profile.description}`,
            confidence: 100,
            source: 'registry',
            createdBy: 'system',
            isProtected: false,
            conflictLog: [],
        },
    });

    // Initialize stats
    await initStats(profile.agentId);
}

// ─── Stats ───────────────────────────────────────────────────────────────────

async function initStats(agentId: string): Promise<void> {
    const existing = await getDb().knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: {
                entityType: 'agent',
                entityId: agentId,
                key: 'stats',
            },
        },
    });

    if (existing) return;

    const stats: AgentStats = {
        totalWrites: 0,
        totalRejections: 0,
        totalEscalations: 0,
        avgConfidence: 0,
        lastSeen: new Date().toISOString(),
        isActive: true,
    };

    await getDb().knowledgeEntry.create({
        data: {
            entityType: 'agent',
            entityId: agentId,
            key: 'stats',
            valueRaw: stats as unknown as Prisma.InputJsonValue,
            valueSummary: `Stats for agent ${agentId}`,
            confidence: 100,
            source: 'registry',
            createdBy: 'system',
            isProtected: false,
            conflictLog: [],
        },
    });
}

export async function updateStats(
    agentId: string,
    action: 'created' | 'updated' | 'rejected' | 'escalated',
    confidence: number
): Promise<void> {
    const entry = await getDb().knowledgeEntry.findUnique({
        where: {
            entityType_entityId_key: {
                entityType: 'agent',
                entityId: agentId,
                key: 'stats',
            },
        },
    });

    // Auto-init stats if agent isn't formally registered
    if (!entry) {
        await initStats(agentId);
        return updateStats(agentId, action, confidence);
    }

    const stats = entry.valueRaw as unknown as AgentStats;

    if (action === 'created' || action === 'updated') {
        stats.totalWrites++;
        stats.avgConfidence = Math.round(
            (stats.avgConfidence * (stats.totalWrites - 1) + confidence) / stats.totalWrites
        );
    } else if (action === 'rejected') {
        stats.totalRejections++;
    } else if (action === 'escalated') {
        stats.totalEscalations++;
    }

    stats.lastSeen = new Date().toISOString();
    stats.isActive = true;

    await getDb().knowledgeEntry.update({
        where: {
            entityType_entityId_key: {
                entityType: 'agent',
                entityId: agentId,
                key: 'stats',
            },
        },
        data: {
            valueRaw: stats as unknown as Prisma.InputJsonValue,
            updatedAt: new Date(),
        },
    });
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function getAgent(agentId: string): Promise<AgentRecord | null> {
    const [profileEntry, statsEntry] = await Promise.all([
        getDb().knowledgeEntry.findUnique({
            where: {
                entityType_entityId_key: {
                    entityType: 'agent',
                    entityId: agentId,
                    key: 'profile',
                },
            },
        }),
        getDb().knowledgeEntry.findUnique({
            where: {
                entityType_entityId_key: {
                    entityType: 'agent',
                    entityId: agentId,
                    key: 'stats',
                },
            },
        }),
    ]);

    if (!profileEntry || !statsEntry) return null;

    return {
        profile: profileEntry.valueRaw as unknown as AgentProfile,
        stats: statsEntry.valueRaw as unknown as AgentStats,
    };
}

export async function whoKnows(
    entityType: string,
    entityId: string
): Promise<Array<{ agentId: string; keys: string[]; totalContributions: number }>> {
    const entries = await getDb().knowledgeEntry.findMany({
        where: {
            entityType,
            entityId,
            createdBy: { not: 'system' },
        },
        select: {
            createdBy: true,
            key: true,
        },
    });

    const agentMap = new Map<string, string[]>();
    for (const entry of entries) {
        const existing = agentMap.get(entry.createdBy) ?? [];
        existing.push(entry.key);
        agentMap.set(entry.createdBy, existing);
    }

    return Array.from(agentMap.entries()).map(([agentId, keys]) => ({
        agentId,
        keys,
        totalContributions: keys.length,
    }));
}

export async function listAgents(): Promise<AgentProfile[]> {
    const entries = await getDb().knowledgeEntry.findMany({
        where: {
            entityType: 'agent',
            key: 'profile',
        },
    });

    return entries.map((e: any) => e.valueRaw as unknown as AgentProfile);
}

// ─── Team Relationships ──────────────────────────────────────────────────────

export async function assignToTeam(
    agentId: string,
    teamId: string,
    createdBy: string
): Promise<void> {
    await createRelationship({
        fromType: 'agent',
        fromId: agentId,
        relationshipType: 'MEMBER_OF',
        toType: 'team',
        toId: teamId,
        createdBy,
    });
}
