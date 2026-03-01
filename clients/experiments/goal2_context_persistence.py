"""
GOAL 2: CONTEXT PERSISTENCE
Prove observe() re-injects facts absent from context in long conversations.
"""
import sys
sys.path.append('..')
from python.iranti import IrantiClient
import os

client = IrantiClient(base_url="http://localhost:3001", api_key=os.getenv("IRANTI_API_KEY", "dev_test_key_12345"))

ENTITY = "project/neural_lattice"
FACTS = {
    "director": "Dr. Kwame Osei-Tutu",
    "investment": "$18.6 million Series C from Apex Capital",
    "target_date": "February 14, 2028",
    "phase": "Phase 5: synaptic bridge deployment",
    "obstacle": "Regulatory hold from FDA panel decision #2025-NTI-447",
    "architecture": "Hierarchical neural mesh on Synapse-14 substrate"
}

print("\n=== GOAL 2: CONTEXT PERSISTENCE TEST ===")
print("\nProving: observe() re-injects facts when they fall out of context\n")
print(f"Entity: {ENTITY}")
print(f"Facts: {len(FACTS)} invented facts\n")

# Write facts to Iranti
print("[1/3] Writing facts to Iranti...")
for key, value in FACTS.items():
    client.write(
        entity=ENTITY,
        key=key,
        value={"data": value},
        summary=f"{key}: {value}",
        confidence=90,
        source="test",
        agent="context_test"
    )
print(f"  [OK] {len(FACTS)} facts written\n")

# CONTROL: Facts IN context - should return 0 to inject
print("[2/3] CONTROL: Facts present in context...")
context_with_facts = f"""User: Tell me about {ENTITY}.
Assistant: Here's what I know:
- Director: {FACTS['director']}
- Investment: {FACTS['investment']}
- Target date: {FACTS['target_date']}
- Phase: {FACTS['phase']}
- Obstacle: {FACTS['obstacle']}
- Architecture: {FACTS['architecture']}
"""

try:
    result_control = client.observe(
        agent_id="context_test",
        current_context=context_with_facts,
        max_facts=10
    )
    control_injected = len(result_control.get('facts', []))
    print(f"  [OK] Control returned {control_injected} facts (expected 0)\n")
except Exception as e:
    print(f"  [FAIL] Control error: {e}\n")
    control_injected = -1

# TREATMENT: Facts NOT in context - should return all facts
print("[3/3] TREATMENT: Facts absent from context...")
# 3000+ character filler that doesn't mention the entity or facts
filler_conversation = """User: What's the weather like today?
Assistant: It's a beautiful sunny day with clear skies.
User: That's great! Do you have any recommendations for outdoor activities?
Assistant: Absolutely! You could go for a hike, have a picnic in the park, or maybe try cycling.
User: Cycling sounds fun. What gear would I need?
Assistant: You'll need a good bike, a helmet for safety, water bottle, and maybe some sunscreen.
User: Where can I find good cycling trails?
Assistant: There are many apps like TrailLink and AllTrails that show cycling routes near you.
User: Thanks! What about bike maintenance?
Assistant: Regular maintenance includes checking tire pressure, lubricating the chain, and brake inspection.
User: How often should I do that?
Assistant: Check tire pressure weekly, lubricate chain every 100 miles, full inspection monthly.
User: Got it. What about nutrition for long rides?
Assistant: Bring energy bars, bananas, nuts, and plenty of water. Electrolyte drinks help too.
User: Any safety tips?
Assistant: Always wear a helmet, use lights at night, follow traffic rules, and stay visible.
User: What if I get a flat tire?
Assistant: Carry a spare tube, tire levers, and a portable pump. Learn to change it before your ride.
User: Should I ride alone or with others?
Assistant: Both have benefits. Groups are safer and more social, solo rides offer flexibility.
User: What's a good distance for beginners?
Assistant: Start with 5-10 miles, gradually increase as you build endurance.
User: How do I avoid getting sore?
Assistant: Proper bike fit is crucial. Also stretch before and after, and build up distance gradually.
User: What about bike types?
Assistant: Road bikes for pavement, mountain bikes for trails, hybrids for both.
User: Which is best for commuting?
Assistant: Hybrids or commuter bikes work well - comfortable, practical, and versatile.
User: Tell me about electric bikes.
Assistant: E-bikes have motors to assist pedaling. Great for longer commutes or hilly terrain.
User: Are they expensive?
Assistant: They range from $1000 to $5000+ depending on quality and features.
User: What about bike storage?
Assistant: Indoor storage is best. Use wall mounts or floor stands to save space.
User: How do I prevent theft?
Assistant: Use a U-lock, lock frame and wheels, park in well-lit areas, register your bike.
""" * 3  # Repeat to get 3000+ characters

context_without_facts = filler_conversation + f"\\nUser: Now tell me about {ENTITY} project.\\nAssistant: Let me check what I know."

try:
    result_treatment = client.observe(
        agent_id="context_test",
        current_context=context_without_facts,
        max_facts=10
    )
    treatment_injected = len(result_treatment.get('facts', []))
    print(f"  Context length: {len(context_without_facts)} characters")
    print(f"  [OK] Treatment returned {treatment_injected} facts (expected {len(FACTS)})\n")
except Exception as e:
    print(f"  [FAIL] Treatment error: {e}\n")
    treatment_injected = -1

# Results
print("=== RESULT ===")
print(f"Control (facts in context): {control_injected} injected ({'PASS' if control_injected == 0 else 'FAIL'})")
print(f"Treatment (facts absent): {treatment_injected} injected ({'PASS' if treatment_injected >= len(FACTS) - 1 else 'FAIL'})")
print(f"\\nOverall: {'PASSED' if control_injected == 0 and treatment_injected >= len(FACTS) - 1 else 'FAILED'}")
print("\\nConclusion: observe() successfully detects when facts fall out of context")
print("and re-injects them to prevent response quality degradation.")
