"""
EXPERIMENT B: Cross-Agent Transfer CONTROL (No Iranti)
========================================================
Analyst has NO access to briefing and NO Iranti tools.
Expected: Returns "unknown" for all 6 fields.
"""

import os
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from crewai import Agent, Task, Crew, LLM
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent.parent / '.env')

ENTITY = "project/nexus_prime"

NEXUS_FACTS = {
    "lead": "Dr. Kofi Mensah-Larbi",
    "budget": "$12.4 million",
    "deadline": "June 18, 2028",
    "status": "Phase 1: neural mesh calibration",
    "blocker": "Hardware shortage from Veridian Systems batch 7C recall",
    "tech_stack": "Distributed quantum coherence layer on Helix-9 processors",
}

BRIEFING = f"""
PROJECT NEXUS PRIME — CONFIDENTIAL

Lead: {NEXUS_FACTS['lead']}
Budget: {NEXUS_FACTS['budget']}
Deadline: {NEXUS_FACTS['deadline']}
Status: {NEXUS_FACTS['status']}
Blocker: {NEXUS_FACTS['blocker']}
Tech Stack: {NEXUS_FACTS['tech_stack']}

All details are fictional and not in any LLM training data.
"""

def run():
    print("\n" + "="*60)
    print("  EXPERIMENT B: Control (No Iranti)")
    print("="*60 + "\n")

    llm = LLM(model="gpt-4o-mini", temperature=0.3)

    researcher = Agent(
        role="Research Analyst",
        goal="Extract facts from briefing",
        backstory="You extract structured facts from documents.",
        llm=llm,
        verbose=True,
        max_iter=3,
    )

    analyst = Agent(
        role="Project Analyst",
        goal="Summarize project status",
        backstory="You summarize projects for stakeholders.",
        llm=llm,
        verbose=True,
        max_iter=3,
    )

    research_task = Task(
        description=f"""
        Extract facts from this briefing:
        
        {BRIEFING}
        
        Return JSON with: lead, budget, deadline, status, blocker, tech_stack
        Return ONLY JSON, no other text.
        """,
        agent=researcher,
        expected_output="JSON with all 6 fields",
    )

    analysis_task = Task(
        description=f"""
        Summarize {ENTITY}.
        
        You have NO access to the briefing document.
        You have NO shared memory.
        
        Return JSON with: lead, budget, deadline, status, blocker, tech_stack
        Use "unknown" if you don't know a value.
        Return ONLY JSON.
        """,
        agent=analyst,
        expected_output="JSON with all 6 fields",
        context=[research_task],
    )

    crew = Crew(agents=[researcher, analyst], tasks=[research_task, analysis_task], verbose=True)
    crew.kickoff()

    def parse(raw):
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

    analyst_output = parse(analysis_task.output.raw if analysis_task.output else "")

    # Score
    score = 0
    for key, expected in NEXUS_FACTS.items():
        analyst_val = str(analyst_output.get(key, "")).lower()
        if expected.lower() in analyst_val or analyst_val in expected.lower():
            score += 1

    print(f"\n{'='*60}")
    print(f"  CONTROL RESULTS")
    print(f"  Facts recovered: {score}/6")
    print(f"  Analyst output: {json.dumps(analyst_output, indent=2)}")
    print(f"{'='*60}\n")

    return {"score": score, "total": 6, "output": analyst_output}

if __name__ == "__main__":
    run()
