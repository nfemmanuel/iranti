"""
LangChain Integration Validation
Entity: project/stellar_drift (fictional)
Framework: LangChain with OpenAI function calling
Goal: Validate Iranti works with LangChain agents
"""

import os
import json
from datetime import datetime
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain.agents import create_tool_calling_agent, AgentExecutor
from clients.python.iranti import IrantiClient

load_dotenv()

# Configuration
ENTITY = "project/stellar_drift"
IRANTI_URL = "http://localhost:3001"
IRANTI_API_KEY = os.getenv("IRANTI_API_KEY", "dev-benchmark-key")

# Initialize Iranti
iranti = IrantiClient(base_url=IRANTI_URL, api_key=IRANTI_API_KEY)

# Fictional facts (GPT-4o-mini cannot know these)
FACTS = [
    {"key": "director", "value": {"name": "Dr. Kwame Osei"}, "summary": "Project director is Dr. Kwame Osei", "confidence": 92},
    {"key": "funding", "value": {"amount": "$18.3 million", "source": "Zenith Capital Series C"}, "summary": "Funding: $18.3 million from Zenith Capital Series C", "confidence": 90},
    {"key": "timeline", "value": {"launch": "April 7, 2028"}, "summary": "Launch date: April 7, 2028", "confidence": 95},
    {"key": "phase", "value": {"current": "Phase 4: stellar navigation calibration"}, "summary": "Current phase: stellar navigation calibration", "confidence": 88},
    {"key": "risk", "value": {"issue": "Sensor array malfunction in unit SA-447"}, "summary": "Risk: Sensor array malfunction in unit SA-447", "confidence": 85}
]

# Define Iranti tools for LangChain
@tool
def write_to_memory(key: str, value: str, summary: str, confidence: int) -> str:
    """Write a fact to Iranti shared memory."""
    result = iranti.write(
        entity=ENTITY,
        key=key,
        value={"data": value},
        summary=summary,
        confidence=confidence,
        source="langchain_agent",
        agent="writer_agent"
    )
    return f"Saved '{key}': {result.action}"

@tool
def read_from_memory() -> str:
    """Read all facts from Iranti shared memory."""
    facts = iranti.query_all(ENTITY)
    if not facts:
        return "No facts in memory."
    return json.dumps([{"key": f["key"], "summary": f["summary"], "confidence": f["confidence"]} for f in facts], indent=2)

def run_experiment():
    print("=" * 80)
    print("LANGCHAIN VALIDATION EXPERIMENT")
    print("=" * 80)
    print(f"Entity: {ENTITY}")
    print(f"Framework: LangChain + OpenAI")
    print(f"Facts: {len(FACTS)}")
    print()
    
    start_time = datetime.now()
    
    # Agent 1: Writer (extracts facts from briefing)
    print("AGENT 1: WRITER")
    print("-" * 80)
    
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    
    writer_prompt = ChatPromptTemplate.from_messages([
        ("system", "You are a research analyst. Extract facts from briefings and save them to shared memory using write_to_memory tool."),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad")
    ])
    
    writer_agent = create_tool_calling_agent(llm, [write_to_memory], writer_prompt)
    writer_executor = AgentExecutor(agent=writer_agent, tools=[write_to_memory], verbose=False)
    
    briefing = f"""
    PROJECT BRIEFING: Stellar Drift Initiative
    
    Director: Dr. Kwame Osei leads the project
    Funding: $18.3 million secured from Zenith Capital Series C round
    Timeline: Launch scheduled for April 7, 2028
    Status: Currently in Phase 4 focusing on stellar navigation calibration
    Risk Assessment: Sensor array malfunction detected in unit SA-447
    
    Extract all key facts and save them to shared memory.
    """
    
    writer_result = writer_executor.invoke({"input": briefing})
    print(f"Writer output: {writer_result['output']}")
    print()
    
    # Verify facts were written
    saved_facts = iranti.query_all(ENTITY)
    print(f"Facts saved to Iranti: {len(saved_facts)}")
    print()
    
    # Agent 2: Reader (retrieves facts in separate execution)
    print("AGENT 2: READER")
    print("-" * 80)
    
    reader_prompt = ChatPromptTemplate.from_messages([
        ("system", "You are a project analyst. Use read_from_memory to load facts, then answer questions."),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad")
    ])
    
    reader_agent = create_tool_calling_agent(llm, [read_from_memory], reader_prompt)
    reader_executor = AgentExecutor(agent=reader_agent, tools=[read_from_memory], verbose=False)
    
    reader_result = reader_executor.invoke({
        "input": "Load all facts about the project from memory and summarize: who's the director, what's the funding, when's the launch, what phase are we in, and what's the risk?"
    })
    
    print(f"Reader output: {reader_result['output']}")
    print()
    
    # Score results
    print("VALIDATION")
    print("-" * 80)
    
    output = reader_result['output'].lower()
    scores = {
        "director": "kwame osei" in output,
        "funding": "18.3" in output and "million" in output,
        "launch": "april" in output and "2028" in output,
        "phase": "phase 4" in output or "stellar navigation" in output,
        "risk": "sensor" in output and "sa-447" in output
    }
    
    correct = sum(scores.values())
    total = len(scores)
    
    print(f"Facts retrieved: {correct}/{total}")
    for key, found in scores.items():
        print(f"  {key}: {'✓' if found else '✗'}")
    
    elapsed = (datetime.now() - start_time).total_seconds()
    print(f"\nTime elapsed: {elapsed:.1f}s")
    
    status = "✅ PASSED" if correct == total else "❌ FAILED"
    print(f"Status: {status}")
    
    # Save results
    result_data = {
        "experiment": "LangChain Integration",
        "entity": ENTITY,
        "framework": "LangChain + OpenAI",
        "facts_total": len(FACTS),
        "facts_saved": len(saved_facts),
        "facts_retrieved": correct,
        "score": f"{correct}/{total}",
        "details": scores,
        "elapsed_seconds": elapsed,
        "status": "PASSED" if correct == total else "FAILED",
        "timestamp": datetime.now().isoformat()
    }
    
    output_file = f"clients/experiments/results/langchain_stellar_drift_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    os.makedirs("clients/experiments/results", exist_ok=True)
    with open(output_file, 'w') as f:
        json.dump(result_data, f, indent=2)
    
    print(f"\nResults saved: {output_file}")
    
    return correct == total

if __name__ == "__main__":
    success = run_experiment()
    exit(0 if success else 1)
