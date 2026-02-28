"""
TREATMENT CREW — With Iranti
=============================
Two agents research the same targets.
Agent 1 writes findings to Iranti.
Agent 2 gets a working memory brief from Iranti before acting.
Agent 2 builds on Agent 1's work instead of starting from zero.
Results saved to experiments/results/treatment_TIMESTAMP.json
"""

import os
import sys
import json
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from crewai import Agent, Task, Crew, LLM
from crewai.tools import tool
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent.parent / '.env')

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from python.iranti import IrantiClient, IrantiError

sys.path.insert(0, str(Path(__file__).parent.parent / 'shared'))
from agents import (
    RESEARCHER_ROLE, RESEARCHER_GOAL, RESEARCHER_BACKSTORY,
    ANALYST_ROLE, ANALYST_GOAL, ANALYST_BACKSTORY,
    RESEARCH_TARGETS
)

from control.crew import calculate_consistency

# ─── Iranti Client ────────────────────────────────────────────────────────────

iranti = IrantiClient()
CURRENT_ENTITY = None  # set per target


# ─── Iranti Tools ─────────────────────────────────────────────────────────────

@tool("Write finding to shared memory")
def write_finding(key: str, value: str, summary: str, confidence: int) -> str:
    """
    Write a research finding to shared memory so other agents can use it.
    Args:
        key: fact name in snake_case e.g. 'affiliation'
        value: the finding as a string
        summary: one sentence summary
        confidence: 0-100
    """
    try:
        result = iranti.write(
            entity=CURRENT_ENTITY,
            key=key,
            value={"data": value},
            summary=summary,
            confidence=confidence,
            source="crewai_researcher",
            agent="crewai_researcher",
        )
        return f"Saved '{key}': {result.action}"
    except IrantiError as e:
        return f"Could not save to memory: {e}"


@tool("Read finding from shared memory")  
def read_finding(key: str) -> str:
    """
    Read a specific finding from shared memory.
    Args:
        key: fact name e.g. 'affiliation'
    """
    try:
        result = iranti.query(CURRENT_ENTITY, key)
        if result.found:
            return f"Found '{key}': {result.value} (confidence: {result.confidence}, source: {result.source})"
        return f"No finding for '{key}' in shared memory yet."
    except IrantiError as e:
        return f"Could not read from memory: {e}"


@tool("Get working memory brief")
def get_memory_brief(task_description: str) -> str:
    """
    Get a working memory brief with all relevant findings for current task.
    Call this at the start of your work to see what's already been discovered.
    Args:
        task_description: what you're about to do
    """
    try:
        brief = iranti.handshake(
            agent="crewai_analyst",
            task=task_description,
            recent_messages=["Starting analysis task"],
        )
        if not brief.working_memory:
            return "No prior findings in shared memory yet."
        
        lines = [f"Working memory ({len(brief.working_memory)} entries):"]
        for entry in brief.working_memory:
            lines.append(f"  - {entry.entity_key}: {entry.summary} (confidence: {entry.confidence})")
        return "\n".join(lines)
    except IrantiError as e:
        return f"Could not load memory brief: {e}"


@tool("Get all findings for current entity")
def get_all_findings() -> str:
    """Get all findings stored about the current research target."""
    try:
        facts = iranti.query_all(CURRENT_ENTITY)
        if not facts:
            return "No findings in shared memory for this entity."
        lines = [f"All findings for {CURRENT_ENTITY}:"]
        for fact in facts:
            lines.append(f"  [{fact['key']}] {fact['valueSummary']} (confidence: {fact['confidence']})")
        return "\n".join(lines)
    except IrantiError as e:
        return f"Could not retrieve findings: {e}"


# ─── Crew Builder ─────────────────────────────────────────────────────────────

def build_treatment_crew(target: dict) -> tuple:
    llm = LLM(
        model="gemini/gemini-2.0-flash",
        api_key=os.getenv("GEMINI_API_KEY"),
        temperature=0.3,
    )

    researcher = Agent(
        role=RESEARCHER_ROLE,
        goal=RESEARCHER_GOAL + " Save each finding to shared memory as you go.",
        backstory=RESEARCHER_BACKSTORY,
        llm=llm,
        tools=[write_finding, read_finding],
        verbose=True,
        max_iter=5,
    )

    analyst = Agent(
        role=ANALYST_ROLE,
        goal=ANALYST_GOAL + " Always check shared memory first before doing independent research.",
        backstory=ANALYST_BACKSTORY,
        llm=llm,
        tools=[get_memory_brief, get_all_findings, read_finding],
        verbose=True,
        max_iter=5,
    )

    research_task = Task(
        description=f"""
        {target['task']}
        
        As you discover each fact, save it to shared memory using the write_finding tool.
        Save these specific keys: affiliation, publication_count, research_focus, notable_contribution
        
        Then return a structured profile:
        - name: full name
        - affiliation: current institution or employer
        - publication_count: approximate number
        - research_focus: primary area (one phrase)
        - notable_contribution: most significant work or achievement
        - confidence: your confidence level 0-100
        - facts_saved: how many facts you saved to shared memory
        
        Return as JSON only.
        """,
        agent=researcher,
        expected_output="JSON with all profile fields plus facts_saved count",
    )

    analysis_task = Task(
        description=f"""
        You are verifying and enriching research about {target['name']}.
        
        FIRST: Use get_all_findings tool to see what the researcher already found.
        SECOND: Use get_memory_brief tool to get your working memory brief.
        THIRD: Build on the existing findings rather than starting from scratch.
        FOURTH: Add or correct any facts you can verify.
        
        Return your final verified profile:
        - name: full name
        - affiliation: current institution or employer
        - publication_count: approximate number
        - research_focus: primary area (one phrase)
        - notable_contribution: most significant work or achievement
        - confidence: your confidence level 0-100
        - facts_from_memory: how many facts you loaded from shared memory
        - facts_added: how many new facts you added
        
        Return as JSON only.
        """,
        agent=analyst,
        expected_output="JSON with all profile fields plus memory usage stats",
        context=[research_task],
    )

    crew = Crew(
        agents=[researcher, analyst],
        tasks=[research_task, analysis_task],
        verbose=True,
    )

    return crew, research_task, analysis_task


