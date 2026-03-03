# Iranti A/B Test — CrewAI Experiments

This folder contains an A/B test comparing multi-agent research crews **with** and **without** Iranti shared memory.

## Structure

```
experiments/
├── shared/
│   └── agents.py          # Agent definitions used by both crews
├── control/
│   └── crew.py            # No Iranti — agents start from zero
├── treatment/
│   └── crew.py            # With Iranti — agents share memory
├── results/               # JSON output files
└── compare.py             # Comparison script
```

## Setup

1. **Activate virtual environment:**
   ```bash
   clients\experiments\venv\Scripts\activate
   ```

2. **Ensure Iranti API is running:**
   ```bash
   npm run api
   ```

3. **Verify Gemini API key in `.env`:**
   ```env
   GEMINI_API_KEY=your_key_here
   ```

## Running the Experiment

### Control (No Iranti)
```bash
cd clients\experiments
python control/crew.py
```

### Treatment (With Iranti)
```bash
cd clients\experiments
python treatment/crew.py
```

### Compare Results
```bash
python compare.py
```

### 60-Second Memory Demo
```bash
python demo_entity_memory_loop.py
```
This prints:
- detected entities
- resolved canonical entities
- injected keys
- already-present count
- HTTP status metadata for write/query/observe

## What Gets Measured

- **Consistency**: % of fields that match between researcher and analyst
- **Knowledge Reuse**: How many facts the analyst loaded from Iranti
- **Time**: Total elapsed time for each crew
- **Field-Level Breakdown**: Which specific fields matched/mismatched

## Expected Outcome

**Control**: Agents research independently. No shared memory. Lower consistency expected.

**Treatment**: Researcher writes to Iranti. Analyst loads from Iranti before acting. Higher consistency expected due to shared knowledge base.

## Research Targets

- Yann LeCun
- Andrej Karpathy
- Fei-Fei Li

All are well-documented AI researchers, ensuring LLMs have accurate training data.
