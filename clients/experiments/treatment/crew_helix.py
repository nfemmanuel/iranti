"""
TREATMENT HELIX — With Iranti
==============================
Tests cross-agent fact transfer using a fictional entity.
Researcher receives briefing with invented facts, writes to Iranti.
Analyst loads facts from Iranti and summarizes.
Expected: Analyst should recover all facts via shared memory.
"""

import os
import sys
import json
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from crewai import Agent, Task, Crew, LLM
from crewai.tools import tool
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent.parent / '.env')

os.environ['CREWAI_TRACING_ENABLED'] = 'true'

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from python.iranti import IrantiClient, IrantiError, IrantiNotFoundError

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

# ─── Iranti Client ────────────────────────────────────────────────────────────

iranti = IrantiClient(
    base_url='http://localhost:3001',
    api_key='dev_test_key_12345',
)

# ─── Iranti Tools ─────────────────────────────────────────────────────────────

@tool("Write finding to shared memory")
def write_finding(key: str, value: str, summary: str, confidence: int) -> str:
    """
    Write a research finding to shared memory so other agents can use it.
    Args:
        key: fact name in snake_case e.g. 'lead'
        value: the finding as a string
        summary: one sentence summary
        confidence: 0-100
    """
    try:
        result = iranti.write(
            entity=ENTITY,
            key=key,
            value={"data": value},
            summary=summary,
            confidence=confidence,
            source="helix_briefing",
            agent="helix_researcher",
        )
        return f"Saved '{key}': {result.action}"
    except IrantiError as e:
        return f"Could not save to memory: {e}"


@tool("Read finding from shared memory")
def read_finding(key: str) -> str:
    """
    Read a specific finding from shared memory.
    Args:
        key: fact name e.g. 'lead'
    """
    try:
        result = iranti.query(ENTITY, key)
        if result.found:
            return f"Found '{key}': {result.value} (confidence: {result.confidence})"
        return f"No finding for '{key}' in shared memory yet."
    except IrantiNotFoundError:
        return f"No finding for '{key}' in shared memory yet."
    except IrantiError as e:
        return f"Could not read from memory: {e}"


@tool("Get all findings for current entity")
def get_all_findings() -> str:
    """Get all findings stored about the current project."""
    try:
        facts = iranti.query_all(ENTITY)
        if not facts:
            return "No findings in shared memory for this entity."
        lines = [f"All findings for {ENTITY}:"]
        for fact in facts:
            summary = fact.get('valueSummary') or fact.get('summary') or fact.get('value', '')
            lines.append(f"  [{fact['key']}] {summary} (confidence: {fact['confidence']})")
        return "\n".join(lines)
    except IrantiError as e:
        return f"Could not retrieve findings: {e}"


# ─── Crew ─────────────────────────────────────────────────────────────────────

def run_treatment_helix():
    print("\n" + "="*60)
    print("  TREATMENT HELIX — With Iranti Shared Memory")
    print("="*60 + "\n")

    # Register agents
    try:
        iranti.register_agent(
            agent_id="helix_researcher",
            name="Helix Researcher",
            description="Reads briefing documents and writes to Iranti",
            capabilities=["document_extraction"],
            model="gpt-4o-mini",
        )
        iranti.register_agent(
            agent_id="helix_analyst",
            name="Helix Analyst",
            description="Summarizes projects using Iranti shared memory",
            capabilities=["summarization"],
            model="gpt-4o-mini",
        )
    except Exception:
        pass  # already registered

    llm = LLM(model="gpt-4o-mini", temperature=0.3)

    # Researcher: receives briefing, writes to Iranti
    researcher = Agent(
        role="Research Analyst",
        goal="Extract key facts from briefing documents and save to shared memory",
        backstory="You read briefing documents, extract facts, and save them for other agents.",
        llm=llm,
        tools=[write_finding],
        verbose=True,
        max_iter=5,
    )

    # Analyst: loads from Iranti, summarizes
    analyst = Agent(
        role="Project Analyst",
        goal="Summarize project status using shared memory",
        backstory="You summarize projects by loading facts from shared memory.",
        llm=llm,
        tools=[get_all_findings, read_finding],
        verbose=True,
        max_iter=5,
    )

    research_task = Task(
        description=f"""
        Read this briefing document and extract the key facts:
        
        {BRIEFING_DOC}
        
        For each fact, use the write_finding tool to save it to shared memory:
        - lead: project lead name
        - budget: budget amount
        - deadline: deadline date
        - status: current status
        - blocker: primary blocker
        
        After saving all facts, return a JSON summary:
        {{
            "facts_saved": <number of facts saved>,
            "lead": "<value>",
            "budget": "<value>",
            "deadline": "<value>",
            "status": "<value>",
            "blocker": "<value>"
        }}
        
        Return ONLY the JSON, no other text.
        """,
        agent=researcher,
        expected_output="JSON with facts_saved and all fact values",
    )

    analysis_task = Task(
        description=f"""
        Summarize the current status of {ENTITY}.
        
        FIRST: Use get_all_findings tool to load all facts from shared memory.
        SECOND: Use the facts to build your summary.
        
        Return a JSON object:
        {{
            "facts_from_memory": <number of facts loaded>,
            "lead": "<value or unknown>",
            "budget": "<value or unknown>",
            "deadline": "<value or unknown>",
            "status": "<value or unknown>",
            "blocker": "<value or unknown>"
        }}
        
        Return ONLY the JSON, no other text.
        """,
        agent=analyst,
        expected_output="JSON with facts_from_memory and all fact values",
        context=[research_task],
    )

    crew = Crew(
        agents=[researcher, analyst],
        tasks=[research_task, analysis_task],
        verbose=True,
    )

    print(f"Running treatment crew for {ENTITY}...")
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
        analyst_value = str(analyst_output.get(key, "")).lower()
        expected_lower = expected_value.lower()
        if expected_lower in analyst_value or analyst_value in expected_lower:
            score += 1

    # Get KB snapshot
    try:
        kb_facts = iranti.query_all(ENTITY)
        kb_snapshot = [
            {"key": f["key"], "summary": f.get("valueSummary") or f.get("summary", ""), "confidence": f["confidence"]}
            for f in kb_facts
        ]
    except:
        kb_snapshot = []

    results = {
        "mode": "treatment_helix",
        "timestamp": datetime.now().isoformat(),
        "entity": ENTITY,
        "researcher_output": researcher_output,
        "analyst_output": analyst_output,
        "expected_facts": HELIX_FACTS,
        "facts_recovered": score,
        "total_facts": len(HELIX_FACTS),
        "accuracy_pct": round(score / len(HELIX_FACTS) * 100, 1),
        "facts_saved_to_iranti": researcher_output.get("facts_saved", 0),
        "facts_loaded_from_iranti": analyst_output.get("facts_from_memory", 0),
        "kb_snapshot": kb_snapshot,
        "iranti_used": True,
    }

    print(f"\n{'='*60}")
    print(f"  TREATMENT HELIX COMPLETE")
    print(f"  Facts recovered: {score}/{len(HELIX_FACTS)} ({results['accuracy_pct']}%)")
    print(f"  Facts saved to Iranti: {results['facts_saved_to_iranti']}")
    print(f"  Facts loaded by analyst: {results['facts_loaded_from_iranti']}")
    print(f"{'='*60}\n")

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(__file__).parent.parent / f"results/treatment_helix_{timestamp}.json"
    output_path.write_text(json.dumps(results, indent=2))
    print(f"Results saved: {output_path}")

    return results


if __name__ == "__main__":
    run_treatment_helix()
