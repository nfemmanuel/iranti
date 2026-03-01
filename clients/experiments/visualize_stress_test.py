"""
STRESS TEST VISUALIZER
======================
Generates charts from stress test results to visualize performance over time.

Usage:
    python visualize_stress_test.py results/stress_test_20260228_120000.json
"""

import json
import sys
from pathlib import Path
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime

def load_results(filepath):
    """Load stress test results from JSON file."""
    with open(filepath, 'r') as f:
        return json.load(f)

def plot_consistency_over_time(results, output_dir):
    """Plot consistency scores over iterations."""
    total_facts = results.get("iterations", len(results.get("control_runs", [])))
    
    control_data = [(r["iteration"], (r["score"] / r["total"]) * 100) for r in results["control_runs"]]
    treatment_data = [(r["iteration"], (r["score"] / r["total"]) * 100) for r in results["treatment_runs"]]
    
    if not control_data and not treatment_data:
        print("No consistency data to plot")
        return
    
    plt.figure(figsize=(12, 6))
    
    if control_data:
        iterations_c, consistency_c = zip(*control_data)
        plt.plot(iterations_c, consistency_c, 'o-', label='Control (No Iranti)', 
                color='#e74c3c', linewidth=2, markersize=8)
    
    if treatment_data:
        iterations_t, consistency_t = zip(*treatment_data)
        plt.plot(iterations_t, consistency_t, 's-', label='Treatment (With Iranti)', 
                color='#2ecc71', linewidth=2, markersize=8)
    
    plt.xlabel('Iteration', fontsize=12)
    plt.ylabel('Fact Recall (%)', fontsize=12)
    plt.title('Fact Recall Over Time', fontsize=14, fontweight='bold')
    plt.legend(fontsize=11)
    plt.grid(True, alpha=0.3)
    plt.ylim(0, 105)
    
    output_path = output_dir / 'consistency_over_time.png'
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    print(f"  Saved: {output_path}")
    plt.close()

def plot_execution_time(results, output_dir):
    """Plot execution time over iterations."""
    control_data = [(r["iteration"], r["elapsed"]) for r in results["control_runs"]]
    treatment_data = [(r["iteration"], r["elapsed"]) for r in results["treatment_runs"]]
    
    if not control_data and not treatment_data:
        print("No timing data to plot")
        return
    
    plt.figure(figsize=(12, 6))
    
    if control_data:
        iterations_c, times_c = zip(*control_data)
        plt.plot(iterations_c, times_c, 'o-', label='Control', 
                color='#e74c3c', linewidth=2, markersize=8)
    
    if treatment_data:
        iterations_t, times_t = zip(*treatment_data)
        plt.plot(iterations_t, times_t, 's-', label='Treatment', 
                color='#2ecc71', linewidth=2, markersize=8)
    
    plt.xlabel('Iteration', fontsize=12)
    plt.ylabel('Execution Time (seconds)', fontsize=12)
    plt.title('Execution Time Over Iterations', fontsize=14, fontweight='bold')
    plt.legend(fontsize=11)
    plt.grid(True, alpha=0.3)
    
    output_path = output_dir / 'execution_time.png'
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    print(f"  Saved: {output_path}")
    plt.close()

def plot_summary_comparison(results, output_dir):
    """Plot summary bar chart comparing control vs treatment."""
    summary = results["summary"]
    
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 6))
    
    # Score comparison
    categories = ['Control', 'Treatment']
    score_values = [
        summary["control"]["avg_score"],
        summary["treatment"]["avg_score"]
    ]
    score_errors = [
        summary["control"]["score_stdev"],
        summary["treatment"]["score_stdev"]
    ]
    
    bars1 = ax1.bar(categories, score_values, yerr=score_errors,
                    color=['#e74c3c', '#2ecc71'], alpha=0.8, capsize=10)
    ax1.set_ylabel('Facts Recalled', fontsize=12)
    ax1.set_title('Average Fact Recall', fontsize=13, fontweight='bold')
    ax1.set_ylim(0, max(score_values) + 1)
    ax1.grid(True, alpha=0.3, axis='y')
    
    # Add value labels on bars
    for bar in bars1:
        height = bar.get_height()
        ax1.text(bar.get_x() + bar.get_width()/2., height,
                f'{height:.1f}', ha='center', va='bottom', fontsize=11)
    
    # Time comparison
    time_values = [
        summary["control"]["avg_time"],
        summary["treatment"]["avg_time"]
    ]
    
    bars2 = ax2.bar(categories, time_values,
                    color=['#e74c3c', '#2ecc71'], alpha=0.8)
    ax2.set_ylabel('Time (seconds)', fontsize=12)
    ax2.set_title('Average Execution Time', fontsize=13, fontweight='bold')
    ax2.grid(True, alpha=0.3, axis='y')
    
    # Add value labels on bars
    for bar in bars2:
        height = bar.get_height()
        ax2.text(bar.get_x() + bar.get_width()/2., height,
                f'{height:.1f}s', ha='center', va='bottom', fontsize=11)
    
    plt.tight_layout()
    output_path = output_dir / 'summary_comparison.png'
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    print(f"  Saved: {output_path}")
    plt.close()

