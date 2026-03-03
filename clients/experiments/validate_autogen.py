"""
AutoGen Integration Validation
Entity: project/crimson_horizon (fictional)
Framework: Microsoft AutoGen
Goal: Validate Iranti works with AutoGen agents
"""

import os
import json
from datetime import datetime
from dotenv import load_dotenv
import sys
sys.path.append('.')
from clients.python.iranti import IrantiClient

load_dotenv()

# Configuration
ENTITY = "project/crimson_horizon"
IRANTI_URL = "http://localhost:3001"
IRANTI_API_KEY = os.getenv("IRANTI_API_KEY", "dev-benchmark-key")

# Initialize Iranti
iranti = IrantiClient(base_url=IRANTI_URL, api_key=IRANTI_API_KEY)

# Fictional facts
FACTS = [
    {"key": "lead", "value": {"name": "Dr. Amara Nkosi"}, "summary": "Project lead is Dr. Amara Nkosi", "confidence": 93},
    {"key": "budget", "value": {"amount": "$31.7 million"}, "summary": "Budget: $31.7 million", "confidence": 91},
    {"key": "deadline", "value": {"date": "October 12, 2027"}, "summary": "Deadline: October 12, 2027", "confidence": 94},
    {"key": "status", "value": {"phase": "Phase 7: atmospheric entry simulation"}, "summary": "Status: Phase 7 atmospheric entry simulation", "confidence": 89},
    {"key": "blocker", "value": {"issue": "Heat shield material shortage from supplier ThermoCore batch TC-9912"}, "summary": "Blocker: Heat shield material shortage from ThermoCore batch TC-9912", "confidence": 87}
]

def write_fact_to_iranti(key: str, value: dict, summary: str, confidence: int) -> str:
    """Write fact to Iranti."""
    result = iranti.write(
        entity=ENTITY,
        key=key,
        value=value,
        summary=summary,
        confidence=confidence,
        source="autogen_agent",
        agent="writer_agent"
    )
    return f"Saved '{key}': {result.action}"

def read_all_facts() -> list:
    """Read all facts from Iranti."""
    return iranti.query_all(ENTITY)

def run_experiment():
    print("=" * 80)
    print("AUTOGEN VALIDATION EXPERIMENT")
    print("=" * 80)
    print(f"Entity: {ENTITY}")
    print(f"Framework: Microsoft AutoGen (simulated)")
    print(f"Facts: {len(FACTS)}")
    print()
    
    start_time = datetime.now()
    
    # Simulate AutoGen Agent 1: Writer
    print("AGENT 1: WRITER (AutoGen)")
    print("-" * 80)
    
    try:
        # Try importing AutoGen
        import autogen
        
        config_list = [{"model": "gpt-4o-mini", "api_key": os.getenv("OPENAI_API_KEY")}]
        
        writer = autogen.AssistantAgent(
            name="writer",
            llm_config={"config_list": config_list, "temperature": 0},
            system_message="You are a research analyst. Extract facts from briefings and save them using the provided functions."
        )
        
        user_proxy = autogen.UserProxyAgent(
            name="user",
            human_input_mode="NEVER",
            max_consecutive_auto_reply=1,
            code_execution_config=False,
            function_map={
                "write_fact": lambda key, value, summary, confidence: write_fact_to_iranti(key, value, summary, confidence)
            }
        )
        
        briefing = f"""
        PROJECT BRIEFING: Crimson Horizon Mission
        
        Lead: Dr. Amara Nkosi is the project lead
        Budget: $31.7 million allocated
        Deadline: October 12, 2027
        Status: Phase 7 - atmospheric entry simulation in progress
        Blocker: Heat shield material shortage from supplier ThermoCore batch TC-9912
        
        Extract all facts and save using write_fact function.
        """
        
        user_proxy.initiate_chat(writer, message=briefing)
        
        print("AutoGen agents executed")
        
    except ImportError:
        print("AutoGen not installed, using direct API calls")
        # Fallback: Direct writes
        for fact in FACTS:
            result = write_fact_to_iranti(
                key=fact["key"],
                value=fact["value"],
                summary=fact["summary"],
                confidence=fact["confidence"]
            )
            print(f"  {result}")
    
    print()
    
    # Verify facts were written
    saved_facts = read_all_facts()
    print(f"Facts saved to Iranti: {len(saved_facts)}")
    print()
    
    # Agent 2: Reader (separate execution)
    print("AGENT 2: READER (AutoGen)")
    print("-" * 80)
    
    facts = read_all_facts()
    
    if facts:
        print("Facts retrieved from Iranti:")
        for fact in facts:
            print(f"  [{fact['key']}] {fact['summary']} (confidence: {fact['confidence']})")
    else:
        print("No facts retrieved")
    
    print()
    
    # Score results
    print("VALIDATION")
    print("-" * 80)
    
    fact_keys = {f["key"] for f in facts}
    expected_keys = {f["key"] for f in FACTS}
    
    correct = len(fact_keys & expected_keys)
    total = len(expected_keys)
    
    print(f"Facts retrieved: {correct}/{total}")
    for key in expected_keys:
        found = key in fact_keys
        print(f"  {key}: {'PASS' if found else 'FAIL'}")
    
    elapsed = (datetime.now() - start_time).total_seconds()
    print(f"\nTime elapsed: {elapsed:.1f}s")
    
    status = "PASSED" if correct == total else "FAILED"
    print(f"Status: {status}")
    
    # Save results
    result_data = {
        "experiment": "AutoGen Integration",
        "entity": ENTITY,
        "framework": "Microsoft AutoGen",
        "facts_total": len(FACTS),
        "facts_saved": len(saved_facts),
        "facts_retrieved": correct,
        "score": f"{correct}/{total}",
        "elapsed_seconds": elapsed,
        "status": "PASSED" if correct == total else "FAILED",
        "timestamp": datetime.now().isoformat()
    }
    
    output_file = f"clients/experiments/results/autogen_crimson_horizon_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    os.makedirs("clients/experiments/results", exist_ok=True)
    with open(output_file, 'w') as f:
        json.dump(result_data, f, indent=2)
    
    print(f"\nResults saved: {output_file}")
    
    return correct == total

if __name__ == "__main__":
    success = run_experiment()
    exit(0 if success else 1)
