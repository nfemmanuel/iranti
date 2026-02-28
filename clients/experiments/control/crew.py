"""
CONTROL CREW — No Iranti
========================
Two agents research the same targets independently.
No shared memory. Each agent starts from zero.
Results saved to experiments/results/control_TIMESTAMP.json
"""

import os
import sys
import json
import time
from datetime import datetime
from pathlib import Path

# Add parent dirs to path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from crewai import Agent, Task, Crew, LLM
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent.parent / '.env')

sys.path.insert(0, str(Path(__file__).parent.parent / 'shared'))
from agents import (
    RESEARCHER_ROLE, RESEARCHER_GOAL, RESEARCHER_BACKSTORY,
    ANALYST_ROLE, ANALYST_GOAL, ANALYST_BACKSTORY,
    RESEARCH_TARGETS
)

# ─── Metrics ─────────────────────────────────────────────────────────────────

class MetricsTracker:
    def __init__(self):
        self.api_calls = 0
        self.start_time = time.time()
        self.agent_outputs = {}
        self.facts_per_agent = {}

    def record_output(self, agent_role: str, target: str, output: str):
        key = f"{agent_role}:{target}"
        self.agent_outputs[key] = output
        self.api_calls += 1

    def elapsed(self) -> float:
        return round(time.time() - self.start_time, 2)


# ─── Setup ────────────────────────────────────────────────────────────────────

def build_crew(target: dict, tracker: MetricsTracker) -> tuple:
    llm = LLM(
        model="gemini/gemini-2.0-flash",
        api_key=os.getenv("GEMINI_API_KEY"),
        temperature=0.3,
    )

    researcher = Agent(
        role=RESEARCHER_ROLE,
        goal=RESEARCHER_GOAL,
        backstory=RESEARCHER_BACKSTORY,
        llm=llm,
        verbose=True,
        max_iter=3,
    )

    analyst = Agent(
        role=ANALYST_ROLE,
        goal=ANALYST_GOAL,
        backstory=ANALYST_BACKSTORY,
        llm=llm,
        verbose=True,
        max_iter=3,
    )

    research_task = Task(
        description=f"""
        {target['task']}
        
        Return a structured profile with exactly these fields:
        - name: full name
        - affiliation: current institution or employer
        - publication_count: approximate number (give a number, not a range)
        - research_focus: primary area (one phrase)
        - notable_contribution: most significant work or achievement
        - confidence: your confidence level 0-100
        
        Return as JSON only. No other text.
        """,
        agent=researcher,
        expected_output="JSON with name, affiliation, publication_count, research_focus, notable_contribution, confidence",
    )

    analysis_task = Task(
        description=f"""
        You are verifying research about {target['name']}.
        
        The researcher above has already investigated this person.
        WITHOUT access to their findings (you have no shared memory),
        independently verify by answering the same questions:
        
        - name: full name
        - affiliation: current institution or employer  
        - publication_count: approximate number (give a number, not a range)
        - research_focus: primary area (one phrase)
        - notable_contribution: most significant work or achievement
        - confidence: your confidence level 0-100
        
        Return as JSON only. No other text.
        """,
        agent=analyst,
        expected_output="JSON with name, affiliation, publication_count, research_focus, notable_contribution, confidence",
        context=[research_task],
    )

    crew = Crew(
        agents=[researcher, analyst],
        tasks=[research_task, analysis_task],
        verbose=True,
    )

    return crew, research_task, analysis_task


# ─── Run ──────────────────────────────────────────────────────────────────────

