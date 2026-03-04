# Security Quickstart

This guide covers the minimum security baseline for running Iranti in real environments.

## 1) Use per-app keys, not one shared key

Create one key per app, bot, or service identity:

```bash
npm run api-key:create -- --key-id chatbot_prod --owner "Chatbot Production" --scopes "kb:read,kb:write,memory:read,memory:write,agents:read,agents:write,metrics:read"
```

Why:
- easy revocation for one compromised client
- per-client auditability
- least-privilege scopes

## 2) Scope keys narrowly

Prefer minimum scopes required:

- chatbot runtime: `kb:read,kb:write,memory:read,memory:write`
- agent registry admin: `agents:read,agents:write`
- observability-only: `metrics:read`
- compatibility proxy usage: `proxy:chat`
- internal admin only: `system:admin`

## 3) Rotate keys on exposure

If a token appears in logs, screenshots, terminals, or chat:

1. rotate with same `key-id`:

```bash
npm run api-key:create -- --key-id chatbot_prod --owner "Chatbot Production" --scopes "kb:read,kb:write,memory:read,memory:write"
```

2. update all clients with new token
3. remove old token from env files and CI secrets

## 4) Keep Iranti private by default

- bind API to internal network when possible
- place behind reverse proxy + TLS for non-local use
- avoid exposing raw port 3001/3101 publicly

## 5) Set escalation/log locations outside repo

Use local machine paths for runtime artifacts:

```env
IRANTI_ESCALATION_DIR=C:/Users/<you>/.iranti/escalation
IRANTI_REQUEST_LOG_FILE=C:/Users/<you>/.iranti/logs/api-requests.log
```

This keeps sensitive conflict artifacts and logs out of source control.

## 6) Add basic operational controls

- set rate limits:
  - `RATE_LIMIT_WINDOW_MS`
  - `RATE_LIMIT_MAX_REQUESTS`
- monitor `/metrics`
- alert on repeated 401/403/429 responses

## 7) Production checklist

- [ ] No placeholder API keys in `.env`
- [ ] Per-service scoped keys
- [ ] Key rotation process documented
- [ ] TLS/ingress configured
- [ ] Runtime logs and escalation path outside repo
- [ ] Backups for PostgreSQL configured
- [ ] Recovery test performed at least once
