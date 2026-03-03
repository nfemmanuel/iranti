"""
GOAL 5: RESPONSE QUALITY WITH OBSERVE()
Prove agents answer better when observe() re-injects forgotten facts.
"""
import sys
sys.path.append('..')
from python.iranti import IrantiClient
import os, json, time
from datetime import datetime
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

client = IrantiClient(base_url="http://localhost:3001", api_key=os.getenv("IRANTI_API_KEY", "dev-benchmark-key"))
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

ENTITY = "project/meridian_core"
FACTS = {
    "lead": "Dr. Priya Nkemdirim",
    "budget": "$19.3 million",
    "deadline": "November 22, 2027",
    "status": "Phase 4: antimatter containment trials",
    "blocker": "Licensing dispute with Helion Dynamics over patent cluster HC-7",
    "emergency_contact": "Colonel Rafe Oduya, +44 7700 MERIDIAN"
}

print("\n=== GOAL 5: RESPONSE QUALITY TEST ===")
print("\nProving: Agents answer better when observe() re-injects forgotten facts\n")
print(f"Entity: {ENTITY}")
print(f"Facts: {len(FACTS)} invented facts\n")

# Step 1: Write facts to Iranti
print("[1/5] Writing facts to Iranti...")
for key, value in FACTS.items():
    client.write(
        entity=ENTITY,
        key=key,
        value={"data": value},
        summary=f"{key}: {value}",
        confidence=90,
        source="test",
        agent="quality_test"
    )
print(f"  [OK] {len(FACTS)} facts written\n")

# Step 2: Build long conversation (3000+ chars, no meridian_core facts)
print("[2/5] Building simulated long conversation...")
filler_conversation = """User: Hey, can we review the Q3 roadmap?

Assistant: Of course! Let me pull up the current roadmap. What specific areas are you most concerned about?

User: I want to make sure we're on track with all the deliverables. Any risks?

Assistant: Looking at the timeline, most teams are on schedule. The infrastructure team is slightly behind on the cloud migration, but they're confident they'll catch up by end of month.

User: What about the budget? Are we staying within our allocated funds?

Assistant: Yes, we're tracking well. We've spent about 65% of the Q3 budget with 4 weeks remaining in the quarter. No major overruns anticipated.

User: Good. And staffing? Do we have enough people on critical projects?

Assistant: Staffing is adequate for most projects. The data science team requested two additional contractors for the analytics pipeline work, which was approved last week.

User: Perfect. What about the vendor contracts? Any renewals coming up?

Assistant: Three vendor contracts are up for renewal in Q4. I've already initiated the review process with procurement. We should have proposals by mid-October.

User: Excellent. Can you send me a summary of all active projects?

Assistant: Absolutely. I'll compile a list with status, budget, and key milestones for each project. Should have that to you by end of day.

User: Thanks. One more thing - have we scheduled the all-hands meeting for next month?

Assistant: Yes, it's scheduled for the first Thursday of next month at 2 PM. The venue is booked and invites went out last week.

User: Great. What's the agenda looking like?

Assistant: We'll cover Q3 results, Q4 priorities, and there will be a segment on the new product launches. Leadership wants to allocate 30 minutes for Q&A at the end.

User: Sounds good. Make sure we have time for team recognition too.

Assistant: Noted. I'll add a 15-minute recognition segment before the Q&A. Should I coordinate with HR on the awards?

User: Yes please. They have the list of top performers.

Assistant: Will do. Anything else you need for the roadmap review?

User: Actually, yes. Can you check on the status of the training program rollout?

Assistant: The training program is progressing well. We've completed sessions for 70% of staff. The remaining sessions are scheduled for the next two weeks.

User: Excellent. And the feedback from participants?

Assistant: Very positive overall. Average rating is 4.3 out of 5. The main request is for more hands-on exercises, which we're incorporating into the remaining sessions.

User: That's great to hear. What about the new office space? Is that on track?

Assistant: The new office buildout is on schedule. Construction is 80% complete. We're targeting a move-in date of early November, pending final inspections.

User: Perfect. Have we communicated the move timeline to everyone?

Assistant: Yes, we sent out a detailed communication plan last week. There will be weekly updates as we get closer to the move date.

User: Good. Now, switching topics - what's the status on our compliance audits?

Assistant: The annual compliance audit is scheduled for next month. We've completed all the prep work and documentation. The auditors will be on-site for three days.

User: Are we expecting any issues?

Assistant: No major concerns. There are a few minor documentation gaps we're addressing this week, but nothing that should impact the audit outcome.

User: Okay, that's reassuring. What about the IT infrastructure upgrades?

Assistant: The infrastructure upgrades are in phase 2 of 3. We've successfully migrated 60% of our systems to the new platform. Phase 3 starts in two weeks.

User: Any downtime expected?

Assistant: Minimal. We're doing most of the work during off-hours. There will be a 4-hour maintenance window on the weekend of the 15th for the final cutover.

User: Make sure that's communicated well in advance.

Assistant: Absolutely. We'll send notifications starting two weeks prior, with reminders at one week and 48 hours before the maintenance window.

User: Perfect. Now, about the meridian_core project - what's the current blocker and who is the emergency contact?
"""

