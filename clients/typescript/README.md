# `@iranti/sdk`

TypeScript HTTP client for the Iranti REST API.

## Install

```bash
npm install @iranti/sdk
```

## Constructor

```ts
import { IrantiClient } from '@iranti/sdk';

const client = new IrantiClient({
  baseUrl: 'http://localhost:3001',
  apiKey: 'keyId.secret',
  timeout: 30_000,
});
```

## Knowledge Base

```ts
await client.write({
  entity: 'researcher/jane_smith',
  key: 'affiliation',
  value: { institution: 'MIT' },
  summary: 'Affiliated with MIT.',
  confidence: 85,
  source: 'OpenAlex',
  agent: 'research_agent',
});

const fact = await client.query('researcher/jane_smith', 'affiliation');
```

## Memory

```ts
const brief = await client.handshake({
  agent: 'research_agent',
  task: 'Research publication history',
  recentMessages: ['Starting OpenAlex pass.'],
});

const turn = await client.attend({
  agentId: 'research_agent',
  currentContext: 'User: What did we decide about budget?\nAssistant:',
  latestMessage: 'What did we decide about budget?',
});
```

## Graph

```ts
await client.relate({
  fromEntity: 'researcher/jane_smith',
  relationshipType: 'MEMBER_OF',
  toEntity: 'lab/csail',
  createdBy: 'research_agent',
});

const related = await client.related('researcher/jane_smith');
```

Main project docs: [Iranti README](../../README.md)
