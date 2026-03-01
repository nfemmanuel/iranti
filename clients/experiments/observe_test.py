"""
OBSERVE() CONTEXT PERSISTENCE TEST
====================================
Proves that observe() recovers facts that have "fallen out" of context.

Setup:
  - Write known facts about a fictional entity to Iranti
  - Simulate a long conversation where those facts are NOT in the current context
  - Call observe() with a context window that doesn't contain the facts
  - Verify that observe() returns the missing facts for injection

Control:   observe() called with context that already contains the facts
           → should return alreadyPresent > 0, facts = []

Treatment: observe() called with context that does NOT contain the facts
           → should return facts with the missing data

This is a unit test of the observe() endpoint, not a full agent simulation.
"""

import os
import sys
import json
import time
from pathlib import Path
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent))
from python.iranti import IrantiClient, IrantiError

# ─── Config ───────────────────────────────────────────────────────────────────

BASE_URL = os.getenv('IRANTI_URL', 'http://localhost:3001')
API_KEY  = os.getenv('IRANTI_API_KEY', 'dev_test_key_12345')

# Fictional entity — no LLM prior knowledge can contaminate results
ENTITY      = "project/aurora_station"
AGENT_ID    = "observe_test_agent"

KNOWN_FACTS = {
    "budget":    ("$4.2 million allocated for Q3 deployment", 90),
    "lead":      ("Dr. Yemi Adeyinka is the project lead", 92),
    "deadline":  ("Hard deadline: September 15, 2026", 95),
    "status":    ("Currently in Phase 2: infrastructure buildout", 88),
    "blocker":   ("Regulatory approval pending from EU AI Act committee", 85),
}

# ─── Helpers ──────────────────────────────────────────────────────────────────

def section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)

def check(label, passed, detail=""):
    icon = "✅" if passed else "❌"
    print(f"  {icon} {label}" + (f": {detail}" if detail else ""))
    return passed

# ─── Test ─────────────────────────────────────────────────────────────────────