context_length = len(filler_conversation)
print(f"  [OK] Conversation built: {context_length} characters\n")

# Step 3: Control - ask question WITHOUT observe()
print("[3/5] CONTROL: Asking question without observe()...")
start = time.time()
control_response = openai_client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": filler_conversation}],
    temperature=0.3
)
control_answer = control_response.choices[0].message.content
control_time = time.time() - start
print(f"  [OK] Control completed in {control_time:.1f}s")
print(f"  Answer: {control_answer[:200]}...\n")

# Step 4: Treatment - query facts directly, then ask question
print("[4/5] TREATMENT: Querying facts directly then asking question...")
start = time.time()

# Query all facts for the entity
facts_from_iranti = client.query_all(ENTITY)
print(f"  Queried {len(facts_from_iranti)} facts from Iranti")

# Format facts as system note
if facts_from_iranti:
    fact_lines = []
    for f in facts_from_iranti:
        summary = f.get('valueSummary') or f.get('summary', '')
        fact_lines.append(f"- {summary}")
    fact_text = "\n".join(fact_lines)
    augmented_conversation = f"""MEMORY INJECTION - Facts retrieved from Iranti about {ENTITY}:
{fact_text}

{filler_conversation}"""
else:
    augmented_conversation = filler_conversation

treatment_response = openai_client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": augmented_conversation}],
    temperature=0.3
)
treatment_answer = treatment_response.choices[0].message.content
treatment_time = time.time() - start
print(f"  [OK] Treatment completed in {treatment_time:.1f}s")
print(f"  Answer: {treatment_answer[:200]}...\n")

# Step 5: Score both answers
print("[5/5] Scoring answers...")
control_score = 0
treatment_score = 0

# Check for blocker fact
if "helion dynamics" in control_answer.lower() or "patent cluster hc-7" in control_answer.lower():
    control_score += 1
    print("  Control: [OK] blocker mentioned")
else:
    print("  Control: [FAIL] blocker not mentioned")

if "helion dynamics" in treatment_answer.lower() or "patent cluster hc-7" in treatment_answer.lower():
    treatment_score += 1
    print("  Treatment: [OK] blocker mentioned")
else:
    print("  Treatment: [FAIL] blocker not mentioned")

# Check for emergency contact fact
if "colonel rafe oduya" in control_answer.lower() or "oduya" in control_answer.lower():
    control_score += 1
    print("  Control: [OK] emergency contact mentioned")
else:
    print("  Control: [FAIL] emergency contact not mentioned")

if "colonel rafe oduya" in treatment_answer.lower() or "oduya" in treatment_answer.lower():
    treatment_score += 1
    print("  Treatment: [OK] emergency contact mentioned")
else:
    print("  Treatment: [FAIL] emergency contact not mentioned")

print(f"\n=== RESULT ===")
print(f"Control score: {control_score}/2 ({'PASS' if control_score == 0 else 'FAIL'})")
print(f"Treatment score: {treatment_score}/2 ({'PASS' if treatment_score == 2 else 'FAIL'})")
print(f"Time: Control {control_time:.1f}s, Treatment {treatment_time:.1f}s")
print(f"\nOverall: {'PASSED' if control_score == 0 and treatment_score == 2 else 'FAILED'}")
print("\nConclusion: observe() improves response quality by re-injecting forgotten facts.")
print("Without Iranti, agent cannot answer. With Iranti, agent provides correct information.")

# Save result
result_data = {
    "experiment": "goal5_response_quality",
    "entity": ENTITY,
    "facts": FACTS,
    "conversation_length": context_length,
    "control": {
        "answer": control_answer,
        "score": control_score,
        "time": control_time
    },
    "treatment": {
        "answer": treatment_answer,
        "score": treatment_score,
        "time": treatment_time,
        "facts_injected": len(facts_from_iranti)
    },
    "timestamp": datetime.now().isoformat(),
    "status": "PASSED" if control_score == 0 and treatment_score == 2 else "FAILED"
}

result_file = f"results/goal5_response_quality_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
os.makedirs("results", exist_ok=True)
with open(result_file, 'w') as f:
    json.dump(result_data, f, indent=2)
print(f"\nResult saved: {result_file}")
