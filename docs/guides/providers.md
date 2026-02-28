# LLM Providers Guide — Configure models for Iranti

Complete guide to setting up and configuring LLM providers in Iranti.

---

## Overview

Iranti routes different tasks to different models. You can use:
- **Mock provider** — Hardcoded responses for local development (no API key needed)
- **Real providers** — Gemini, Claude, OpenAI, Groq, Mistral, Ollama

Switch providers by changing one environment variable. No code changes required.

---

## Provider Configuration

Set `LLM_PROVIDER` in `.env`:

```env
LLM_PROVIDER=gemini  # or claude, openai, groq, mistral, ollama, mock
```

Each provider has its own configuration variables.

---

## Mock Provider

**Use for:** Local development, testing, CI/CD

**Setup:**

```env
LLM_PROVIDER=mock
```

No API key needed. Returns deterministic responses for all task types.

**Scenarios:**

The mock provider supports different test scenarios:

```typescript
import { Iranti } from './src/sdk';

const iranti = new Iranti({ llmProvider: 'mock' });

// Configure scenario
iranti.configureMock({
    scenario: 'disagreement',  // or 'default', 'unreliable', 'collaborative', 'noisy'
    seed: 123,                 // For reproducible randomization
    failureRate: 0.1,          // 10% chance of simulated failure
});
```

**Scenarios:**
- `default` — Standard deterministic responses
- `disagreement` — Agents produce conflicting facts, escalates 30% of conflicts
- `unreliable` — Occasional failures, tests error handling
- `collaborative` — Agents build on each other's findings
- `noisy` — Mix of relevant and irrelevant responses

**When to use:** Always use mock for local development and automated tests. Switch to real providers only when you need actual LLM reasoning.

---

## Google Gemini

**Use for:** Production deployments, best balance of cost and quality

**Setup:**

