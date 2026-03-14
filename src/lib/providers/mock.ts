import { LLMProvider, LLMMessage, LLMResponse, CompleteOptions } from '../llm';

// ─── Scenario Types ───────────────────────────────────────────────────────────

export type MockScenario =
    | 'default'          // Current behavior — deterministic responses
    | 'disagreement'     // Agents produce conflicting facts
    | 'unreliable'       // Occasional failures and low confidence
    | 'collaborative'    // Agents build on each other's findings
    | 'noisy';           // Mix of relevant and irrelevant responses

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MockConfig {
    scenario: MockScenario;
    agentId?: string;          // Different agents get different responses
    failureRate?: number;      // 0-1, probability of simulated failure
    confidenceRange?: [number, number];  // Min/max confidence for randomization
    seed?: number;             // For reproducible randomization
}

// ─── Seeded Random ────────────────────────────────────────────────────────────

function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0xffffffff;
    };
}

// ─── Response Banks ───────────────────────────────────────────────────────────

const TASK_INFERENCES: Record<string, string[]> = {
    default: [
        'Researching academic publication history for a researcher',
        'Analyzing citation patterns across research institutions',
        'Mapping collaboration networks between research groups',
    ],
    disagreement: [
        'Independently verifying researcher affiliations',
        'Cross-referencing conflicting institutional records',
    ],
    collaborative: [
        'Building on prior findings about researcher profiles',
        'Extending existing knowledge base with new data points',
    ],
    noisy: [
        'Researching academic publication history for a researcher',
        'Performing general web research',
        'Analyzing unstructured data sources',
        'Unclear task type',
    ],
};

const CONFLICT_RESOLUTIONS = {
    KEEP_EXISTING: 'KEEP_EXISTING: The existing entry has a more established source and the confidence difference is minimal.',
    KEEP_INCOMING: 'KEEP_INCOMING: The incoming entry cites a more authoritative and recent source.',
    ESCALATE: 'ESCALATE: Both sources have comparable authority and the values are genuinely contradictory.',
};

const EXTRACTION_RESPONSES: Record<string, string> = {
    default: '[{"key":"affiliation","value":{"institution":"Carnegie Mellon University"},"summary":"Affiliated with Carnegie Mellon University.","confidence":95},{"key":"publication_count","value":{"count":31},"summary":"Has published 31 papers.","confidence":93},{"key":"previous_employer","value":{"institution":"Google DeepMind","from":2019,"to":2022},"summary":"Previously worked at Google DeepMind from 2019 to 2022.","confidence":91},{"key":"research_focus","value":{"primary":"reinforcement learning","secondary":"robotics"},"summary":"Primary research focus is reinforcement learning with secondary interest in robotics.","confidence":88}]',
    disagreement: '[{"key":"affiliation","value":{"institution":"MIT"},"summary":"Affiliated with MIT.","confidence":86},{"key":"publication_count","value":{"count":28},"summary":"Has published 28 papers.","confidence":82}]',
    collaborative: '[{"key":"h_index","value":{"score":12},"summary":"H-index of 12.","confidence":84},{"key":"cited_by","value":{"count":450},"summary":"Cited by 450 papers.","confidence":83}]',
};

// ─── Mock Provider ────────────────────────────────────────────────────────────

class MockProvider implements LLMProvider {
    private config: MockConfig;
    private rand: () => number;
    private callCount: number = 0;

    constructor(config: MockConfig = { scenario: 'default' }) {
        this.config = config;
        this.rand = seededRandom(config.seed ?? 42);
    }

    configure(config: Partial<MockConfig>): void {
        Object.assign(this.config, config);
        this.rand = seededRandom(this.config.seed ?? 42);
        this.callCount = 0;
    }

