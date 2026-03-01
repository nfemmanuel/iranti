# Testing the Chrome Extension

## Quick Test Steps

1. **Open Chrome DevTools** on your ChatGPT tab:
   - Press `F12` or right-click → Inspect
   - Go to the **Console** tab

2. **Check if extension loaded**:
   - Look for message: `[Iranti Extension] Loaded on chat.openai.com`
   - If you see this, the extension is active

3. **Test with a real conversation**:
   - Write some facts to Iranti first (so there's something to inject)
   - Then start a ChatGPT conversation that should trigger memory

## Test Scenario

### Step 1: Write test facts to Iranti

Open a new terminal and run:

```bash
cd C:\Users\NF\Documents\Projects\iranti
python
```

Then in Python:

```python
from clients.python.iranti import IrantiClient

client = IrantiClient(
    base_url="http://localhost:3001",
    api_key="dev_test_key_12345"
)

# Write 3 test facts
client.write(
    entity="project/test_extension",
    key="lead",
    value={"name": "Dr. Sarah Chen"},
    summary="Project lead is Dr. Sarah Chen",
    confidence=90,
    source="test",
    agent="browser_test"
)

client.write(
    entity="project/test_extension",
    key="deadline",
    value={"date": "December 15, 2025"},
    summary="Deadline is December 15, 2025",
    confidence=90,
    source="test",
    agent="browser_test"
)

client.write(
    entity="project/test_extension",
    key="budget",
    value={"amount": "$5.2 million"},
    summary="Budget is $5.2 million",
    confidence=90,
    source="test",
    agent="browser_test"
)

print("✓ Test facts written to Iranti")
```

### Step 2: Test in ChatGPT

1. Go to chat.openai.com
2. Open DevTools Console (F12)
3. Start a new chat
4. Type: "Tell me about project test_extension"
5. Watch the Console for:
   - `[Iranti Extension] Intercepted fetch to OpenAI API`
   - `[Iranti Extension] Calling observe() with context...`
   - `[Iranti Extension] Injected X facts into message`

### Step 3: Verify injection

If working correctly, you should see in the Console:
- The facts being injected
- The modified message being sent to ChatGPT

ChatGPT's response should reference the facts (Dr. Sarah Chen, December 15 deadline, $5.2M budget).

## Troubleshooting

**If you don't see console messages:**
- Extension might not be active on this page
- Reload the page (Ctrl+R)
- Check extension is enabled at chrome://extensions/

**If observe() fails:**
- Check Iranti API server is running: `npm run api`
- Verify API key in content.js matches .env file
- Check Network tab in DevTools for failed requests to localhost:3001

**If facts aren't injected:**
- The observe() API might not be returning facts
- Check that facts exist in Iranti (run query_all in Python)
- Verify entity name matches exactly: "project/test_extension"
