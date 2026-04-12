# Contributing to Iranti

Thanks for your interest. Here's what you need to know.

## Prerequisites

- Node.js 20+
- PostgreSQL with the pgvector extension
- A `.env` file with `DATABASE_URL` pointing at your local Postgres instance

## Getting started

```bash
git clone https://github.com/nfemmanuel/iranti.git
cd iranti
npm install
cp .env.example .env   # edit DATABASE_URL
npm run db:migrate
npm run build
```

## Running tests

```bash
npm test                     # full suite
npm run test:mock-provider   # core MCP smoke tests
npm run test:contracts       # contract compliance checks
```

Most tests require a live Postgres connection. Make sure your `.env` is configured before running them.

## Before opening a PR

- Run `npx tsc --noEmit` and fix any type errors
- Run the test suite and confirm nothing regressed
- Keep the scope tight — one change per PR is easier to review
- Add tests for new behaviour where it makes sense

## What to work on

Check the open issues. Anything labeled `help wanted` is fair game. If you want to work on something bigger, open a discussion first so we can talk through the design before you write code.

## What not to do

- Don't run `npm publish` directly — releases go through GitHub Releases and CI
- Don't commit `.env` or any file containing credentials