    async complete(messages: LLMMessage[], options?: CompleteOptions): Promise<LLMResponse> {
        this.callCount++;
        const lastMessage = messages[messages.length - 1].content.toLowerCase();
        const scenario = this.config.scenario;
        const model = options?.model ?? 'mock';

        // Simulate failure rate
        const failureRate = this.config.failureRate ?? 0;
        if (failureRate > 0 && this.rand() < failureRate) {
            throw new Error(`[mock] Simulated provider failure (rate: ${failureRate})`);
        }

        // Task inference
        if (lastMessage.includes('specific type of task')) {
            const options = TASK_INFERENCES[scenario] ?? TASK_INFERENCES.default;
            const idx = Math.floor(this.rand() * options.length);
            return this.respond(options[idx], model);
        }

        // Relevance filtering
        if (lastMessage.includes('directly relevant')) {
            if (scenario === 'noisy') {
                // Sometimes return nothing relevant
                return this.respond(this.rand() > 0.5 ? 'none' : '1,2', model);
            }
            return this.respond('none', model);
        }

        // Conflict resolution
        if (lastMessage.includes('genuinely contradictory') || lastMessage.includes('keep_existing')) {
            if (scenario === 'disagreement') {
                // Disagreement scenario escalates more
                const r = this.rand();
                if (r < 0.4) return this.respond(CONFLICT_RESOLUTIONS.KEEP_EXISTING, model);
                if (r < 0.7) return this.respond(CONFLICT_RESOLUTIONS.KEEP_INCOMING, model);
                return this.respond(CONFLICT_RESOLUTIONS.ESCALATE, model);
            }
            return this.respond(CONFLICT_RESOLUTIONS.KEEP_EXISTING, model);
        }

        // Extraction / chunking
        if (
            lastMessage.includes('extract only distinct facts')
            || lastMessage.includes('extract every distinct')
            || lastMessage.includes('extracting structured facts')
            || lastMessage.includes('atomic facts')
        ) {
            if (lastMessage.includes('avalon spectrum currently operates in lisbon')) {
                return this.respond(
                    '[{"key":"hq_city","value":{"city":"Lisbon"},"summary":"Headquartered in Lisbon.","confidence":96},{"key":"team_size","value":{"count":42},"summary":"Team size is 42.","confidence":95},{"key":"runway_months","value":{"months":18},"summary":"Runway is 18 months.","confidence":93}]',
                    model
                );
            }
            if (lastMessage.includes('might be preparing for a beta launch') || lastMessage.includes('possibly exploring a seed extension')) {
                return this.respond(
                    '[{"key":"launch_phase","value":{"phase":"beta"},"summary":"Possibly preparing for a beta launch.","confidence":42},{"key":"fundraising_plan","value":{"type":"seed_extension"},"summary":"May be exploring a seed extension.","confidence":34}]',
                    model
                );
            }
            if (lastMessage.includes('helios array has 12 pilots') || lastMessage.includes('could be expanding into ocean freight')) {
                return this.respond(
                    '[{"key":"pilot_count","value":{"count":12},"summary":"Pilot count is 12.","confidence":95},{"key":"expansion_target","value":{"market":"ocean_freight"},"summary":"May expand into ocean freight.","confidence":38}]',
                    model
                );
            }
            if (lastMessage.includes('rain over the harbor looked dramatic') || lastMessage.includes('no durable facts')) {
                return this.respond('[]', model);
            }
            if (lastMessage.includes('northwind lattice has a budget of 50000')) {
                return this.respond(
                    '[{"key":"budget","value":{"amount":50000,"currency":"USD"},"summary":"Budget is 50,000 USD.","confidence":95}]',
                    model
                );
            }
            if (lastMessage.includes('northwind lattice has a budget of 75000')) {
                return this.respond(
                    '[{"key":"budget","value":{"amount":75000,"currency":"USD"},"summary":"Budget is 75,000 USD.","confidence":91}]',
                    model
                );
            }
            const response = EXTRACTION_RESPONSES[scenario] ?? EXTRACTION_RESPONSES.default;
            return this.respond(response, model);
        }

        // Summarization
        if (lastMessage.includes('compress') || lastMessage.includes('summarize')) {
            return this.respond('Compressed working memory summary for current task context.', model);
        }

        // Default — generic agent response
        return this.respond(
            `I have completed my analysis. Based on my research:\n\n` +
            `{\n` +
            `  "name": "Sample Researcher",\n` +
            `  "affiliation": "MIT",\n` +
            `  "publication_count": 45,\n` +
            `  "research_focus": "machine learning",\n` +
            `  "notable_contribution": "Foundational work in neural networks",\n` +
            `  "confidence": 85\n` +
            `}`,
            model
        );
    }

    private respond(text: string, model: string = 'mock'): LLMResponse {
        return { text, model, provider: 'mock' };
    }

    getCallCount(): number {
        return this.callCount;
    }

    resetCallCount(): void {
        this.callCount = 0;
    }
}

// ─── Singleton + Config Export ────────────────────────────────────────────────

const mockProvider = new MockProvider();

export function configureMock(config: Partial<MockConfig>): void {
    mockProvider.configure(config);
}

export default mockProvider;