# ─── Run ──────────────────────────────────────────────────────────────────────

def run_treatment():
    global CURRENT_ENTITY

    print("\n" + "="*60)
    print("  TREATMENT CREW — With Iranti Shared Memory")
    print("="*60 + "\n")

    # Register agents
    try:
        iranti.register_agent(
            agent_id="crewai_researcher",
            name="CrewAI Researcher",
            description="Researches academic profiles and writes to Iranti",
            capabilities=["research", "data_extraction"],
            model="gemini-2.0-flash",
        )
        iranti.register_agent(
            agent_id="crewai_analyst",
            name="CrewAI Analyst",
            description="Verifies research using Iranti shared memory",
            capabilities=["verification", "analysis"],
            model="gemini-2.0-flash",
        )
    except Exception:
        pass  # already registered from previous run

    start_time = time.time()
    results = {
        "mode": "treatment",
        "timestamp": datetime.now().isoformat(),
        "targets": [],
        "summary": {}
    }

    for i, target in enumerate(RESEARCH_TARGETS):
        print(f"\n[{i+1}/{len(RESEARCH_TARGETS)}] Researching: {target['name']}")
        print("-" * 40)

        CURRENT_ENTITY = target["entity"]

        target_result = {
            "name": target["name"],
            "entity": target["entity"],
            "researcher_output": None,
            "analyst_output": None,
            "consistency": None,
            "facts_saved_to_iranti": 0,
            "facts_loaded_from_iranti": 0,
        }

        try:
            crew, research_task, analysis_task = build_treatment_crew(target)
            crew.kickoff()

            def parse_output(raw: str) -> dict:
                try:
                    clean = raw.replace('```json', '').replace('```', '').strip()
                    return json.loads(clean)
                except:
                    return {"raw": raw, "parse_error": True}

            researcher_data = parse_output(research_task.output.raw if research_task.output else "")
            analyst_data = parse_output(analysis_task.output.raw if analysis_task.output else "")

            target_result["researcher_output"] = researcher_data
            target_result["analyst_output"] = analyst_data
            target_result["facts_saved_to_iranti"] = researcher_data.get("facts_saved", 0)
            target_result["facts_loaded_from_iranti"] = analyst_data.get("facts_from_memory", 0)

            consistency = calculate_consistency(researcher_data, analyst_data)
            target_result["consistency"] = consistency

            # Pull final KB state for this entity
            try:
                kb_facts = iranti.query_all(CURRENT_ENTITY)
                target_result["kb_facts_stored"] = len(kb_facts)
                target_result["kb_snapshot"] = [
                    {"key": f["key"], "summary": f["valueSummary"], "confidence": f["confidence"]}
                    for f in kb_facts
                ]
            except:
                pass

            print(f"\n  Researcher says:        {json.dumps(researcher_data, indent=2)}")
            print(f"\n  Analyst says:           {json.dumps(analyst_data, indent=2)}")
            print(f"\n  Consistency:            {consistency['score']}%")
            print(f"  Facts saved to Iranti:  {target_result['facts_saved_to_iranti']}")
            print(f"  Facts loaded by Analyst:{target_result['facts_loaded_from_iranti']}")

            if i < len(RESEARCH_TARGETS) - 1:
                print("\n  [Rate limit buffer: 15s]")
                time.sleep(15)

        except Exception as e:
            target_result["error"] = str(e)
            print(f"  Error: {e}")

        results["targets"].append(target_result)

    consistency_scores = [
        t["consistency"]["score"]
        for t in results["targets"]
        if t.get("consistency")
    ]

    total_facts_saved = sum(
        t.get("facts_saved_to_iranti", 0) for t in results["targets"]
    )
    total_facts_loaded = sum(
        t.get("facts_loaded_from_iranti", 0) for t in results["targets"]
    )

    results["summary"] = {
        "total_targets": len(RESEARCH_TARGETS),
        "avg_consistency": round(sum(consistency_scores) / len(consistency_scores), 1) if consistency_scores else 0,
        "total_elapsed_seconds": round(time.time() - start_time, 2),
        "total_facts_saved_to_iranti": total_facts_saved,
        "total_facts_loaded_from_iranti": total_facts_loaded,
        "iranti_used": True,
    }

    print(f"\n{'='*60}")
    print(f"  TREATMENT COMPLETE")
    print(f"  Avg consistency:          {results['summary']['avg_consistency']}%")
    print(f"  Facts saved to Iranti:    {total_facts_saved}")
    print(f"  Facts loaded by analysts: {total_facts_loaded}")
    print(f"  Time elapsed:             {results['summary']['total_elapsed_seconds']}s")
    print(f"{'='*60}\n")

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(__file__).parent.parent / f"results/treatment_{timestamp}.json"
    output_path.write_text(json.dumps(results, indent=2))
    print(f"Results saved: {output_path}")

    return results


if __name__ == "__main__":
    run_treatment()
