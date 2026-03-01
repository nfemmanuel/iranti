"""
EXPERIMENT C: Cross-Agent Transfer TREATMENT (With Iranti)
============================================================
Researcher writes 6 facts to Iranti.
Analyst loads them using get_all_findings.
Expected: Returns all 6 facts correctly.
"""

import os
import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from crewai import Agent, Task, Crew, LLM
from crewai.tools import tool
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent.parent / '.env')

sys.path.insert(0, str(Path(__file__).parent.parent))
from python.iranti import IrantiClient, IrantiError, IrantiNotFoundError

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

iranti = IrantiClient(base_url='http://localhost:3001', api_key='dev_test_key_12345')

@tool("Write finding to shared memory")
def write_finding(key: str, value: str, summary: str, confidence: int) -> str:
    """Write a research finding to shared memory."""
    try:
        result = iranti.write(
            entity=ENTITY,
            key=key,
            value={"data": value},
            summary=summary,
            confidence=confidence,
            source="nexus_briefing",
            agent="nexus_researcher",
        )
        return f"Saved '{key}': {result.action}"
    except IrantiError as e:
        return f"Error: {e}"

@tool("Get all findings")
def get_all_findings() -> str:
    """Get all findings stored about the current project."""
    try:
        facts = iranti.query_all(ENTITY)
        if not facts:
            return "No findings in shared memory."
        lines = [f"All findings for {ENTITY}:"]
        for f in facts:
            summary = f.get('valueSummary') or f.get('summary') or f.get('value', '')
            lines.append(f"  [{f['key']}] {summary} (confidence: {f['confidence']})")
        return "\n".join(lines)
    except IrantiError as e:
        return f"Error: {e}"

def run():
    print("\n" + "="*60)
    print("  EXPERIMENT C: Treatment (With Iranti)")
    print("="*60 + "\n")

    # Register agents
    try:
        iranti.register_agent(
            agent_id="nexus_researcher",
            name="Nexus Researcher",
            description="Extracts facts from briefings",
            capabilities=["extraction"],
            model="gpt-4o-mini",
        )
        iranti.register_agent(
            agent_id="nexus_analyst",
            name="Nexus Analyst",
            description="Summarizes using Iranti",
            capabilities=["summarization"],
            model="gpt-4o-mini",
        )
    except:
        pass

    llm = LLM(model="gpt-4o-mini", temperature=0.3)

    researcher = Agent(
        role="Research Analyst",
        goal="Extract facts and save to shared memory",
        backstory="You extract facts and save them for other agents.",
        llm=llm,
        tools=[write_finding],
        verbose=True,
        max_iter=5,
    )

    analyst = Agent(
        role="Project Analyst",
        goal="Summarize using shared memory",
        backstory="You load facts from shared memory to build summaries.",
        llm=llm,
        tools=[get_all_findings],
        verbose=True,
        max_iter=5,
    )

    research_task = Task(
        description=f"""
        Extract facts from this briefing:
        
        {BRIEFING}
        
        Use write_finding tool to save each fact:
        - lead, budget, deadline, status, blocker, tech_stack
        
        Return JSON: {{"facts_saved": <count>, "lead": "<val>", "budget": "<val>", ...}}
        Return ONLY JSON.
        """,
        agent=researcher,
        expected_output="JSON with facts_saved and all values",
    )

    analysis_task = Task(
        description=f"""
        Summarize {ENTITY}.
        
        FIRST: Use get_all_findings to load facts from shared memory.
        SECOND: Build your summary from those facts.
        
        Return JSON: {{"facts_from_memory": <count>, "lead": "<val>", "budget": "<val>", ...}}
        Return ONLY JSON.
        """,
        agent=analyst,
        expected_output="JSON with facts_from_memory and all values",
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
        expected_lower = expected.lower()
        if expected_lower in analyst_val or analyst_val in expected_lower:
            score += 1

    print(f"\n{'='*60}")
    print(f"  TREATMENT RESULTS")
    print(f"  Facts recovered: {score}/6")
    print(f"  Facts saved: {analyst_output.get('facts_saved', 0)}")
    print(f"  Facts loaded: {analyst_output.get('facts_from_memory', 0)}")
    print(f"  Analyst output: {json.dumps(analyst_output, indent=2)}")
    print(f"{'='*60}\n")

    return {"score": score, "total": 6, "output": analyst_output}

if __name__ == "__main__":
    run()
