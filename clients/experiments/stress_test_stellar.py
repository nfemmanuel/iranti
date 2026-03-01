"""
STRESS TEST EXPERIMENT — Stellar Nexus
=======================================
Longitudinal A/B test measuring Iranti's impact on agent performance over time.

Entity: project/stellar_nexus (NEW - not used in previous tests)
Facts: 6 invented facts with specific, implausible details
Iterations: 5 runs of control vs treatment
Model: GPT-4o-mini

Expected Results:
- Control: Variable consistency (agents research independently)
- Treatment: Higher, more stable consistency (agents share via Iranti)
"""

import os
import sys
import json
import time
from datetime import datetime
from pathlib import Path
from statistics import mean, stdev

sys.path.insert(0, str(Path(__file__).parent.parent))

from crewai import Agent, Task, Crew, LLM
from crewai.tools import tool
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent.parent / '.env')

sys.path.insert(0, str(Path(__file__).parent.parent))
from python.iranti import IrantiClient, IrantiError, IrantiNotFoundError

# ─── Fictional Entity ─────────────────────────────────────────────────────────

ENTITY = "project/stellar_nexus"

STELLAR_FACTS = {
    "lead": "Dr. Amara Okafor",
    "budget": "$15.3 million",
    "deadline": "October 7, 2027",
    "status": "Phase 4: neural substrate mapping",
    "blocker": "Patent dispute with NeuroLink Corp case #2024-CV-8821",
    "tech": "Biomimetic synaptic arrays on Cortex-12 architecture"
}

BRIEFING = f"""
PROJECT STELLAR NEXUS — CONFIDENTIAL BRIEFING

Lead: {STELLAR_FACTS['lead']}
Budget: {STELLAR_FACTS['budget']}
Deadline: {STELLAR_FACTS['deadline']}
Current Status: {STELLAR_FACTS['status']}
Primary Blocker: {STELLAR_FACTS['blocker']}
Technology: {STELLAR_FACTS['tech']}

This is a classified neural computing initiative. All details are fictional
and not present in any public dataset or LLM training corpus.
"""

iranti = IrantiClient(base_url='http://localhost:3001', api_key='dev_test_key_12345')

# ─── Tools ────────────────────────────────────────────────────────────────────

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
            source="stellar_briefing",
            agent="stellar_researcher",
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

# ─── Crew Builders ────────────────────────────────────────────────────────────

def run_control():
    """Control: No Iranti, agents research independently."""
    llm = LLM(model="gpt-4o-mini", temperature=0.3)

    researcher = Agent(
        role="Research Analyst",
        goal="Extract facts from briefing",
        backstory="You extract structured facts from documents.",
        llm=llm,
        verbose=False,
        max_iter=3,
    )

    analyst = Agent(
        role="Project Analyst",
        goal="Summarize project status",
        backstory="You summarize projects for stakeholders.",
        llm=llm,
        verbose=False,
        max_iter=3,
    )

    research_task = Task(
        description=f"Extract facts from: {BRIEFING}\nReturn JSON with: lead, budget, deadline, status, blocker, tech. JSON only.",
        agent=researcher,
        expected_output="JSON with all 6 fields",
    )

    analysis_task = Task(
        description=f"Summarize {ENTITY}. You have NO access to briefing, NO shared memory. Return JSON with: lead, budget, deadline, status, blocker, tech. Use 'unknown' if you don't know. JSON only.",
        agent=analyst,
        expected_output="JSON with all 6 fields",
        context=[research_task],
    )

    crew = Crew(agents=[researcher, analyst], tasks=[research_task, analysis_task], verbose=False)
    start = time.time()
    crew.kickoff()
    elapsed = time.time() - start

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
            return {"parse_error": True}

    analyst_output = parse(analysis_task.output.raw if analysis_task.output else "")
    
    score = 0
    for key, expected in STELLAR_FACTS.items():
        analyst_val = str(analyst_output.get(key, "")).lower()
        if expected.lower() in analyst_val or analyst_val in expected.lower():
            score += 1

    return {
        "score": score,
        "total": len(STELLAR_FACTS),
        "elapsed": round(elapsed, 2),
        "output": analyst_output
    }

def run_treatment():
    """Treatment: With Iranti, agents share via persistent memory."""
    
    # Register agents
    try:
        iranti.register_agent(
            agent_id="stellar_researcher",
            name="Stellar Researcher",
            description="Extracts facts and writes to Iranti",
            capabilities=["extraction"],
            model="gpt-4o-mini",
        )
        iranti.register_agent(
            agent_id="stellar_analyst",
            name="Stellar Analyst",
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
        verbose=False,
        max_iter=5,
    )

    analyst = Agent(
        role="Project Analyst",
        goal="Summarize using shared memory",
        backstory="You load facts from shared memory to build summaries.",
        llm=llm,
        tools=[get_all_findings],
        verbose=False,
        max_iter=5,
    )

    research_task = Task(
        description=f"Extract facts from: {BRIEFING}\nUse write_finding tool to save each: lead, budget, deadline, status, blocker, tech.\nReturn JSON: {{\"facts_saved\": <count>, \"lead\": \"<val>\", ...}}. JSON only.",
        agent=researcher,
        expected_output="JSON with facts_saved and all values",
    )

    analysis_task = Task(
        description=f"Summarize {ENTITY}. FIRST: Use get_all_findings to load from shared memory. SECOND: Build summary.\nReturn JSON: {{\"facts_from_memory\": <count>, \"lead\": \"<val>\", ...}}. JSON only.",
        agent=analyst,
        expected_output="JSON with facts_from_memory and all values",
        context=[research_task],
    )

    crew = Crew(agents=[researcher, analyst], tasks=[research_task, analysis_task], verbose=False)
    start = time.time()
    crew.kickoff()
    elapsed = time.time() - start

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
            return {"parse_error": True}

    analyst_output = parse(analysis_task.output.raw if analysis_task.output else "")
    
    score = 0
    for key, expected in STELLAR_FACTS.items():
        analyst_val = str(analyst_output.get(key, "")).lower()
        if expected.lower() in analyst_val or analyst_val in expected.lower():
            score += 1

    return {
        "score": score,
        "total": len(STELLAR_FACTS),
        "elapsed": round(elapsed, 2),
        "output": analyst_output,
        "facts_saved": analyst_output.get("facts_saved", 0),
        "facts_loaded": analyst_output.get("facts_from_memory", 0)
    }