def run():
    client = IrantiClient(base_url=BASE_URL, api_key=API_KEY)

    # ── Health check ──────────────────────────────────────────────────────────
    section("0. Health Check")
    try:
        h = client.health()
        check("API reachable", True, h.get('status', 'ok'))
    except Exception as e:
        check("API reachable", False, str(e))
        print("\n  Server not running. Start with: npm run api")
        return

    # ── Register agent ────────────────────────────────────────────────────────
    section("1. Register Agent")
    try:
        client.register_agent(
            agent_id=AGENT_ID,
            name="Observe Test Agent",
            description="Used for context persistence validation",
            capabilities=["testing"],
        )
        check("Agent registered", True, AGENT_ID)
    except Exception as e:
        check("Agent registered (already exists)", True, str(e))

    # ── Write facts about fictional entity ───────────────────────────────────
    section("2. Write Known Facts to Iranti")
    facts_written = 0
    for key, (summary, confidence) in KNOWN_FACTS.items():
        try:
            result = client.write(
                entity=ENTITY,
                key=key,
                value={"data": summary},
                summary=summary,
                confidence=confidence,
                source="observe_test",
                agent=AGENT_ID,
            )
            written = result.action in ("created", "updated")
            check(f"Write '{key}'", written, result.action)
            if written:
                facts_written += 1
        except Exception as e:
            check(f"Write '{key}'", False, str(e))

    print(f"\n  {facts_written}/{len(KNOWN_FACTS)} facts written")

    # ── Verify facts are in DB ────────────────────────────────────────────────
    section("3. Verify Facts Stored")
    try:
        stored = client.query_all(ENTITY)
        check("Facts retrievable", len(stored) > 0, f"{len(stored)} facts found")
        for f in stored:
            summary = f.get('valueSummary') or f.get('summary', '')
            print(f"    [{f['key']}] {summary[:60]}")
    except Exception as e:
        check("Facts retrievable", False, str(e))
        return

    # ── CONTROL: observe() with facts already in context ─────────────────────
    section("4. CONTROL — observe() with facts IN context")
    
    # Build a context window that contains all the facts
    context_with_facts = f"""
    We are working on Project Aurora Station.
    Dr. Yemi Adeyinka is the project lead.
    Budget: $4.2 million allocated for Q3 deployment.
    Hard deadline: September 15, 2026.
    Currently in Phase 2: infrastructure buildout.
    Regulatory approval pending from EU AI Act committee.
    
    Given all of the above, what should we prioritize this week?
    """

    try:
        result = client.observe(
            agent_id=AGENT_ID,
            current_context=context_with_facts,
            max_facts=10,
        )
        print(f"\n  Entities detected: {result.get('entitiesDetected', [])}")
        print(f"  Total facts found: {result.get('totalFound', 0)}")
        print(f"  Already in context: {result.get('alreadyPresent', 0)}")
        print(f"  Facts to inject: {len(result.get('facts', []))}")
        
        control_inject_count = len(result.get('facts', []))
        check(
            "Facts NOT re-injected (already present)",
            result.get('alreadyPresent', 0) > 0 or control_inject_count == 0,
            f"{result.get('alreadyPresent', 0)} already present, {control_inject_count} to inject"
        )
    except Exception as e:
        check("Control observe()", False, str(e))
        control_inject_count = -1

    # ── TREATMENT: observe() with facts NOT in context ────────────────────────
    section("5. TREATMENT — observe() with facts NOT in context")
    
    # Simulate a context window that has scrolled past the facts
    # The agent is deep in a conversation about something else entirely
    context_without_facts = f"""
    User: Can you help me draft the stakeholder update email?
    
    Assistant: Sure, I can help with that. What tone would you like - formal or informal?
    
    User: Formal. Also make sure to mention the current blockers.
    
    Assistant: I'll draft a formal email. To include the current blockers accurately,
    let me check what information I have available about project aurora_station.
    What are the main issues we need to surface to stakeholders?
    
    User: You should know this already. What's blocking us right now?
    """

    try:
        result = client.observe(
            agent_id=AGENT_ID,
            current_context=context_without_facts,
            max_facts=10,
        )
        print(f"\n  Entities detected: {result.get('entitiesDetected', [])}")
        print(f"  Total facts found: {result.get('totalFound', 0)}")
        print(f"  Already in context: {result.get('alreadyPresent', 0)}")
        print(f"  Facts to inject: {len(result.get('facts', []))}")
        
        facts = result.get('facts', [])
        treatment_inject_count = len(facts)
        
        if facts:
            print("\n  Facts recovered:")
            for f in facts:
                print(f"    → [{f['entityKey']}] {f['summary'][:70]}")
        
        check(
            "Facts recovered from Iranti",
            treatment_inject_count > 0,
            f"{treatment_inject_count} facts injected"
        )
        
        # Check that the blocker fact specifically was recovered
        recovered_keys = [f['entityKey'] for f in facts]
        blocker_recovered = any('blocker' in k for k in recovered_keys)
        check(
            "Blocker fact specifically recovered",
            blocker_recovered,
            "EU AI Act blocker" if blocker_recovered else "not found"
        )

    except Exception as e:
        check("Treatment observe()", False, str(e))
        treatment_inject_count = -1

    # ── Summary ───────────────────────────────────────────────────────────────
    section("RESULTS")
    
    if control_inject_count >= 0 and treatment_inject_count >= 0:
        print(f"\n  Control  (facts IN context):     {control_inject_count} injected  ← should be 0")
        print(f"  Treatment (facts NOT in context): {treatment_inject_count} injected  ← should be > 0")
        
        works = treatment_inject_count > control_inject_count
        check(
            "observe() correctly identifies missing facts",
            works,
            "context persistence validated" if works else "needs investigation"
        )
    
    print()


if __name__ == "__main__":
    run()
