# Browser Integration Guide

Add Iranti memory to Claude.ai or ChatGPT in your browser.

---

## Prerequisites

1. **Iranti server running locally**:
   ```bash
   cd iranti
   npm run api  # Runs on http://localhost:3001
   ```

2. **API key configured** in `.env`:
   ```
   IRANTI_API_KEY=your_key_here
   ```

---

## Approach A: Chrome Extension (Recommended)

### Overview

A Chrome extension intercepts fetch() calls to Claude/ChatGPT, calls Iranti's observe() API, and injects forgotten facts into your messages.

### Step 1: Create Extension Files

Create a folder `iranti-extension/` with these files:

**manifest.json**:
```json
{
  "manifest_version": 3,
  "name": "Iranti Memory",
  "version": "1.0",
  "description": "Adds persistent memory to Claude and ChatGPT",
  "permissions": ["storage"],
  "host_permissions": [
    "https://claude.ai/*",
    "https://chat.openai.com/*",
    "http://localhost:3001/*"
  ],
  "content_scripts": [
    {
      "matches": [
        "https://claude.ai/*",
        "https://chat.openai.com/*"
      ],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ]
}
```

**content.js**:
```javascript
// Iranti configuration
const IRANTI_URL = 'http://localhost:3001';
const IRANTI_API_KEY = 'your_key_here';  // Replace with your key
const AGENT_ID = 'browser_assistant';

// Intercept fetch() calls
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const [url, options] = args;
  
  // Detect Claude API call
  if (url.includes('api.anthropic.com/v1/messages') || 
      url.includes('claude.ai/api/organizations')) {
    return await handleClaudeRequest(url, options);
  }
  
  // Detect ChatGPT API call
  if (url.includes('chat.openai.com/backend-api/conversation')) {
    return await handleChatGPTRequest(url, options);
  }
  
  // Pass through other requests
  return originalFetch.apply(this, args);
};

async function handleClaudeRequest(url, options) {
  try {
    const body = JSON.parse(options.body);
    const messages = body.messages || [];
    
    // Get last user message
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) {
      return originalFetch(url, options);
    }
    
    // Build context from conversation
    const context = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    
    // Call Iranti observe()
    const observeResponse = await fetch(`${IRANTI_URL}/observe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Iranti-Key': IRANTI_API_KEY
      },
      body: JSON.stringify({
        agentId: AGENT_ID,
        currentContext: context,
        maxFacts: 5
      })
    });
    
    if (observeResponse.ok) {
      const { facts } = await observeResponse.json();
      
      // Inject facts into last user message
      if (facts && facts.length > 0) {
        const factText = facts.map(f => f.summary).join('; ');
        const originalContent = lastUserMsg.content;
        lastUserMsg.content = `[MEMORY: ${factText}]\n\n${originalContent}`;
        
        // Update request body
        options.body = JSON.stringify(body);
        
        console.log('[Iranti] Injected', facts.length, 'facts');
      }
    }
  } catch (error) {
    console.error('[Iranti] Error:', error);
  }
  
  // Send modified request
  return originalFetch(url, options);
}

