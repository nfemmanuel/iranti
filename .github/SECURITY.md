# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |

## Reporting a vulnerability

Do not open a public GitHub issue for security vulnerabilities.

Use [GitHub's private security advisory feature](https://github.com/nfemmanuel/iranti/security/advisories/new) to report privately. You'll get a response within 72 hours.

Please include:
- A description of the vulnerability
- Steps to reproduce it
- The potential impact

## Scope

Iranti runs locally and does not phone home except in ICC-provisioned cloud instances. The main attack surfaces are the local Postgres connection and the MCP stdio transport. API key storage and hashing is handled via argon2id.