1. Get an API key from [Google AI Studio](https://makersuite.google.com/app/apikey)

2. Configure in `.env`:

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.0-flash-001
```

**Available models:**
- `gemini-2.0-flash-001` — Fast, cheap, good for most tasks
- `gemini-2.5-pro` — Slower, more expensive, better reasoning (use for conflict resolution)
- `gemini-1.5-pro` — Previous generation, still capable

**Recommended configuration:**

```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_key_here

# Use flash for fast tasks
CLASSIFICATION_MODEL=gemini-2.0-flash-001
RELEVANCE_MODEL=gemini-2.0-flash-001
SUMMARIZATION_MODEL=gemini-2.0-flash-001
TASK_INFERENCE_MODEL=gemini-2.0-flash-001
EXTRACTION_MODEL=gemini-2.0-flash-001

# Use pro for reasoning tasks
CONFLICT_MODEL=gemini-2.5-pro
```

**Cost:** ~$0.15 per 1M input tokens (flash), ~$1.25 per 1M input tokens (pro)

**Rate limits:** 1,500 requests per minute (free tier), 10,000 RPM (paid)

---

## Anthropic Claude

**Use for:** Complex reasoning, long context windows

**Setup:**

1. Get an API key from [Anthropic Console](https://console.anthropic.com/)

2. Configure in `.env`:

```env
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=your_key_here
```

**Available models:**
- `claude-opus-4` — Most capable, expensive
- `claude-sonnet-4` — Balanced
- `claude-haiku-4` — Fast, cheap

**Note:** Claude provider is currently a stub. Full implementation coming soon. Use Gemini or OpenAI for now.

**Cost:** ~$3 per 1M input tokens (Haiku), ~$15 per 1M (Opus)

**Rate limits:** Varies by tier, typically 50-100 RPM

---

## OpenAI

**Use for:** GPT-4 reasoning, wide model selection

**Setup:**

1. Get an API key from [OpenAI Platform](https://platform.openai.com/api-keys)

2. Configure in `.env`:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

**Available models:**
- `gpt-4o-mini` — Fast, cheap, good for most tasks
- `gpt-4o` — More capable, more expensive
- `gpt-4-turbo` — Previous generation
- `gpt-3.5-turbo` — Cheapest, least capable

**Recommended configuration:**

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=your_key_here

# Use mini for fast tasks
CLASSIFICATION_MODEL=gpt-4o-mini
RELEVANCE_MODEL=gpt-4o-mini
SUMMARIZATION_MODEL=gpt-4o-mini
TASK_INFERENCE_MODEL=gpt-4o-mini
EXTRACTION_MODEL=gpt-4o-mini

# Use full gpt-4o for reasoning
CONFLICT_MODEL=gpt-4o
```

**OpenAI-compatible APIs:**

The OpenAI provider works with any OpenAI-compatible API. Change `OPENAI_BASE_URL`:

```env
# Azure OpenAI
OPENAI_BASE_URL=https://your-resource.openai.azure.com/openai/deployments/your-deployment

# Together AI
OPENAI_BASE_URL=https://api.together.xyz/v1

# Anyscale
OPENAI_BASE_URL=https://api.endpoints.anyscale.com/v1
```

**Cost:** ~$0.15 per 1M input tokens (mini), ~$2.50 per 1M (gpt-4o)

**Rate limits:** 500 RPM (tier 1), 5,000 RPM (tier 5)

---

## Groq

**Use for:** Ultra-fast inference, open models

**Setup:**

1. Get an API key from [Groq Console](https://console.groq.com/)

2. Configure in `.env`:

```env
LLM_PROVIDER=groq
GROQ_API_KEY=your_key_here
GROQ_MODEL=llama-3.3-70b-versatile
```

**Available models:**
- `llama-3.3-70b-versatile` — Best balance
- `llama-3.1-70b-versatile` — Previous generation
- `mixtral-8x7b-32768` — Good for long context
- `gemma-7b-it` — Smallest, fastest

**Why Groq:** Extremely fast inference (500+ tokens/sec) at low cost. Great for high-throughput applications.

**Cost:** Free tier available, paid plans start at $0.05 per 1M tokens

**Rate limits:** 30 RPM (free), 6,000 RPM (paid)

---

## Mistral AI

**Use for:** European data residency, open models

**Setup:**

1. Get an API key from [Mistral Console](https://console.mistral.ai/)

2. Configure in `.env`:

```env
LLM_PROVIDER=mistral
MISTRAL_API_KEY=your_key_here
MISTRAL_MODEL=mistral-small-latest
```

**Available models:**
- `mistral-small-latest` — Fast, cheap
- `mistral-medium-latest` — Balanced
- `mistral-large-latest` — Most capable

**Why Mistral:** European company, GDPR-compliant, good for EU deployments.

**Cost:** ~$0.10 per 1M input tokens (small), ~$2 per 1M (large)

**Rate limits:** Varies by plan

---

## Ollama (Local)

**Use for:** Fully local deployment, no API costs, data privacy

**Setup:**

1. Install Ollama from [ollama.ai](https://ollama.ai/)

2. Pull a model:

```bash
ollama pull llama3.2
```

3. Start Ollama server:

```bash
ollama serve
```

4. Configure in `.env`:

```env
LLM_PROVIDER=ollama
OLLAMA_MODEL=llama3.2
OLLAMA_BASE_URL=http://localhost:11434
```

**Available models:**
- `llama3.2` — Meta's latest, 3B params
- `llama3.1` — Previous generation, 8B params
- `mistral` — Mistral 7B
- `phi3` — Microsoft's small model
- `qwen2.5` — Alibaba's model

**Why Ollama:** 
- No API costs
- Complete data privacy
- Works offline
- Good for development

**Performance:** Depends on your hardware. Expect 10-50 tokens/sec on consumer GPUs.

**When to use:** Local development, sensitive data, cost optimization, offline deployments.

---

## Fallback Chain

Configure automatic fallback if the primary provider fails:

```env
LLM_PROVIDER=gemini
LLM_PROVIDER_FALLBACK=openai,groq,mistral,mock
```

Iranti tries providers in order:
1. Gemini (primary)
2. OpenAI (first fallback)
3. Groq (second fallback)
4. Mistral (third fallback)
5. Mock (always added as final safety net)

**When a fallback is used:**

```
[router] Primary provider failed. Used fallback: openai
```

**Use cases:**
- **High availability** — If Gemini is down, fall back to OpenAI
- **Rate limit handling** — If you hit rate limits, try another provider
- **Cost optimization** — Try cheap provider first, fall back to expensive if needed

**Example configuration:**

```env
# Try Groq first (fast and cheap)
LLM_PROVIDER=groq
GROQ_API_KEY=your_groq_key

# Fall back to OpenAI if Groq fails
LLM_PROVIDER_FALLBACK=openai,mock
OPENAI_API_KEY=your_openai_key
```

---

## Task-Specific Model Routing

Override models for specific task types:

```env
# Primary provider
LLM_PROVIDER=gemini
GEMINI_API_KEY=your_key_here

# Fast tasks use flash
CLASSIFICATION_MODEL=gemini-2.0-flash-001
RELEVANCE_MODEL=gemini-2.0-flash-001
SUMMARIZATION_MODEL=gemini-2.0-flash-001
TASK_INFERENCE_MODEL=gemini-2.0-flash-001
EXTRACTION_MODEL=gemini-2.0-flash-001

# Reasoning tasks use pro
CONFLICT_MODEL=gemini-2.5-pro
```

**Task types:**

| Task Type | What It Does | Recommended Model |
|---|---|---|
| `classification` | Simple yes/no decisions | Fast model (flash, mini) |
| `relevance_filtering` | Filter knowledge for working memory | Fast model |
| `conflict_resolution` | Reason about contradicting facts | Capable model (pro, gpt-4o) |
| `summarization` | Compress knowledge for briefs | Fast model |
| `task_inference` | Infer what agent is doing | Fast model |
| `extraction` | Extract atomic facts from text | Fast model with structured output |

**Cost optimization strategy:**

Use cheap models for everything except conflict resolution:

```env
LLM_PROVIDER=openai

# Cheap for most tasks
CLASSIFICATION_MODEL=gpt-4o-mini
RELEVANCE_MODEL=gpt-4o-mini
SUMMARIZATION_MODEL=gpt-4o-mini
TASK_INFERENCE_MODEL=gpt-4o-mini
EXTRACTION_MODEL=gpt-4o-mini

# Expensive only for reasoning
CONFLICT_MODEL=gpt-4o
```

This reduces costs by 80-90% while maintaining quality where it matters.

---

## When to Use Which Provider

### Development
- **Mock** — Always use for local dev and tests
- **Ollama** — If you want to test with real models locally

### Production (Low Budget)
- **Groq** — Fastest and cheapest for high throughput
- **Gemini Flash** — Good balance of cost and quality
- **OpenAI Mini** — If you're already on OpenAI

### Production (High Quality)
- **Gemini Pro** — Best balance of cost and capability
- **OpenAI GPT-4o** — If you need the best reasoning
- **Claude Opus** — For complex reasoning and long context

### Production (Special Requirements)
- **Mistral** — EU data residency, GDPR compliance
- **Ollama** — Complete data privacy, offline operation
- **Azure OpenAI** — Enterprise compliance, SLAs

---

## Cost Comparison

Approximate costs per 1M input tokens:

| Provider | Model | Cost | Speed | Quality |
|---|---|---|---|---|
| Mock | N/A | $0 | Instant | N/A |
| Ollama | llama3.2 | $0 | Medium | Good |
| Groq | llama-3.3-70b | $0.05 | Very Fast | Good |
| Gemini | flash-001 | $0.15 | Fast | Good |
| OpenAI | gpt-4o-mini | $0.15 | Fast | Good |
| Mistral | small | $0.10 | Fast | Good |
| Gemini | 2.5-pro | $1.25 | Medium | Excellent |
| OpenAI | gpt-4o | $2.50 | Medium | Excellent |
| Claude | opus-4 | $15.00 | Slow | Excellent |

**Typical monthly costs for a production deployment:**

- **Small** (1,000 writes/day): $5-20/month
- **Medium** (10,000 writes/day): $50-200/month
- **Large** (100,000 writes/day): $500-2,000/month

Most cost comes from conflict resolution. Optimize by:
1. Using cheap models for non-reasoning tasks
2. Increasing confidence gap threshold (fewer LLM resolutions)
3. Using Groq or Gemini Flash instead of GPT-4

---

## Testing Your Configuration

After configuring a provider, test it:

```bash
npm run test:integration
```

Or test manually:

```typescript
import { Iranti } from './src/sdk';

async function test() {
    const iranti = new Iranti({
        llmProvider: process.env.LLM_PROVIDER,
    });

    // This will use the configured provider
    const result = await iranti.ingest({
        entity: 'test/entity',
        content: 'Test content with facts to extract.',
        source: 'Test',
        confidence: 80,
        agent: 'test_agent',
    });

    console.log('Provider working:', result.written > 0);
}

test();
```

---

## Troubleshooting

### API key not working

```
Error: Invalid API key
```

**Solution:** Check that your API key is correct and has not expired. Test it directly:

```bash
# Gemini
curl "https://generativelanguage.googleapis.com/v1/models?key=YOUR_KEY"

# OpenAI
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer YOUR_KEY"
```

### Rate limit exceeded

```
Error: Rate limit exceeded
```

**Solution:** 
1. Add a fallback provider
2. Implement exponential backoff
3. Upgrade to a higher tier
4. Use a cheaper provider for non-critical tasks

### Model not found

```
Error: Model 'xyz' not found
```

**Solution:** Check that the model name is correct. List available models:

```bash
# Gemini
curl "https://generativelanguage.googleapis.com/v1/models?key=YOUR_KEY"

# OpenAI
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer YOUR_KEY"
```

### Ollama connection refused

```
Error: Could not connect to Ollama at http://localhost:11434
```

**Solution:** Make sure Ollama is running:

```bash
ollama serve
```

---

## Next Steps

- **[Quickstart Guide](./quickstart.md)** — Set up Iranti
- **[Conflict Resolution Guide](./conflict-resolution.md)** — Understand how LLMs are used for reasoning
- **[Python Client Guide](./python-client.md)** — Use Iranti from Python

---

## Provider Comparison Matrix

| Feature | Mock | Gemini | OpenAI | Groq | Mistral | Ollama |
|---|---|---|---|---|---|---|
| Cost | Free | Low | Medium | Low | Low | Free |
| Speed | Instant | Fast | Fast | Very Fast | Fast | Medium |
| Quality | N/A | Excellent | Excellent | Good | Good | Good |
| API Key | No | Yes | Yes | Yes | Yes | No |
| Local | Yes | No | No | No | No | Yes |
| Offline | Yes | No | No | No | No | Yes |
| EU Hosting | N/A | No | No | No | Yes | Yes |
| Rate Limits | None | High | Medium | Medium | Medium | None |
| Best For | Dev/Test | Production | Production | High Throughput | EU Compliance | Privacy |
