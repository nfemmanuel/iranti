"""
CONTROL HELIX — No Iranti
==========================
Tests cross-agent fact transfer using a fictional entity.
Researcher receives briefing with invented facts.
Analyst tries to summarize without access to those facts.
Expected: Analyst should fail or hallucinate since it has no prior knowledge.
"""

import os
import sys
import json
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from crewai import Agent, Task, Crew, LLM
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent.parent / '.env')

os.environ['CREWAI_TRACING_ENABLED'] = 'true'

# ─── Fictional Entity ─────────────────────────────────────────────────────────

ENTITY = "project/helix_protocol"

HELIX_FACTS = {
    "lead": "Dr. Mara Osei-Bonsu",
    "budget": "$7.8 million",
    "deadline": "March 3, 2027",
    "status": "Phase 3: quantum relay integration",
    "blocker": "Vendor lock-in with Synthos Labs contract clause 14B",
}

BRIEFING_DOC = f"""
PROJECT HELIX PROTOCOL — CONFIDENTIAL BRIEFING

Lead: {HELIX_FACTS['lead']}
Budget: {HELIX_FACTS['budget']}
Deadline: {HELIX_FACTS['deadline']}
Current Status: {HELIX_FACTS['status']}
Primary Blocker: {HELIX_FACTS['blocker']}

This is a classified quantum computing initiative. All details are fictional
and not present in any public dataset or LLM training corpus.
"""

# ─── Crew ─────────────────────────────────────────────────────────────────────

def run_control_helix():
    print("\n" + "="*60)
    print("  CONTROL HELIX — No Shared Memory")
    print("="*60 + "\n")

    llm = LLM(model="gpt-4o-mini", temperature=0.3)

    # Researcher: receives briefing, extracts facts
    researcher = Agent(
        role="Research Analyst",
        goal="Extract key facts from briefing documents",
        backstory="You read briefing documents and extract structured facts.",
        llm=llm,
        verbose=True,
        max_iter=3,
    )

    # Analyst: NO access to briefing, tries to summarize
    analyst = Agent(
        role="Project Analyst",
        goal="Summarize project status based on available information",
        backstory="You summarize project details for stakeholders.",
        llm=llm,
        verbose=True,
        max_iter=3,
    )

    research_task = Task(
        description=f"""
        Read this briefing document and extract the key facts:
        
        {BRIEFING_DOC}
        
        Return a JSON object with these exact keys:
        - lead: project lead name
        - budget: budget amount
        - deadline: deadline date
        - status: current status
        - blocker: primary blocker
        
        Return ONLY the JSON, no other text.
        """,
        agent=researcher,
        expected_output="JSON with lead, budget, deadline, status, blocker",
    )

    analysis_task = Task(
        description=f"""
        Summarize the current status of {ENTITY}.
        
        You do NOT have access to the researcher's briefing document.
        You have NO shared memory with the researcher.
        
        Based on what you know, provide:
        - lead: project lead name (or "unknown")
        - budget: budget amount (or "unknown")
        - deadline: deadline date (or "unknown")
        - status: current status (or "unknown")
        - blocker: primary blocker (or "unknown")
        
        Return as JSON only. If you don't know a fact, use "unknown".
        """,
        agent=analyst,
        expected_output="JSON with lead, budget, deadline, status, blocker",
        context=[research_task],
    )

    crew = Crew(
        agents=[researcher, analyst],
        tasks=[research_task, analysis_task],
        verbose=True,
    )

    print(f"Running control crew for {ENTITY}...")
    crew.kickoff()

    # Parse outputs
    def parse_output(raw: str) -> dict:
        try:
            clean = raw.replace('```json', '').replace('```', '').strip()
            return json.loads(clean)
        except:
            import re
            match = re.search(r'\{[^{}]+\}', raw, re.DOTALL)
            if match:
                try:
                    return json.loads(match.group())
                except:
                    pass
            return {"raw": raw, "parse_error": True}

    researcher_output = parse_output(research_task.output.raw if research_task.output else "")
    analyst_output = parse_output(analysis_task.output.raw if analysis_task.output else "")

    # Score: count how many facts the analyst got right
    score = 0
    for key, expected_value in HELIX_FACTS.items():
        analyst_value = analyst_output.get(key, "").lower()
        if expected_value.lower() in analyst_value or analyst_value in expected_value.lower():
            score += 1

    results = {
        "mode": "control_helix",
        "timestamp": datetime.now().isoformat(),
        "entity": ENTITY,
        "researcher_output": researcher_output,
        "analyst_output": analyst_output,
        "expected_facts": HELIX_FACTS,
        "facts_recovered": score,
        "total_facts": len(HELIX_FACTS),
        "accuracy_pct": round(score / len(HELIX_FACTS) * 100, 1),
        "iranti_used": False,
    }

    print(f"\n{'='*60}")
    print(f"  CONTROL HELIX COMPLETE")
    print(f"  Facts recovered: {score}/{len(HELIX_FACTS)} ({results['accuracy_pct']}%)")
    print(f"{'='*60}\n")

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(__file__).parent.parent / f"results/control_helix_{timestamp}.json"
    output_path.write_text(json.dumps(results, indent=2))
    print(f"Results saved: {output_path}")

    return results


if __name__ == "__main__":
    run_control_helix()
