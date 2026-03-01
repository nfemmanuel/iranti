# Stress Testing Guide

## Overview

The stress test framework runs control vs treatment crews multiple times to measure Iranti's impact on agent performance over time.

## Quick Start

### 1. Ensure API Server is Running

```bash
npm run api
```

### 2. Run Stress Test

```bash
cd clients/experiments

# Run 5 iterations with 30s delay between runs
python stress_test.py --iterations 5 --delay 30

# Run 10 iterations with 60s delay (recommended for production testing)
python stress_test.py --iterations 10 --delay 60

# Quick test: 3 iterations, no delay
python stress_test.py --iterations 3 --delay 0
```

### 3. Visualize Results

```bash
# Install matplotlib if needed
pip install matplotlib

# Generate charts
python visualize_stress_test.py results/stress_test_TIMESTAMP.json
```

This creates a folder with:
- `consistency_over_time.png` - Line chart showing consistency trends
- `execution_time.png` - Time performance comparison
- `summary_comparison.png` - Bar charts of averages
- `iranti_usage.png` - Facts saved/loaded over time
- `REPORT.md` - Markdown summary report

## What Gets Measured

### Consistency
- % of fields that match between researcher and analyst
- Measured per target, averaged across all targets
- Higher = better alignment between agents

### Execution Time
- Total seconds from start to finish
- Includes all LLM calls and tool executions
- Lower = faster

### Iranti Usage (Treatment only)
- Facts saved: How many facts researcher wrote to Iranti
- Facts loaded: How many facts analyst retrieved from Iranti
- Higher = more knowledge reuse

### Stability
- Standard deviation across iterations
- Lower = more consistent performance

## Expected Results

**Control (No Iranti)**:
- Consistency: Variable, depends on LLM randomness
- Each agent researches independently
- No knowledge reuse between agents

**Treatment (With Iranti)**:
- Consistency: Higher and more stable
- Analyst builds on researcher's work
- Facts persist across iterations

## Interpreting Results

### Good Signs
- Treatment consistency > Control consistency
- Low standard deviation in treatment runs
- Facts loaded ≈ Facts saved (knowledge reuse working)
- Consistent improvement across iterations

### Red Flags
- Treatment worse than control (indicates Iranti overhead without benefit)
- High standard deviation (unstable performance)
- Facts loaded = 0 (tools not being used)
- Performance degrading over iterations

## Troubleshooting

### "No module named 'matplotlib'"
```bash
pip install matplotlib
```

### "API connection error"
Make sure the API server is running:
```bash
npm run api
```

### "Rate limit exceeded"
Increase `--delay` parameter:
```bash
python stress_test.py --iterations 5 --delay 60
```

### Results show 0% consistency
Check that the LLM is returning valid JSON. Look at raw outputs in the results JSON file.

## Advanced Usage

### Custom Targets

Edit `clients/experiments/shared/agents.py` to change research targets:

```python
RESEARCH_TARGETS = [
    {
        "name": "Your Target",
        "entity": "researcher/your_target",
        "task": "Research this person..."
    }
]
```

### Different Models

Edit the crew files to use different LLMs:

```python
llm = LLM(model="gpt-4", temperature=0.3)  # More expensive, higher quality
llm = LLM(model="gpt-3.5-turbo", temperature=0.3)  # Cheaper, faster
```

### Longer Tests

For production validation, run overnight:

```bash
# 50 iterations with 2 minute delays = ~3 hours
python stress_test.py --iterations 50 --delay 120
```

## Output Files

All results saved to `clients/experiments/results/`:

- `stress_test_TIMESTAMP.json` - Full raw data
- `stress_test_TIMESTAMP_charts/` - Visualizations folder
  - `*.png` - Chart images
  - `REPORT.md` - Summary report

## Example Report

```
Stress Test Report
==================
Test Date: 2026-02-28T14:30:00
Iterations: 10
Model: gpt-4o-mini

Summary
-------
Consistency:
  Control:   67.3% ± 8.2%
  Treatment: 89.1% ± 3.4%
  Improvement: +21.8% (+32.4%)

Execution Time:
  Control:   45.2s ± 5.1s
  Treatment: 48.7s ± 4.2s
  Difference: +3.5s

Iranti Usage:
  Avg Facts Saved:  4.2
  Avg Facts Loaded: 4.1

Conclusion: Treatment shows 32.4% improvement in consistency.
```

## Next Steps

After running stress tests:

1. Review the charts to identify trends
2. Check if consistency improves over iterations (learning effect)
3. Verify facts are being saved and loaded correctly
4. Compare time overhead vs consistency gains
5. Adjust agent prompts if needed
6. Re-run with different models or targets

## Questions?

- Check `docs/validation_results.md` for baseline experiments
- Review `README.md` for architecture details
- Open an issue on GitHub for bugs
