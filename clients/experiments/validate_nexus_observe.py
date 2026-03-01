"""
OBSERVE() CONTEXT PERSISTENCE TEST — NEXUS PRIME
=================================================
Validates that observe() recovers facts that have fallen out of context.
Uses project/nexus_prime with 6 invented facts.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from python.iranti import IrantiClient, IrantiError

BASE_URL = os.getenv('IRANTI_URL', 'http://localhost:3001')
API_KEY = os.getenv('IRANTI_API_KEY', 'dev_test_key_12345')

ENTITY = "project/nexus_prime"
AGENT_ID = "nexus_observer"

NEXUS_FACTS = {
    "lead": ("Dr. Kofi Mensah-Larbi is the project lead", 92),
    "budget": ("$12.4 million allocated", 90),
    "deadline": ("Hard deadline: June 18, 2028", 95),
    "status": ("Phase 1: neural mesh calibration", 88),
    "blocker": ("Hardware shortage from Veridian Systems batch 7C recall", 85),
    "tech_stack": ("Distributed quantum coherence layer on Helix-9 processors", 87),
}

def section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)

def check(label, passed, detail=""):
    icon = "[OK]" if passed else "[FAIL]"
    print(f"  {icon} {label}" + (f": {detail}" if detail else ""))
    return passed

def run():
    client = IrantiClient(base_url=BASE_URL, api_key=API_KEY)

    section("EXPERIMENT A: observe() Context Persistence")
    
    # Health check
    try:
        client.health()
        check("API reachable", True)
    except Exception as e:
        check("API reachable", False, str(e))
        return

    # Register agent
    try:
        client.register_agent(
            agent_id=AGENT_ID,
            name="Nexus Observer",
            description="Context persistence test agent",
            capabilities=["testing"],
        )
        check("Agent registered", True)
    except:
        check("Agent registered (exists)", True)

    # Write facts
    section("Write Facts to Iranti")
    facts_written = 0
    for key, (summary, confidence) in NEXUS_FACTS.items():
        try:
            result = client.write(
                entity=ENTITY,
                key=key,
                value={"data": summary},
                summary=summary,
                confidence=confidence,
                source="nexus_test",
                agent=AGENT_ID,
            )
            if result.action in ("created", "updated"):
                facts_written += 1
                check(f"Write '{key}'", True, result.action)
        except Exception as e:
            check(f"Write '{key}'", False, str(e))

    print(f"\n  Total: {facts_written}/{len(NEXUS_FACTS)} facts written")

    # CONTROL: observe with facts IN context
    section("CONTROL: Facts Already in Context")
    context_with_facts = """
    We are working on Project Nexus Prime.
    Dr. Kofi Mensah-Larbi is the project lead.
    Budget: $12.4 million allocated.
    Hard deadline: June 18, 2028.
    Phase 1: neural mesh calibration.
    Hardware shortage from Veridian Systems batch 7C recall.
    Distributed quantum coherence layer on Helix-9 processors.
    """

    try:
        result = client.observe(
            agent_id=AGENT_ID,
            current_context=context_with_facts,
            max_facts=10,
        )
        control_inject = len(result.get('facts', []))
        print(f"\n  Entities detected: {result.get('entitiesDetected', [])}")
        print(f"  Already present: {result.get('alreadyPresent', 0)}")
        print(f"  Facts to inject: {control_inject}")
        check("Control: 0 facts injected", control_inject == 0, f"{control_inject} injected")
    except Exception as e:
        check("Control observe()", False, str(e))
        control_inject = -1

    # TREATMENT: observe with facts NOT in context
    section("TREATMENT: Facts Missing from Context")
    context_without_facts = """
    User: Can you draft the Q2 status report for stakeholders?
    
    Assistant: I'll help with that. What project should I focus on?
    
    User: Project nexus_prime. Include all key details.
    
    Assistant: Let me check what information I have about nexus_prime.
    """

    try:
        result = client.observe(
            agent_id=AGENT_ID,
            current_context=context_without_facts,
            max_facts=10,
        )
        treatment_inject = len(result.get('facts', []))
        print(f"\n  Entities detected: {result.get('entitiesDetected', [])}")
        print(f"  Total found: {result.get('totalFound', 0)}")
        print(f"  Facts to inject: {treatment_inject}")
        
        if result.get('facts'):
            print("\n  Facts recovered:")
            for f in result['facts']:
                print(f"    - [{f['entityKey']}] {f['summary'][:60]}")
        
        check("Treatment: 6 facts injected", treatment_inject == 6, f"{treatment_inject}/6 injected")
    except Exception as e:
        check("Treatment observe()", False, str(e))
        treatment_inject = -1

    # Results
    section("RESULTS")
    if control_inject >= 0 and treatment_inject >= 0:
        print(f"\n  Control (facts IN context):     {control_inject}/6 injected")
        print(f"  Treatment (facts NOT in context): {treatment_inject}/6 injected")
        print(f"  Delta: +{treatment_inject - control_inject} facts recovered")
        
        success = treatment_inject > control_inject and treatment_inject == 6
        check("Context persistence validated", success, 
              "observe() recovers missing facts" if success else "needs investigation")
    
    print()
    return {"control": control_inject, "treatment": treatment_inject}

if __name__ == "__main__":
    run()