async function handleChatGPTRequest(url, options) {
  try {
    const body = JSON.parse(options.body);
    const messages = body.messages || [];
    
    // Get last user message
    const lastUserMsg = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMsg) {
      return originalFetch(url, options);
    }
    
    // Build context
    const context = messages.map(m => 
      `${m.author.role}: ${m.content.parts.join(' ')}`
    ).join('\n');
    
    // Call Iranti observe()
    const observeResponse = await fetch(`${IRANTI_URL}/observe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Iranti-Key': IRANTI_API_KEY
      },
      body: JSON.stringify({
        agentId: AGENT_ID,
        currentContext: context,
        maxFacts: 5
      })
    });
    
    if (observeResponse.ok) {
      const { facts } = await observeResponse.json();
      
      // Inject facts
      if (facts && facts.length > 0) {
        const factText = facts.map(f => f.summary).join('; ');
        const originalContent = lastUserMsg.content.parts[0];
        lastUserMsg.content.parts[0] = `[MEMORY: ${factText}]\n\n${originalContent}`;
        
        options.body = JSON.stringify(body);
        
        console.log('[Iranti] Injected', facts.length, 'facts');
      }
    }
  } catch (error) {
    console.error('[Iranti] Error:', error);
  }
  
  return originalFetch(url, options);
}

console.log('[Iranti] Memory extension loaded');
```

### Step 2: Install Extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `iranti-extension/` folder
5. Extension is now active

### Step 3: Test It

1. Make sure Iranti server is running: `npm run api`
2. Write some facts to Iranti:
   ```python
   from clients.python.iranti import IrantiClient
   
   client = IrantiClient(base_url="http://localhost:3001")
   client.write(
       entity="project/test_project",
       key="status",
       value={"data": "Phase 2 complete"},
       summary="status: Phase 2 complete",
       confidence=90,
       source="manual",
       agent="browser_assistant"
   )
   ```

3. Go to claude.ai or chat.openai.com
4. Start a conversation mentioning "test_project"
5. After several turns, ask "What's the status of test_project?"
6. Open browser console (F12) - you should see `[Iranti] Injected N facts`
7. Claude/ChatGPT should answer correctly using the injected fact

### Limitations

- **Streaming responses**: The extension only handles the request (before_send). It doesn't extract facts from streaming responses (after_receive). To add that, you'd need to intercept the response stream and parse it.
- **CORS**: The extension needs `host_permissions` for localhost. If Iranti is on a different domain, add that domain to `host_permissions`.
- **API changes**: If Claude/ChatGPT change their API structure, the extension will need updates.

---

## Approach B: Local Proxy

### Overview

Run a local Flask proxy that intercepts all HTTP traffic to Claude/ChatGPT and injects Iranti memory.

### Step 1: Install Dependencies

```bash
pip install flask flask-cors requests
```

### Step 2: Create Proxy Server

**iranti_proxy.py**:
```python
from flask import Flask, request, Response
import requests
import json

app = Flask(__name__)

IRANTI_URL = "http://localhost:3001"
IRANTI_API_KEY = "your_key_here"
AGENT_ID = "proxy_assistant"

@app.route('/<path:path>', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
def proxy(path):
    # Determine target
    if 'anthropic.com' in request.host:
        target_url = f"https://api.anthropic.com/{path}"
    elif 'openai.com' in request.host:
        target_url = f"https://api.openai.com/{path}"
    else:
        return Response("Unknown target", status=400)
    
    # Check if this is a message request
    is_message_request = (
        'messages' in path or 
        'conversation' in path or
        'completions' in path
    )
    
    # Inject memory if it's a message request
    if is_message_request and request.method == 'POST':
        try:
            body = request.get_json()
            messages = body.get('messages', [])
            
            if messages:
                # Build context
                context = '\n'.join([f"{m['role']}: {m.get('content', '')}" for m in messages])
                
                # Call observe()
                observe_response = requests.post(
                    f"{IRANTI_URL}/observe",
                    headers={'X-Iranti-Key': IRANTI_API_KEY},
                    json={
                        'agentId': AGENT_ID,
                        'currentContext': context,
                        'maxFacts': 5
                    }
                )
                
                if observe_response.ok:
                    facts = observe_response.json().get('facts', [])
                    if facts:
                        # Inject into last user message
                        for msg in reversed(messages):
                            if msg['role'] == 'user':
                                fact_text = '; '.join([f['summary'] for f in facts])
                                msg['content'] = f"[MEMORY: {fact_text}]\n\n{msg['content']}"
                                break
                        
                        print(f"[Iranti] Injected {len(facts)} facts")
        except Exception as e:
            print(f"[Iranti] Error: {e}")
    
    # Forward request
    headers = {k: v for k, v in request.headers if k.lower() != 'host'}
    response = requests.request(
        method=request.method,
        url=target_url,
        headers=headers,
        data=request.get_data(),
        params=request.args,
        allow_redirects=False
    )
    
    # Return response
    return Response(
        response.content,
        status=response.status_code,
        headers=dict(response.headers)
    )

if __name__ == '__main__':
    print("Iranti Proxy running on http://localhost:8080")
    print("Configure your browser to use this proxy")
    app.run(port=8080)
```

### Step 3: Configure Browser Proxy

1. Run the proxy: `python iranti_proxy.py`
2. In Chrome:
   - Go to Settings → System → Open proxy settings
   - Set HTTP proxy to `localhost:8080`
   - Set HTTPS proxy to `localhost:8080`
3. Visit claude.ai or chat.openai.com
4. Proxy will inject Iranti memory automatically

### Limitations

- **HTTPS**: The proxy needs SSL certificates to intercept HTTPS traffic. Use `mitmproxy` for production.
- **Performance**: All traffic goes through the proxy, which adds latency.
- **Complexity**: Requires browser proxy configuration, which can interfere with other sites.

---

## Recommended Approach

**Use the Chrome Extension (Approach A)** for:
- Ease of use (no proxy configuration)
- Better performance (only intercepts specific requests)
- Easier debugging (console logs)

**Use the Local Proxy (Approach B)** for:
- Testing across multiple browsers
- Intercepting mobile app traffic
- More control over request/response modification

---

## Testing the Integration

1. **Write test facts**:
   ```python
   from clients.python.iranti import IrantiClient
   
   client = IrantiClient(base_url="http://localhost:3001")
   client.write(
       entity="project/demo",
       key="blocker",
       value={"data": "API rate limit from vendor X"},
       summary="blocker: API rate limit from vendor X",
       confidence=90,
       source="test",
       agent="browser_assistant"
   )
   ```

2. **Start conversation** on Claude.ai:
   - "I'm working on project demo"
   - (several unrelated turns)
   - "What's blocking project demo?"

3. **Check console** (F12):
   - Should see `[Iranti] Injected 1 facts`

4. **Verify answer**:
   - Claude should mention "API rate limit from vendor X"
   - Without Iranti, Claude would say "I don't have that information"

---

## Troubleshooting

### Extension not injecting facts

- Check console for errors
- Verify Iranti server is running: `curl http://localhost:3001/health`
- Check API key in `content.js` matches `.env`
- Verify facts exist: `curl -H "X-Iranti-Key: your_key" http://localhost:3001/query/project/demo`

### CORS errors

- Iranti server must allow `localhost` origin
- Check `src/api/server.ts` has CORS enabled

### Facts not detected

- Entity name must match exactly (use underscores: `project_demo` not `project demo`)
- Mention entity explicitly in conversation
- Check observe() response: `curl -X POST http://localhost:3001/observe -H "X-Iranti-Key: key" -d '{"agentId":"test","currentContext":"project demo"}'`

---

## Next Steps

- Add `after_receive()` logic to extract facts from responses
- Build a popup UI to show injected facts
- Add settings page for API key configuration
- Support more LLM platforms (Gemini, Perplexity, etc.)
