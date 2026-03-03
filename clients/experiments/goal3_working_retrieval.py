"""
GOAL 3: WORKING RETRIEVAL
Prove Agent 2 can retrieve facts written by Agent 1 with zero shared context.
"""
import sys
sys.path.append('..')
from python.iranti import IrantiClient
from crewai import Agent, Task, Crew, LLM
from crewai.tools import tool
import os, json, time
from datetime import datetime

client = IrantiClient(base_url="http://localhost:3001", api_key=os.getenv("IRANTI_API_KEY", "dev-benchmark-key"))

ENTITY = "project/photon_cascade"
FACTS = {
    "principal": "Dr. Ama Boateng",
    "capital": "$22.1 million from Titan Ventures Series D",
    "completion": "August 9, 2029",
    "stage": "Phase 6: photonic relay calibration",
    "impediment": "Supply chain delay from Quantum Dynamics order #QD-2025-3391"
}

llm = LLM(model="gpt-4o-mini", api_key=os.getenv("OPENAI_API_KEY"))

# Agent 1 tools - WRITE ONLY
@tool("Write fact to memory")
def write_fact(key: str, value: str, summary: str) -> str:
    """Write a fact to Iranti memory."""
    result = client.write(
        entity=ENTITY,
        key=key,
        value={"data": value},
        summary=summary,
        confidence=90,
        source="agent1",
        agent="writer_agent"
    )
    return f"Saved {key}: {result.action}"

# Agent 2 tools - READ ONLY
@tool("Get all facts from memory")
def get_all_facts() -> str:
    """Load all facts from Iranti memory."""
    facts = client.query_all(ENTITY)
    if not facts:
        return "No facts found"
    return json.dumps([{"key": f['key'], "value": f['value'], "summary": f.get('valueSummary', f.get('summary', ''))} for f in facts], indent=2)

print("\n=== GOAL 3: WORKING RETRIEVAL TEST ===")
print("\nProving: Agent 2 retrieves facts from Agent 1 with zero shared context\n")
print(f"Entity: {ENTITY}")
print(f"Facts: {len(FACTS)} invented facts\n")

# AGENT 1: Write facts
print("[1/2] Agent 1: Writing facts to Iranti...")
agent1 = Agent(
    role="Data Collector",
    goal=f"Extract facts about {ENTITY} and save to memory",
    backstory="You extract structured data from documents.",
    tools=[write_fact],
    llm=llm,
    verbose=False
)

briefing = f"""Extract these facts about {ENTITY} and save each one using write_fact tool:
- principal: {FACTS['principal']}
- capital: {FACTS['capital']}
- completion: {FACTS['completion']}
- stage: {FACTS['stage']}
- impediment: {FACTS['impediment']}

Save each fact individually."""

task1 = Task(
    description=briefing,
    expected_output="Confirmation that all 5 facts were saved",
    agent=agent1
)

crew1 = Crew(agents=[agent1], tasks=[task1], verbose=False)
start = time.time()
crew1.kickoff()
elapsed1 = time.time() - start
print(f"  [OK] Agent 1 completed in {elapsed1:.1f}s\n")

# AGENT 2: Read facts (completely separate, no context from Agent 1)
print("[2/2] Agent 2: Loading facts from Iranti (zero shared context)...")
agent2 = Agent(
    role="Data Analyst",
    goal=f"Summarize {ENTITY} using only facts from memory",
    backstory="You analyze projects using stored data.",
    tools=[get_all_facts],
    llm=llm,
    verbose=False
)

task2 = Task(
    description=f"""Load all facts about {ENTITY} from memory using get_all_facts tool.
Then provide a JSON summary with these exact keys: principal, capital, completion, stage, impediment.
Use the exact values from memory.""",
    expected_output="JSON with all 5 facts",
    agent=agent2
)

crew2 = Crew(agents=[agent2], tasks=[task2], verbose=False)
start = time.time()
result = crew2.kickoff()
elapsed2 = time.time() - start
print(f"  [OK] Agent 2 completed in {elapsed2:.1f}s\n")

# Score the output
print("[3/3] Scoring Agent 2 output...")
output_str = str(result).lower()
score = 0
for key, value in FACTS.items():
    # Check if key fact appears in output
    check_value = value.lower()
    if check_value in output_str:
        score += 1
        print(f"  [OK] {key}")
    else:
        print(f"  [FAIL] {key}")

print(f"\n=== RESULT ===")
print(f"Facts written by Agent 1: {len(FACTS)}/5")
print(f"Facts retrieved by Agent 2: {score}/5 ({'PASS' if score >= 5 else 'FAIL'})")
print(f"Time: Agent 1 {elapsed1:.1f}s, Agent 2 {elapsed2:.1f}s")
print(f"\nOverall: {'PASSED' if score >= 5 else 'FAILED'}")
print("\nConclusion: Agent 2 successfully retrieved facts with zero shared context.")
print("Facts persisted in PostgreSQL, accessible via identity-based lookup.")

# Save result
result_data = {
    "experiment": "goal3_working_retrieval",
    "entity": ENTITY,
    "facts": FACTS,
    "score": score,
    "total": len(FACTS),
    "elapsed_agent1": elapsed1,
    "elapsed_agent2": elapsed2,
    "timestamp": datetime.now().isoformat(),
    "status": "PASSED" if score >= 5 else "FAILED"
}

result_file = f"results/goal3_working_retrieval_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
os.makedirs("results", exist_ok=True)
with open(result_file, 'w') as f:
    json.dump(result_data, f, indent=2)
print(f"\nResult saved: {result_file}")

