# Browser Extension - Not Viable

## Issue

Both ChatGPT and Claude block content script injection via Content Security Policy (CSP):

```
Executing inline script violates the following Content Security Policy directive 'script-src 'self' 'wasm-unsafe-eval'...
```

Content scripts cannot inject code into the page context, and therefore cannot intercept fetch() calls to modify API requests.

## Tested

- ChatGPT: ❌ Blocked by CSP
- Claude: ❌ Blocked by CSP

## Alternative: API Middleware

Use Python middleware to wrap API calls instead:

```python
from clients.middleware.iranti_middleware import IrantiMiddleware

middleware = IrantiMiddleware(agent_id="my_agent", iranti_url="http://localhost:3001")

# Wrap your OpenAI/Anthropic API calls
augmented = middleware.before_send(user_message="...", conversation_history=[...])
# Send augmented message to API
# ...
middleware.after_receive(response="...", conversation_history=[...])
```

See `clients/middleware/claude_example.py` for working implementation.

## Conclusion

Browser extensions are not viable for ChatGPT/Claude integration. Focus on:
1. **Agent-to-agent memory** (validated, works perfectly)
2. **API middleware** (works, requires API keys)
3. **Custom chat interfaces** (full control, no CSP restrictions)
