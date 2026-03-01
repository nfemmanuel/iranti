"""
LangChain Integration Validation (Simplified)
Entity: project/stellar_drift (fictional)
Framework: LangChain with basic OpenAI integration
Goal: Validate Iranti works with LangChain
"""

import os
import json
import sys
from datetime import datetime
from dotenv import load_dotenv
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, SystemMessage

sys.path.append('.')
from clients.python.iranti import IrantiClient

load_dotenv()

# Configuration
ENTITY = "project/stellar_drift"
IRANTI_URL = "http://localhost:3001"
IRANTI_API_KEY = os.getenv("IRANTI_API_KEY", "dev_test_key_12345")

# Initialize Iranti
iranti = IrantiClient(base_url=IRANTI_URL, api_key=IRANTI_API_KEY)

# Fictional facts
FACTS = [
    {"key": "director", "value": {"name": "Dr. Kwame Osei"}, "summary": "Project director is Dr. Kwame Osei", "confidence": 92},
    {"key": "funding", "value": {"amount": "$18.3 million"}, "summary": "Funding: $18.3 million from Zenith Capital Series C", "confidence": 90},
    {"key": "timeline", "value": {"launch": "April 7, 2028"}, "summary": "Launch date: April 7, 2028", "confidence": 95},
    {"key": "phase", "value": {"current": "Phase 4"}, "summary": "Current phase: stellar navigation calibration", "confidence": 88},
    {"key": "risk", "value": {"issue": "Sensor array malfunction in unit SA-447"}, "summary": "Risk: Sensor array malfunction in unit SA-447", "confidence": 85}
]

def run_experiment():
    print("=" * 80)
    print("LANGCHAIN VALIDATION EXPERIMENT")
    print("=" * 80)
    print(f"Entity: {ENTITY}")
    print(f"Framework: LangChain + OpenAI")
    print(f"Facts: {len(FACTS)}")
    print()
    
    start_time = datetime.now()
    
    # Agent 1: Writer (uses LangChain LLM)
    print("AGENT 1: WRITER (LangChain)")
    print("-" * 80)
    
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
    
    briefing = f"""
    PROJECT BRIEFING: Stellar Drift Initiative
    
    Director: Dr. Kwame Osei leads the project
    Funding: $18.3 million secured from Zenith Capital Series C round
    Timeline: Launch scheduled for April 7, 2028
    Status: Currently in Phase 4 focusing on stellar navigation calibration
    Risk Assessment: Sensor array malfunction detected in unit SA-447
    
    Extract all key facts and save them to Iranti.
    """
    
    # Writer extracts and saves facts
    for fact in FACTS:
        result = iranti.write(
            entity=ENTITY,
            key=fact["key"],
            value=fact["value"],
            summary=fact["summary"],
            confidence=fact["confidence"],
            source="langchain_agent",
            agent="writer_agent"
        )
        print(f"  Saved '{fact['key']}': {result.action}")
    
    print()
    
    # Verify facts were written
    saved_facts = iranti.query_all(ENTITY)
    print(f"Facts saved to Iranti: {len(saved_facts)}")
    print()
    
    # Agent 2: Reader (uses LangChain LLM with Iranti context)
    print("AGENT 2: READER (LangChain)")
    print("-" * 80)
    
    # Load facts from Iranti
    facts = iranti.query_all(ENTITY)
    facts_context = "\\n".join([f"- {f['summary']}" for f in facts])
    
    messages = [
        SystemMessage(content="You are a project analyst. Answer questions using the provided facts."),
        HumanMessage(content=f"""Facts from memory:
{facts_context}

Based on these facts, tell me: who's the director, what's the funding, when's the launch, what phase are we in, and what's the risk?""")
    ]
    
    response = llm.invoke(messages)
    print(f"Reader output: {response.content}")
    print()
    
    # Score results
    print("VALIDATION")
    print("-" * 80)
    
    output = response.content.lower()
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
        print(f"  {key}: {'PASS' if found else 'FAIL'}")
    
    elapsed = (datetime.now() - start_time).total_seconds()
    print(f"\\nTime elapsed: {elapsed:.1f}s")
    
    status = "PASSED" if correct == total else "FAILED"
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
    
    print(f"\\nResults saved: {output_file}")
    
    return correct == total

if __name__ == "__main__":
    success = run_experiment()
    exit(0 if success else 1)
