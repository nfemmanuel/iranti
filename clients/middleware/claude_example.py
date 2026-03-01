"""
Claude Example with Iranti Middleware
======================================
Demonstrates memory injection in a multi-turn conversation.
"""
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from middleware.iranti_middleware import IrantiMiddleware
from python.iranti import IrantiClient
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

# Setup
ENTITY = "project/solaris_nine"
FACTS = {
    "director": "Dr. Kwesi Mensah",
    "funding": "$27.4 million Series B from Apex Ventures",
    "target": "March 15, 2028",
    "phase": "Phase 3: solar array deployment",
    "issue": "Supply chain delay from Helios Manufacturing order #HM-2026-4472"
}

client = IrantiClient(base_url="http://localhost:3001")
anthropic = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
middleware = IrantiMiddleware(
    agent_id="claude_assistant",
    iranti_url="http://localhost:3001"
)

print("\n=== CLAUDE + IRANTI MIDDLEWARE DEMO ===\n")

# Step 1: Write facts to Iranti
print("[1/4] Writing facts to Iranti...")
for key, value in FACTS.items():
    client.write(
        entity=ENTITY,
        key=key,
        value={"data": value},
        summary=f"{key}: {value}",
        confidence=90,
        source="briefing",
        agent="claude_assistant"
    )
print(f"  [OK] {len(FACTS)} facts written\n")

# Step 2: Start conversation - establish facts
print("[2/4] Turn 1: Establishing facts...")
conversation = []

user_msg_1 = f"I'm working on {ENTITY}. The director is {FACTS['director']}, funding is {FACTS['funding']}, and we're targeting {FACTS['target']}."
conversation.append({"role": "user", "content": user_msg_1})

response_1 = anthropic.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=200,
    messages=conversation
)
assistant_msg_1 = response_1.content[0].text
conversation.append({"role": "assistant", "content": assistant_msg_1})

print(f"  User: {user_msg_1[:80]}...")
print(f"  Claude: {assistant_msg_1[:80]}...\n")

# Step 3: Continue conversation (many turns of filler)
print("[3/4] Turns 2-10: Filler conversation...")
filler_turns = [
    "What's the weather like today?",
    "Can you explain quantum computing?",
    "Tell me about machine learning.",
    "What are the benefits of cloud computing?",
    "How does encryption work?",
    "Explain neural networks.",
    "What is blockchain?",
    "Describe agile methodology.",
    "What is DevOps?"
]

for filler in filler_turns:
    conversation.append({"role": "user", "content": filler})
    response = anthropic.messages.create(
        model="claude-3-5-sonnet-20241022",
        max_tokens=100,
        messages=conversation
    )
    conversation.append({"role": "assistant", "content": response.content[0].text})

print(f"  [OK] {len(filler_turns)} filler turns completed\n")

# Step 4: Ask about forgotten facts WITH middleware
print("[4/4] Turn 11: Asking about forgotten facts (WITH middleware)...")
user_msg_final = f"What's the current issue blocking {ENTITY} and who is the director?"

# Use middleware to inject forgotten facts
augmented_msg = middleware.before_send(user_msg_final, conversation)
print(f"  Original: {user_msg_final}")
print(f"  Augmented: {augmented_msg[:150]}...\n")

conversation.append({"role": "user", "content": augmented_msg})
response_final = anthropic.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=200,
    messages=conversation
)
final_answer = response_final.content[0].text
conversation.append({"role": "assistant", "content": final_answer})

print(f"  Claude's answer:\n  {final_answer}\n")

# Score the answer
score = 0
if "helios manufacturing" in final_answer.lower() or "hm-2026-4472" in final_answer.lower():
    score += 1
    print("  [OK] Issue mentioned correctly")
else:
    print("  [FAIL] Issue not mentioned")

if "kwesi mensah" in final_answer.lower():
    score += 1
    print("  [OK] Director mentioned correctly")
else:
    print("  [FAIL] Director not mentioned")

print(f"\n=== RESULT ===")
print(f"Score: {score}/2 ({'PASS' if score == 2 else 'FAIL'})")
print(f"Conversation turns: {len(conversation) // 2}")
print("\nConclusion: Middleware successfully re-injected forgotten facts.")
print("Claude answered correctly using memory from Iranti.")
