# Install Iranti Chrome Extension

## Quick Install (5 minutes)

### Step 1: Make sure Iranti server is running

```bash
cd C:\Users\NF\Documents\Projects\iranti
npm run api
```

You should see: `Iranti API server running on port 3001`

### Step 2: Install the extension

1. Open Chrome
2. Go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Navigate to: `C:\Users\NF\Documents\Projects\iranti\clients\middleware\iranti-extension`
6. Click "Select Folder"

Extension is now installed!

### Step 3: Test it

1. Write a test fact:
   ```bash
   cd clients/experiments
   venv\Scripts\activate
   python
   ```

   ```python
   from python.iranti import IrantiClient
   
   client = IrantiClient(base_url="http://localhost:3001")
   client.write(
       entity="project/test_demo",
       key="status",
       value={"data": "Phase 3 complete"},
       summary="status: Phase 3 complete",
       confidence=90,
       source="manual",
       agent="browser_assistant"
   )
   print("Fact written!")
   ```

2. Go to https://claude.ai

3. Start a conversation:
   - "I'm working on project test_demo"
   - (ask a few unrelated questions)
   - "What's the status of test_demo?"

4. Open browser console (F12) - you should see:
   ```
   [Iranti] Memory extension loaded
   [Iranti] Injected 1 facts
   ```

5. Claude should answer: "Phase 3 complete"

## Troubleshooting

### Extension not loading
- Make sure you selected the `iranti-extension` folder, not a file
- Check Chrome console for errors

### No facts injected
- Verify Iranti server is running: `curl http://localhost:3001/health`
- Check console for `[Iranti] Error:` messages
- Verify fact exists: 
  ```bash
  curl -H "X-Iranti-Key: dev_test_key_12345" http://localhost:3001/kb/query/project/test_demo
  ```

### CORS errors
- Iranti server should allow localhost by default
- Check `src/api/server.ts` has CORS enabled

## Configuration

To change settings, edit `content.js`:

```javascript
const IRANTI_URL = 'http://localhost:3001';  // Change if server is elsewhere
const IRANTI_API_KEY = 'dev_test_key_12345'; // Your API key from .env
const AGENT_ID = 'browser_assistant';        // Unique ID for browser agent
```

After editing, click the refresh icon in `chrome://extensions/`

## What It Does

1. **Intercepts** fetch() calls to Claude/ChatGPT APIs
2. **Calls** Iranti's observe() with conversation context
3. **Injects** forgotten facts as `[MEMORY: ...]` prefix
4. **Forwards** modified request to Claude/ChatGPT

You see the normal response, but Claude/ChatGPT now has access to facts from Iranti.

## Next Steps

- Write more facts using Python client
- Try on chat.openai.com (works there too)
- Check console to see when facts are injected
- Build agents that write facts - browser will read them automatically
