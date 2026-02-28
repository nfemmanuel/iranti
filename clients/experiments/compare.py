"""
Compare control vs treatment results.
Usage: python compare.py
Reads the most recent control and treatment JSON files from results/
"""

import json
import sys
from pathlib import Path
from datetime import datetime


def load_latest(mode: str) -> dict:
    results_dir = Path(__file__).parent / "results"
    files = sorted(results_dir.glob(f"{mode}_*.json"), reverse=True)
    if not files:
        print(f"No {mode} results found. Run {mode}/crew.py first.")
        sys.exit(1)
    print(f"Loading: {files[0].name}")
    return json.loads(files[0].read_text())


def compare():
    print("\n" + "="*60)
    print("  IRANTI A/B TEST RESULTS")
    print("="*60)

    control = load_latest("control")
    treatment = load_latest("treatment")

    print(f"\n  Control:   {control['timestamp'][:19]}")
    print(f"  Treatment: {treatment['timestamp'][:19]}")

    # ── Consistency ───────────────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print("  CONSISTENCY (% of fields that agree between agents)")
    print(f"{'─'*60}")

    for i, (c_target, t_target) in enumerate(zip(control["targets"], treatment["targets"])):
        name = c_target["name"]
        c_score = c_target.get("consistency", {}).get("score", "N/A")
        t_score = t_target.get("consistency", {}).get("score", "N/A")
        delta = f"+{t_score - c_score}" if isinstance(t_score, int) and isinstance(c_score, int) else "N/A"
        print(f"\n  {name}")
        print(f"    Control:   {c_score}%")
        print(f"    Treatment: {t_score}%  ({delta})")

    c_avg = control["summary"]["avg_consistency"]
    t_avg = treatment["summary"]["avg_consistency"]
    print(f"\n  AVERAGE")
    print(f"    Control:   {c_avg}%")
    print(f"    Treatment: {t_avg}%  (+{round(t_avg - c_avg, 1)})")

    # ── Knowledge Accumulation ────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print("  KNOWLEDGE ACCUMULATION (Iranti only)")
    print(f"{'─'*60}")

    total_saved = treatment["summary"].get("total_facts_saved_to_iranti", 0)
    total_loaded = treatment["summary"].get("total_facts_loaded_from_iranti", 0)

    print(f"\n  Facts saved to Iranti:      {total_saved}")
    print(f"  Facts loaded by analysts:   {total_loaded}")
    print(f"  Reuse rate:                 {round(total_loaded/total_saved*100) if total_saved > 0 else 0}%")

    for t_target in treatment["targets"]:
        name = t_target["name"]
        kb = t_target.get("kb_facts_stored", 0)
        saved = t_target.get("facts_saved_to_iranti", 0)
        loaded = t_target.get("facts_loaded_from_iranti", 0)
        print(f"\n  {name}")
        print(f"    KB facts stored:   {kb}")
        print(f"    Researcher saved:  {saved}")
        print(f"    Analyst loaded:    {loaded}")

    # ── Time ─────────────────────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print("  TIME")
    print(f"{'─'*60}")
    print(f"\n  Control:   {control['summary']['total_elapsed_seconds']}s")
    print(f"  Treatment: {treatment['summary']['total_elapsed_seconds']}s")

    # ── Field-level consistency breakdown ────────────────────────────────────
    print(f"\n{'─'*60}")
    print("  FIELD-LEVEL CONSISTENCY BREAKDOWN")
    print(f"{'─'*60}")

    fields = ["affiliation", "publication_count", "research_focus", "notable_contribution"]

    for field in fields:
        c_matches = sum(
            1 for t in control["targets"]
            if t.get("consistency", {}).get("details", {}).get(field, {}).get("match", False)
        )
        t_matches = sum(
            1 for t in treatment["targets"]
            if t.get("consistency", {}).get("details", {}).get(field, {}).get("match", False)
        )
        total = len(control["targets"])
        print(f"\n  {field}")
        print(f"    Control:   {c_matches}/{total} targets matched")
        print(f"    Treatment: {t_matches}/{total} targets matched")

    # ── Verdict ───────────────────────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("  VERDICT")
    print(f"{'='*60}\n")

    improvement = round(t_avg - c_avg, 1)
    if improvement > 10:
        print(f"  ✓ Iranti improved consistency by {improvement} percentage points.")
    elif improvement > 0:
        print(f"  ~ Modest improvement: +{improvement} percentage points.")
    else:
        print(f"  ✗ No consistency improvement detected ({improvement}pp).")

    if total_loaded > 0:
        print(f"  ✓ Analysts used shared memory ({total_loaded} facts loaded).")
    else:
        print(f"  ✗ Analysts did not load from shared memory.")

    print()


if __name__ == "__main__":
    compare()
