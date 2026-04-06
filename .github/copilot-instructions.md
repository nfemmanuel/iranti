<!-- iranti-rules -->
# Iranti

This project uses Iranti for shared memory. Read `IRANTI.md` for the full protocol.

- Call `mcp__iranti__iranti_handshake` before responding to the first user message.
- If startup hooks are unavailable, do this on the first safe user turn.
- Follow the attend/write/checkpoint protocol in IRANTI.md.
<!-- /iranti-rules -->
