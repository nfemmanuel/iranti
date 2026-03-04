# Iranti Middleware

Add persistent memory to any LLM conversation — Claude, ChatGPT, or custom agents.

---

## What's Here

- **`iranti_middleware.py`** - Python class that wraps LLM conversations with memory injection
- **`claude_example.py`** - Working example with Anthropic Claude API
- **`BROWSER_INTEGRATION.md`** - Guide for adding Iranti to Claude.ai/ChatGPT in browser

---

## Quick Start

### 1. Install Dependencies

```bash
pip install anthropic openai python-dotenv
```

### 2. Start Iranti Server

```bash
cd ../..
npm run api  # Runs on http://localhost:3001
```

### 3. Use the Middleware

```python
from middleware.iranti_middleware import IrantiMiddleware

middleware = IrantiMiddleware(
    agent_id="my_agent",
    iranti_url="http://localhost:3001"
)

# Before sending to LLM
augmented_message = middleware.before_send(
    user_message="What was the blocker?",
    conversation_history=[
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": "..."}
    ]
)

# Send augmented_message to your LLM
# ...

# After receiving response
final_response = middleware.after_receive(
    response="The blocker is...",
    conversation_history=[...]
)
```

---

## How It Works

### before_send()

1. Takes last N messages from conversation history (default 20)
2. Calls Iranti's `attend()` API with that context
3. If facts are returned, prepends them as: `[MEMORY: fact1; fact2]\n\n{original_message}`
4. Returns augmented message

### after_receive()

1. Optionally enforces memory consistency for personal-memory questions
2. If model reply conflicts with current memory, auto-corrects reply text
3. Scans final reply for factual statements (numbers, names, dates)
4. Calls Iranti's `write()` API for each detected fact (best-effort)
5. Returns final response text (possibly corrected)

---

## Examples

### With Claude API

See `claude_example.py` for a complete working example.

```bash
python claude_example.py
```

### With OpenAI API

```python
from middleware.iranti_middleware import IrantiMiddleware
from openai import OpenAI

middleware = IrantiMiddleware(agent_id="gpt_assistant")
client = OpenAI()

conversation = []

# Turn 1
user_msg = "The project deadline is March 15, 2028"
conversation.append({"role": "user", "content": user_msg})

response = client.chat.completions.create(
    model="gpt-4",
    messages=conversation
)
assistant_msg = response.choices[0].message.content
conversation.append({"role": "assistant", "content": assistant_msg})

# ... many turns later ...

# Turn 20
user_msg = "What's the deadline?"
augmented = middleware.before_send(user_msg, conversation)  # Injects forgotten fact
conversation.append({"role": "user", "content": augmented})

response = client.chat.completions.create(
    model="gpt-4",
    messages=conversation
)
# GPT correctly answers "March 15, 2028" using injected memory
```

### In Browser (Chrome Extension)

See `BROWSER_INTEGRATION.md` for complete guide.

1. Create Chrome extension with `manifest.json` and `content.js`
2. Intercept fetch() calls to Claude/ChatGPT APIs
3. Call Iranti attend() before each request
4. Inject facts into user message
5. Forward modified request

---

## Configuration

### IrantiMiddleware Parameters

- `agent_id` (required) - Unique identifier for this agent
- `iranti_url` (default: `http://localhost:3001`) - Iranti API server URL
- `iranti_api_key` (optional) - API key, or set `IRANTI_API_KEY` env var
- `context_window` (default: 20) - Number of recent messages to include in context
- `max_facts` (default: 5) - Maximum facts to inject per message
- `memory_entity` (default: `conversation/<agent_id>`) - Entity for user/profile memory
- `auto_remember` (default: `True`) - Auto-save explicit user profile updates/corrections
- `enforce_consistency` (default: `True`) - Correct replies that conflict with known memory
- `source` (default: `middleware_user`) - Source label for middleware writes
- `write_confidence` (default: `100`) - Confidence for explicit user-memory writes

---

## Architecture

```
User types message
        ↓
middleware.before_send()
        ↓
Calls attend(conversation_context)
        ↓
Iranti returns forgotten facts
        ↓
Prepends facts to message: [MEMORY: ...]
        ↓
Send augmented message to LLM
        ↓
LLM responds with facts in context
        ↓
middleware.after_receive()
        ↓
Consistency-checks reply against current memory
        ↓
Extracts new facts from response
        ↓
Calls write() for each fact
        ↓
Facts persist in PostgreSQL
```

---

## Multi-Agent Support

Each agent has its own Attendant instance in Iranti. All agents write to the same Library (PostgreSQL). Any agent can read any other agent's facts.

```python
# Agent 1
middleware_1 = IrantiMiddleware(agent_id="researcher")
# Writes facts about project/alpha

# Agent 2
middleware_2 = IrantiMiddleware(agent_id="analyst")
# Can read facts about project/alpha written by Agent 1
```

This is already supported — no additional configuration needed.

---

## Limitations

### after_receive() is Best-Effort

The fact extraction heuristic is simple:
- Looks for sentences with numbers, proper nouns, or dates
- May miss some facts or extract non-facts
- Confidence is set to 70 (medium)

For production, consider:
- Using an LLM to extract facts from responses
- Manual fact curation
- Higher confidence threshold for auto-extracted facts

### Streaming Responses

The middleware works with complete responses. For streaming:
- Buffer the stream
- Call `after_receive()` once complete
- Or skip `after_receive()` and rely on manual fact writing

### Entity Inference

The `_infer_entity()` method uses simple regex to find entity mentions. For better accuracy:
- Pass entity explicitly to middleware
- Use LLM-based entity extraction
- Maintain entity context in conversation state

---

## Testing

Run the Claude example:

```bash
# Make sure Iranti is running
npm run api

# Run example
cd clients/middleware
python claude_example.py
```

Expected output:
- Facts written to Iranti
- 10 filler conversation turns
- Final question answered correctly using injected memory
- Score: 2/2 PASS

---

## Next Steps

- Add support for more LLM providers (Gemini, Cohere, etc.)
- Build browser extension with UI for viewing injected facts
- Add streaming response support
- Improve fact extraction with LLM-based parsing
- Add entity tracking across conversation

---

## Questions?

- See `BROWSER_INTEGRATION.md` for browser setup
- See `../experiments/goal5_response_quality.py` for validation
- See `../../docs/validation_results.md` for test results
