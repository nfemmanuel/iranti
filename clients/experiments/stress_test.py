"""
IRANTI STRESS TEST — Longitudinal A/B Performance Analysis
===========================================================
Runs control vs treatment crews multiple times to measure:
- Consistency over iterations
- Performance degradation/improvement
- Memory effectiveness
- Time efficiency
- Error rates

Usage:
    python stress_test.py --iterations 10 --delay 30
"""

import os
import sys
import json
import time
import argparse
from datetime import datetime
from pathlib import Path
from statistics import mean, stdev

sys.path.insert(0, str(Path(__file__).parent.parent))

# Import the crew runners
from control.crew import run_control
from treatment.crew import run_treatment

def section(title):
    print(f"\n{'='*70}")
    print(f"  {title}")
    print('='*70)

def run_stress_test(iterations: int, delay_seconds: int):
    """Run both control and treatment crews multiple times and compare."""
    
    section("IRANTI STRESS TEST")
    print(f"  Iterations: {iterations}")
    print(f"  Delay between runs: {delay_seconds}s")
    print(f"  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    results = {
        "test_config": {
            "iterations": iterations,
            "delay_seconds": delay_seconds,
            "started_at": datetime.now().isoformat(),
            "model": "gpt-4o-mini",
        },
        "control_runs": [],
        "treatment_runs": [],
        "summary": {}
    }
    
    # Run iterations
    for i in range(iterations):
        section(f"ITERATION {i+1}/{iterations}")
        
        # Control run
        print(f"\n[{i+1}] Running CONTROL (no Iranti)...")
        try:
            control_result = run_control()
            results["control_runs"].append({
                "iteration": i + 1,
                "timestamp": datetime.now().isoformat(),
                "summary": control_result.get("summary", {}),
                "targets": control_result.get("targets", []),
            })
            print(f"  Control complete: {control_result['summary']['avg_consistency']}% consistency")
        except Exception as e:
            print(f"  Control FAILED: {e}")
            results["control_runs"].append({
                "iteration": i + 1,
                "error": str(e)
            })
        
        # Delay between control and treatment
        if delay_seconds > 0:
            print(f"\n  Waiting {delay_seconds}s before treatment...")
            time.sleep(delay_seconds)
        
        # Treatment run
        print(f"\n[{i+1}] Running TREATMENT (with Iranti)...")
        try:
            treatment_result = run_treatment()
            results["treatment_runs"].append({
                "iteration": i + 1,
                "timestamp": datetime.now().isoformat(),
                "summary": treatment_result.get("summary", {}),
                "targets": treatment_result.get("targets", []),
            })
            print(f"  Treatment complete: {treatment_result['summary']['avg_consistency']}% consistency")
            print(f"  Facts saved: {treatment_result['summary']['total_facts_saved_to_iranti']}")
            print(f"  Facts loaded: {treatment_result['summary']['total_facts_loaded_from_iranti']}")
        except Exception as e:
            print(f"  Treatment FAILED: {e}")
            results["treatment_runs"].append({
                "iteration": i + 1,
                "error": str(e)
            })
        
        # Delay before next iteration
        if i < iterations - 1 and delay_seconds > 0:
            print(f"\n  Waiting {delay_seconds}s before next iteration...")
            time.sleep(delay_seconds)
    
    # Calculate summary statistics
    section("CALCULATING STATISTICS")
    
    control_consistencies = [
        r["summary"]["avg_consistency"] 
        for r in results["control_runs"] 
        if "summary" in r and "avg_consistency" in r["summary"]
    ]
    
    treatment_consistencies = [
        r["summary"]["avg_consistency"]
        for r in results["treatment_runs"]
        if "summary" in r and "avg_consistency" in r["summary"]
    ]
    
    control_times = [
        r["summary"]["total_elapsed_seconds"]
        for r in results["control_runs"]
        if "summary" in r and "total_elapsed_seconds" in r["summary"]
    ]
    
    treatment_times = [
        r["summary"]["total_elapsed_seconds"]
        for r in results["treatment_runs"]
        if "summary" in r and "total_elapsed_seconds" in r["summary"]
    ]
    
    treatment_facts_saved = [
        r["summary"]["total_facts_saved_to_iranti"]
        for r in results["treatment_runs"]
        if "summary" in r and "total_facts_saved_to_iranti" in r["summary"]
    ]
    
    treatment_facts_loaded = [
        r["summary"]["total_facts_loaded_from_iranti"]
        for r in results["treatment_runs"]
        if "summary" in r and "total_facts_loaded_from_iranti" in r["summary"]
    ]
    
    results["summary"] = {
        "completed_at": datetime.now().isoformat(),
        "total_iterations": iterations,
        "successful_control_runs": len(control_consistencies),
        "successful_treatment_runs": len(treatment_consistencies),
        
        "control": {
            "avg_consistency": round(mean(control_consistencies), 2) if control_consistencies else 0,
            "consistency_stdev": round(stdev(control_consistencies), 2) if len(control_consistencies) > 1 else 0,
            "min_consistency": min(control_consistencies) if control_consistencies else 0,
            "max_consistency": max(control_consistencies) if control_consistencies else 0,
            "avg_time_seconds": round(mean(control_times), 2) if control_times else 0,
            "time_stdev": round(stdev(control_times), 2) if len(control_times) > 1 else 0,
        },
        
        "treatment": {
            "avg_consistency": round(mean(treatment_consistencies), 2) if treatment_consistencies else 0,
            "consistency_stdev": round(stdev(treatment_consistencies), 2) if len(treatment_consistencies) > 1 else 0,
            "min_consistency": min(treatment_consistencies) if treatment_consistencies else 0,
            "max_consistency": max(treatment_consistencies) if treatment_consistencies else 0,
            "avg_time_seconds": round(mean(treatment_times), 2) if treatment_times else 0,
            "time_stdev": round(stdev(treatment_times), 2) if len(treatment_times) > 1 else 0,
            "avg_facts_saved": round(mean(treatment_facts_saved), 2) if treatment_facts_saved else 0,
            "avg_facts_loaded": round(mean(treatment_facts_loaded), 2) if treatment_facts_loaded else 0,
        },
        
        "comparison": {
            "consistency_improvement": round(
                mean(treatment_consistencies) - mean(control_consistencies), 2
            ) if control_consistencies and treatment_consistencies else 0,
            "consistency_improvement_pct": round(
                ((mean(treatment_consistencies) - mean(control_consistencies)) / mean(control_consistencies) * 100), 2
            ) if control_consistencies and treatment_consistencies and mean(control_consistencies) > 0 else 0,
            "time_difference": round(
                mean(treatment_times) - mean(control_times), 2
            ) if control_times and treatment_times else 0,
        }
    }
    
    # Print summary
    section("STRESS TEST RESULTS")
    
    print(f"\n  Successful Runs:")
    print(f"    Control:   {results['summary']['successful_control_runs']}/{iterations}")
    print(f"    Treatment: {results['summary']['successful_treatment_runs']}/{iterations}")
    
    print(f"\n  Consistency (% fields matching):")
    print(f"    Control:   {results['summary']['control']['avg_consistency']}% ± {results['summary']['control']['consistency_stdev']}%")
    print(f"    Treatment: {results['summary']['treatment']['avg_consistency']}% ± {results['summary']['treatment']['consistency_stdev']}%")
    print(f"    Delta:     +{results['summary']['comparison']['consistency_improvement']}% ({results['summary']['comparison']['consistency_improvement_pct']:+.1f}%)")
    
    print(f"\n  Execution Time (seconds):")
    print(f"    Control:   {results['summary']['control']['avg_time_seconds']}s ± {results['summary']['control']['time_stdev']}s")
    print(f"    Treatment: {results['summary']['treatment']['avg_time_seconds']}s ± {results['summary']['treatment']['time_stdev']}s")
    print(f"    Delta:     {results['summary']['comparison']['time_difference']:+.2f}s")
    
    print(f"\n  Iranti Usage (Treatment only):")
    print(f"    Avg facts saved:  {results['summary']['treatment']['avg_facts_saved']}")
    print(f"    Avg facts loaded: {results['summary']['treatment']['avg_facts_loaded']}")
    
    print(f"\n  Consistency Range:")
    print(f"    Control:   {results['summary']['control']['min_consistency']}% - {results['summary']['control']['max_consistency']}%")
    print(f"    Treatment: {results['summary']['treatment']['min_consistency']}% - {results['summary']['treatment']['max_consistency']}%")
    
    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = Path(__file__).parent / f"results/stress_test_{timestamp}.json"
    output_path.write_text(json.dumps(results, indent=2))
    
    print(f"\n  Full results saved: {output_path}")
    print()
    
    return results

def main():
    parser = argparse.ArgumentParser(description="Run Iranti stress test")
    parser.add_argument("--iterations", type=int, default=5, help="Number of iterations to run (default: 5)")
    parser.add_argument("--delay", type=int, default=30, help="Delay in seconds between runs (default: 30)")
    
    args = parser.parse_args()
    
    if args.iterations < 1:
        print("Error: iterations must be at least 1")
        return
    
    if args.delay < 0:
        print("Error: delay cannot be negative")
        return
    
    run_stress_test(args.iterations, args.delay)

if __name__ == "__main__":
    main()