def plot_iranti_usage(results, output_dir):
    """Plot Iranti fact usage over iterations."""
    treatment_data = [
        (r["iteration"], r.get("facts_saved", 0), r.get("facts_loaded", 0))
        for r in results["treatment_runs"]
    ]
    
    if not treatment_data:
        print("No Iranti usage data to plot")
        return
    
    iterations, facts_saved, facts_loaded = zip(*treatment_data)
    
    plt.figure(figsize=(12, 6))
    
    plt.plot(iterations, facts_saved, 'o-', label='Facts Saved', 
            color='#3498db', linewidth=2, markersize=8)
    plt.plot(iterations, facts_loaded, 's-', label='Facts Loaded', 
            color='#9b59b6', linewidth=2, markersize=8)
    
    plt.xlabel('Iteration', fontsize=12)
    plt.ylabel('Number of Facts', fontsize=12)
    plt.title('Iranti Memory Usage Over Time', fontsize=14, fontweight='bold')
    plt.legend(fontsize=11)
    plt.grid(True, alpha=0.3)
    
    output_path = output_dir / 'iranti_usage.png'
    plt.savefig(output_path, dpi=300, bbox_inches='tight')
    print(f"  Saved: {output_path}")
    plt.close()

def generate_report(results, output_dir):
    """Generate markdown report."""
    summary = results['summary']
    report = f"""# Stress Test Report

**Experiment**: {results['experiment']}  
**Entity**: {results['entity']}  
**Test Date**: {results['started_at']}  
**Iterations**: {results['iterations']}  

## Summary

### Fact Recall
- **Control**: {summary['control']['avg_score']:.1f}/{len(results['facts'])} ± {summary['control']['score_stdev']:.2f} ({summary['control']['success_rate']})
- **Treatment**: {summary['treatment']['avg_score']:.1f}/{len(results['facts'])} ± {summary['treatment']['score_stdev']:.2f} ({summary['treatment']['success_rate']})
- **Delta**: {summary['improvement']['score_delta']:+.1f} ({summary['improvement']['score_improvement_pct']:+.1f}%)

### Execution Time
- **Control**: {summary['control']['avg_time']:.2f}s
- **Treatment**: {summary['treatment']['avg_time']:.2f}s
- **Overhead**: {summary['treatment']['avg_time'] - summary['control']['avg_time']:.2f}s ({((summary['treatment']['avg_time'] / summary['control']['avg_time']) - 1) * 100:.1f}% slower)

## Visualizations

![Consistency Over Time](consistency_over_time.png)
![Summary Comparison](summary_comparison.png)
![Execution Time](execution_time.png)
![Iranti Usage](iranti_usage.png)

## Conclusion

{"Both control and treatment achieved 100% fact recall. Treatment demonstrates persistent memory across sessions with expected performance overhead." if summary['improvement']['score_delta'] == 0 else f"Treatment shows {summary['improvement']['score_improvement_pct']:.1f}% improvement in fact recall."}
"""
    
    output_path = output_dir / 'REPORT.md'
    output_path.write_text(report)
    print(f"  Saved: {output_path}")

def main():
    if len(sys.argv) < 2:
        print("Usage: python visualize_stress_test.py <results_file.json>")
        print("\nExample:")
        print("  python visualize_stress_test.py results/stress_test_20260228_120000.json")
        return
    
    results_file = Path(sys.argv[1])
    
    if not results_file.exists():
        print(f"Error: File not found: {results_file}")
        return
    
    print(f"\nLoading results from: {results_file}")
    results = load_results(results_file)
    
    # Create output directory
    output_dir = results_file.parent / f"{results_file.stem}_charts"
    output_dir.mkdir(exist_ok=True)
    
    print(f"\nGenerating visualizations...")
    plot_consistency_over_time(results, output_dir)
    plot_execution_time(results, output_dir)
    plot_summary_comparison(results, output_dir)
    plot_iranti_usage(results, output_dir)
    generate_report(results, output_dir)
    
    print(f"\nAll visualizations saved to: {output_dir}")
    print()

if __name__ == "__main__":
    main()