# ─── Main Experiment ──────────────────────────────────────────────────────────

def run_experiment(iterations=5, delay=30):
    print("\n" + "="*70)
    print("  STRESS TEST EXPERIMENT: Stellar Nexus")
    print("="*70)
    print(f"  Entity: {ENTITY}")
    print(f"  Facts: {len(STELLAR_FACTS)} invented")
    print(f"  Iterations: {iterations}")
    print(f"  Delay: {delay}s between runs")
    print(f"  Model: GPT-4o-mini")
    print()

    results = {
        "experiment": "stellar_nexus_stress_test",
        "entity": ENTITY,
        "facts": STELLAR_FACTS,
        "iterations": iterations,
        "started_at": datetime.now().isoformat(),
        "control_runs": [],
        "treatment_runs": []
    }

    for i in range(iterations):
        print(f"\n[Iteration {i+1}/{iterations}]")
        
        # Control
        print("  Running control (no Iranti)...", end=" ", flush=True)
        try:
            control_result = run_control()
            results["control_runs"].append({
                "iteration": i + 1,
                "timestamp": datetime.now().isoformat(),
                **control_result
            })
            print(f"[OK] {control_result['score']}/{control_result['total']} facts ({control_result['elapsed']}s)")
        except Exception as e:
            print(f"[FAIL] Error: {e}")
            results["control_runs"].append({"iteration": i + 1, "error": str(e)})

        if delay > 0:
            time.sleep(delay)

        # Treatment
        print("  Running treatment (with Iranti)...", end=" ", flush=True)
        try:
            treatment_result = run_treatment()
            results["treatment_runs"].append({
                "iteration": i + 1,
                "timestamp": datetime.now().isoformat(),
                **treatment_result
            })
            print(f"[OK] {treatment_result['score']}/{treatment_result['total']} facts ({treatment_result['elapsed']}s)")
        except Exception as e:
            print(f"[FAIL] Error: {e}")
            results["treatment_runs"].append({"iteration": i + 1, "error": str(e)})

        if i < iterations - 1 and delay > 0:
            time.sleep(delay)

    # Calculate statistics
    control_scores = [r["score"] for r in results["control_runs"] if "score" in r]
    treatment_scores = [r["score"] for r in results["treatment_runs"] if "score" in r]
    control_times = [r["elapsed"] for r in results["control_runs"] if "elapsed" in r]
    treatment_times = [r["elapsed"] for r in results["treatment_runs"] if "elapsed" in r]

    results["summary"] = {
        "completed_at": datetime.now().isoformat(),
        "control": {
            "avg_score": round(mean(control_scores), 2) if control_scores else 0,
            "score_stdev": round(stdev(control_scores), 2) if len(control_scores) > 1 else 0,
            "avg_time": round(mean(control_times), 2) if control_times else 0,
            "success_rate": f"{len(control_scores)}/{iterations}"
        },
        "treatment": {
            "avg_score": round(mean(treatment_scores), 2) if treatment_scores else 0,
            "score_stdev": round(stdev(treatment_scores), 2) if len(treatment_scores) > 1 else 0,
            "avg_time": round(mean(treatment_times), 2) if treatment_times else 0,
            "success_rate": f"{len(treatment_scores)}/{iterations}"
        },
        "improvement": {
            "score_delta": round(mean(treatment_scores) - mean(control_scores), 2) if control_scores and treatment_scores else 0,
            "score_improvement_pct": round(((mean(treatment_scores) - mean(control_scores)) / mean(control_scores) * 100), 1) if control_scores and treatment_scores and mean(control_scores) > 0 else 0
        }
    }

    # Print summary
    print("\n" + "="*70)
    print("  RESULTS")
    print("="*70)
    print(f"\n  Control (no Iranti):")
    print(f"    Avg score: {results['summary']['control']['avg_score']}/{len(STELLAR_FACTS)} ± {results['summary']['control']['score_stdev']}")
    print(f"    Avg time:  {results['summary']['control']['avg_time']}s")
    print(f"    Success:   {results['summary']['control']['success_rate']}")
    
    print(f"\n  Treatment (with Iranti):")
    print(f"    Avg score: {results['summary']['treatment']['avg_score']}/{len(STELLAR_FACTS)} ± {results['summary']['treatment']['score_stdev']}")
    print(f"    Avg time:  {results['summary']['treatment']['avg_time']}s")
    print(f"    Success:   {results['summary']['treatment']['success_rate']}")
    
    print(f"\n  Improvement:")
    print(f"    Score delta: +{results['summary']['improvement']['score_delta']} facts")
    print(f"    Improvement: {results['summary']['improvement']['score_improvement_pct']:+.1f}%")

    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(__file__).parent / f"results/stellar_nexus_stress_{timestamp}.json"
    output_path.write_text(json.dumps(results, indent=2))
    print(f"\n  Results saved: {output_path}")
    print()

    return results

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--delay", type=int, default=30)
    args = parser.parse_args()
    
    run_experiment(args.iterations, args.delay)