def run_control():
    print("\n" + "="*60)
    print("  CONTROL CREW — No Shared Memory")
    print("="*60 + "\n")

    tracker = MetricsTracker()
    results = {
        "mode": "control",
        "timestamp": datetime.now().isoformat(),
        "targets": [],
        "summary": {}
    }

    for i, target in enumerate(RESEARCH_TARGETS):
        print(f"\n[{i+1}/{len(RESEARCH_TARGETS)}] Researching: {target['name']}")
        print("-" * 40)

        target_result = {
            "name": target["name"],
            "entity": target["entity"],
            "researcher_output": None,
            "analyst_output": None,
            "consistency": None,
            "api_calls_this_target": 0,
        }

        try:
            crew, research_task, analysis_task = build_crew(target, tracker)
            call_start = tracker.api_calls

            crew_result = crew.kickoff()

            # Extract individual task outputs
            researcher_raw = research_task.output.raw if research_task.output else ""
            analyst_raw = analysis_task.output.raw if analysis_task.output else ""

            # Parse JSON outputs
            def parse_output(raw: str) -> dict:
                try:
                    clean = raw.replace('```json', '').replace('```', '').strip()
                    return json.loads(clean)
                except:
                    return {"raw": raw, "parse_error": True}

            researcher_data = parse_output(researcher_raw)
            analyst_data = parse_output(analyst_raw)

            target_result["researcher_output"] = researcher_data
            target_result["analyst_output"] = analyst_data
            target_result["api_calls_this_target"] = tracker.api_calls - call_start + 2

            # Calculate consistency between researcher and analyst
            consistency = calculate_consistency(researcher_data, analyst_data)
            target_result["consistency"] = consistency

            print(f"\n  Researcher says: {json.dumps(researcher_data, indent=2)}")
            print(f"\n  Analyst says:    {json.dumps(analyst_data, indent=2)}")
            print(f"\n  Consistency:     {consistency['score']}% ({consistency['matching_fields']}/{consistency['total_fields']} fields match)")

            # Rate limit buffer
            if i < len(RESEARCH_TARGETS) - 1:
                print("\n  [Rate limit buffer: 15s]")
                time.sleep(15)

        except Exception as e:
            target_result["error"] = str(e)
            print(f"  Error: {e}")

        results["targets"].append(target_result)

    # Summary
    consistency_scores = [
        t["consistency"]["score"]
        for t in results["targets"]
        if t.get("consistency")
    ]

    results["summary"] = {
        "total_targets": len(RESEARCH_TARGETS),
        "avg_consistency": round(sum(consistency_scores) / len(consistency_scores), 1) if consistency_scores else 0,
        "total_elapsed_seconds": tracker.elapsed(),
        "iranti_used": False,
    }

    print(f"\n{'='*60}")
    print(f"  CONTROL COMPLETE")
    print(f"  Avg consistency: {results['summary']['avg_consistency']}%")
    print(f"  Time elapsed:    {results['summary']['total_elapsed_seconds']}s")
    print(f"{'='*60}\n")

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(__file__).parent.parent / f"results/control_{timestamp}.json"
    output_path.write_text(json.dumps(results, indent=2))
    print(f"Results saved: {output_path}")

    return results


def calculate_consistency(a: dict, b: dict) -> dict:
    """Compare two researcher profiles field by field."""
    if "parse_error" in a or "parse_error" in b:
        return {"score": 0, "matching_fields": 0, "total_fields": 0, "details": {}}

    fields = ["affiliation", "research_focus", "notable_contribution"]
    numeric_fields = ["publication_count", "confidence"]
    details = {}
    matches = 0
    total = 0

    for field in fields:
        val_a = str(a.get(field, "")).lower().strip()
        val_b = str(b.get(field, "")).lower().strip()
        if val_a and val_b:
            # Check for substantial overlap (at least one key word matches)
            words_a = set(val_a.split())
            words_b = set(val_b.split())
            significant_a = {w for w in words_a if len(w) > 4}
            significant_b = {w for w in words_b if len(w) > 4}
            overlap = significant_a & significant_b
            match = len(overlap) >= 1
            details[field] = {
                "researcher": val_a,
                "analyst": val_b,
                "match": match,
                "overlap_words": list(overlap),
            }
            if match:
                matches += 1
            total += 1

    for field in numeric_fields:
        val_a = a.get(field)
        val_b = b.get(field)
        if val_a is not None and val_b is not None:
            try:
                diff = abs(int(val_a) - int(val_b))
                match = diff <= max(10, int(val_a) * 0.2)  # within 20%
                details[field] = {
                    "researcher": val_a,
                    "analyst": val_b,
                    "match": match,
                    "diff": diff,
                }
                if match:
                    matches += 1
                total += 1
            except (ValueError, TypeError):
                pass

    score = round((matches / total * 100)) if total > 0 else 0
    return {
        "score": score,
        "matching_fields": matches,
        "total_fields": total,
        "details": details,
    }


if __name__ == "__main__":
    run_control()
