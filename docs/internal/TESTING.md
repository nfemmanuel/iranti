# Testing Standards for Iranti

This document defines testing standards for all Iranti contributors. Follow these principles to ensure experiments produce valid, reproducible results.

---

## Core Principles

### 1. Fictional Entities Only

**All experiments must use fictional entities with invented facts that cannot exist in any LLM training corpus.**

- ❌ **NEVER** use real people, real organizations, or real projects as test subjects
- ❌ **NEVER** use publicly known entities (e.g., `researcher/yann_lecun`, `company/google`)
- ✅ **ALWAYS** use completely fictional entities (e.g., `project/helix_protocol`, `researcher/kofi_mensah_larbi`)

**Why**: LLM prior knowledge contaminates results. If the LLM already knows facts about an entity, you cannot prove whether it retrieved them from Iranti or from its training data.

### 2. Unique Entities Per Test

**Every new entity used in tests must be unique.**

Before picking a new entity name:
1. Check `docs/validation_results.md` for previously used entities
2. Check existing test files in `clients/experiments/`
3. Choose a name that has never been used before

**Used Entities Registry** (do not reuse):
- `project/aurora_station` — observe_test.py
- `project/helix_protocol` — crew_helix experiments
- `project/nexus_prime` — README validation run
- `project/stellar_nexus` — stress test experiments
- `project/quantum_bridge` — Goal 1: Easy Integration
- `project/neural_lattice` — Goal 2: Context Persistence (deprecated - observe() bug)
- `project/photon_cascade` — Goal 3: Working Retrieval
- `project/resonance_field` — Goal 4: Per-Agent Persistence
- `researcher/yann_lecun` — DEPRECATED (real person, invalid test)
- `researcher/andrej_karpathy` — DEPRECATED (real person, invalid test)
- `researcher/fei_fei_li` — DEPRECATED (real person, invalid test)

### 3. Implausible, Specific Facts

**Facts must be specific and implausible enough to be unfakeable.**

✅ **Good facts** (specific, implausible):
- "Vendor lock-in with Synthos Labs contract clause 14B"
- "Hardware shortage from Veridian Systems batch 7C recall"
- "Dr. Kofi Mensah-Larbi is the project lead"
- "Distributed quantum coherence layer on Helix-9 processors"

❌ **Bad facts** (too generic, LLM might hallucinate plausibly):
- "Budget is $5 million" (too generic)
- "Deadline is next month" (vague)
- "John Smith is the lead" (common name, could be guessed)
- "Status is in progress" (meaningless)

**Rule of thumb**: If an LLM could plausibly hallucinate the fact without seeing it, it's not specific enough.

### 4. Control Must Prove Baseline

**Control experiments must prove the baseline: without Iranti, the agent genuinely cannot answer.**

- Control analyst must have **zero Iranti tools**
- Control analyst must have **zero access to the briefing document**
- Control analyst must be in a **separate crew** or **separate session** from the researcher

**Passing control**: Analyst returns "unknown" for all fields, or scores 0/N facts.

**Failing control**: Analyst returns correct answers. This means:
- The entity was not fictional enough (LLM has prior knowledge)
- The facts were too generic (LLM hallucinated plausibly)
- The test design is flawed (analyst has indirect access to facts)

**If control scores above 0/N, the test is INVALID. Discard and redesign.**

### 5. Treatment Must Prove Iranti Works

**Treatment experiments must prove Iranti works: the agent answers correctly ONLY because it retrieved facts from Iranti.**

- Treatment analyst must use Iranti tools (`get_all_findings`, `read_finding`, `observe`)
- Treatment analyst must have **zero access to the briefing document**
- Treatment analyst must be in a **separate crew** or **separate session** from the researcher

**Passing treatment**: Analyst scores 5/6 or higher by retrieving facts from Iranti.

**Failing treatment**: Analyst scores below 5/6. This means:
- Iranti tools are not working correctly
- Facts were not written to Iranti
- Analyst is not using the tools correctly
- Test design is flawed

---

## Test Categories

### 1. Unit Tests

**Test individual API endpoints directly. No agents involved.**

**Pattern**: `observe_test.py`

**Characteristics**:
- Direct HTTP calls to Iranti API
- No LLM calls
- No agent frameworks
- Fast execution (< 10 seconds)
- Deterministic results

**Example endpoints to test**:
- `POST /write` - Write a fact
- `GET /query/:entityType/:entityId/:key` - Query a fact
- `POST /observe` - Context persistence
- `POST /handshake` - Working memory brief

**When to write**: Testing core Iranti functionality without agent complexity.

### 2. Integration Tests

**Test the full pipeline with real agents.**

**Pattern**: `crew_helix.py` (control + treatment)

**Characteristics**:
- Uses agent framework (CrewAI, LangChain, etc.)
- Includes LLM calls
- Tests end-to-end workflow
- Slower execution (30-120 seconds per run)
- Non-deterministic (LLM variance)

**Example scenarios**:
- Cross-agent fact transfer
- Multi-session persistence
- Conflict resolution
- Working memory effectiveness

**When to write**: Validating Iranti works in real-world agent scenarios.

### 3. Regression Tests

**Run before every release to ensure previously validated behavior still works.**

**Pattern**: All tests in `clients/experiments/` with `PASSED` status in `validation_results.md`

**Characteristics**:
- Re-run existing validated experiments
- Compare results to baseline
- Flag any degradation in performance
- Automated via CI/CD

**When to run**: Before every release, after major refactors, weekly in CI.

---

## Experiment Design Rules

### Entity Selection
1. Choose a completely fictional entity name
2. Check it's not in the Used Entities Registry
3. Use format: `entityType/entityId` (e.g., `project/stellar_nexus`, `researcher/amara_okafor`)

### Fact Invention
1. Create at least 5 facts (6 recommended)
2. Each fact must be specific and implausible
3. Include proper nouns (company names, product names, clause numbers)
4. Include dates, numbers, technical terms
5. Make facts interdependent (e.g., blocker references a vendor mentioned elsewhere)

### Control Design
1. Researcher receives briefing document with all facts
2. Analyst has **NO** access to briefing
3. Analyst has **NO** Iranti tools
4. Analyst is asked to summarize the entity
5. Expected result: Analyst returns "unknown" for all fields (0/N score)

### Treatment Design
1. Researcher receives same briefing document
2. Researcher writes facts to Iranti using `write_finding` tool
3. Analyst has **NO** access to briefing
4. Analyst has Iranti tools (`get_all_findings`, `read_finding`)
5. Analyst loads facts from Iranti and summarizes
6. Expected result: Analyst returns all facts correctly (5/N or higher score)

### Scoring
- Use **exact string matching** on invented facts
- Do **NOT** use semantic similarity (too lenient)
- Count fact as recovered if expected value appears in analyst output
- Minimum passing score: **5/6 facts** for treatment, **0/6 facts** for control

### Pass/Fail Criteria
- **PASSED**: Control scores 0/N, Treatment scores 5/N or higher
- **FAILED**: Control scores > 0/N (test invalid), or Treatment scores < 5/N (Iranti not working)

---

## File Structure

```
clients/experiments/
  observe_test.py              # Unit test: context persistence
  validate_nexus_observe.py    # Unit test: nexus_prime entity
  validate_nexus_control.py    # Integration: control crew
  validate_nexus_treatment.py  # Integration: treatment crew
  
  control/
    crew.py                    # DEPRECATED: uses real people
    crew_helix.py              # Valid: fictional entity
  
  treatment/
    crew.py                    # DEPRECATED: uses real people
    crew_helix.py              # Valid: fictional entity
  
  results/                     # All JSON outputs auto-saved here
    observe_test_TIMESTAMP.json
    control_helix_TIMESTAMP.json
    treatment_helix_TIMESTAMP.json
  
  shared/
    agents.py                  # Shared agent definitions

docs/
  TESTING.md                   # This document
  validation_results.md        # Auditable log of all experiments
```

---

## Running Tests

### Prerequisites

1. **Start API server**:
   ```bash
   npm run api
   ```

2. **Activate virtual environment**:
   ```bash
   # Unix/Mac
   cd clients/experiments
   source venv/bin/activate
   
   # Windows
   cd clients\experiments
   venv\Scripts\activate
   ```

3. **Install dependencies** (if needed):
   ```bash
   pip install crewai requests python-dotenv
   ```

### Run Unit Tests

```bash
cd clients/experiments

# Context persistence test
python observe_test.py

# Nexus Prime validation
python validate_nexus_observe.py
```

**Expected output**: Control 0/N injected, Treatment N/N injected

### Run Integration Tests

```bash
cd clients/experiments

# Control (no Iranti)
python control/crew_helix.py

# Treatment (with Iranti)
python treatment/crew_helix.py
```

**Expected output**: Control 0/N facts, Treatment 5/N or higher facts

### Check Results

All results auto-save to `clients/experiments/results/`:

```bash
# View latest results
ls -lt results/ | head -5

# Read a result file
cat results/treatment_helix_20260228_143022.json
```

### Append to Validation Log

After running experiments, add entry to `docs/validation_results.md`:

```markdown
## [2026-02-28] Helix Protocol Cross-Agent Transfer
Entity: project/helix_protocol
Facts: 5 invented facts (lead, budget, deadline, status, blocker)
Control score: 0/5 — analyst returned "unknown" for all fields
Treatment score: 5/5 — analyst retrieved all facts from Iranti
Time elapsed: 45s
Result file: results/treatment_helix_20260228_143022.json
Status: PASSED
Notes: None
---
```

---

## Adding New Tests

### Step-by-Step Process

1. **Choose a new fictional entity**
   - Check Used Entities Registry
   - Pick a unique name (e.g., `project/stellar_nexus`, `researcher/amara_okafor`)

2. **Invent at least 5 specific facts**
   - Include proper nouns, dates, numbers
   - Make facts implausible and interdependent
   - Example:
     ```python
     FACTS = {
         "lead": "Dr. Amara Okafor",
         "budget": "$15.3 million",
         "deadline": "October 7, 2027",
         "status": "Phase 4: neural substrate mapping",
         "blocker": "Patent dispute with NeuroLink Corp case #2024-CV-8821",
         "tech": "Biomimetic synaptic arrays on Cortex-12 architecture"
     }
     ```

3. **Write control experiment**
   - Copy `control/crew_helix.py` as template
   - Replace entity and facts
   - Run and verify it scores 0/N
   - If control scores > 0, facts are not fictional enough — redesign

4. **Write treatment experiment**
   - Copy `treatment/crew_helix.py` as template
   - Replace entity and facts
   - Run and verify it scores 5/N or higher
   - If treatment scores < 5, debug Iranti tools

5. **Save results**
   - Results auto-save to `results/` directory
   - Keep the JSON files for audit trail

6. **Update documentation**
   - Add entity to Used Entities Registry in this document
   - Add experiment entry to `docs/validation_results.md`
   - Include: date, entity, facts, scores, status, notes

7. **Commit**
   - Commit test files, results, and documentation together
   - Use descriptive commit message: "Add stellar_nexus cross-agent transfer test"

---

## Common Pitfalls

### ❌ Using Real Entities
**Problem**: LLM has prior knowledge, control scores > 0  
**Solution**: Use completely fictional entities

### ❌ Generic Facts
**Problem**: LLM hallucinates plausible answers, control scores > 0  
**Solution**: Make facts specific and implausible

### ❌ Reusing Entities
**Problem**: Facts already in database from previous run, treatment scores high even without tools  
**Solution**: Always use a new unique entity per test run

### ❌ Analyst Has Context Access
**Problem**: Analyst sees researcher's output via CrewAI context parameter, control scores high  
**Solution**: This is expected in same-crew tests. Control proves baseline is context-dependent, treatment proves Iranti enables cross-session persistence.

### ❌ No Scoring Logic
**Problem**: Can't tell if test passed or failed  
**Solution**: Always count exact string matches on invented facts

### ❌ No Baseline Comparison
**Problem**: Treatment scores 3/6, but no control to compare against  
**Solution**: Always run control first to establish baseline

---

## Troubleshooting

### "API connection error"
- Check API server is running: `npm run api`
- Check port in `.env`: `IRANTI_PORT=3001`
- Check API key matches: `IRANTI_API_KEY=dev_test_key_12345`

### "Control scores above 0"
- Entity is not fictional enough (LLM has prior knowledge)
- Facts are too generic (LLM hallucinated plausibly)
- Redesign test with more specific, implausible facts

### "Treatment scores below 5/6"
- Check Iranti tools are being called (look for tool execution logs)
- Check facts were written to database: `python -c "from python.iranti import IrantiClient; c = IrantiClient(); print(c.query_all('project/your_entity'))"`
- Check analyst is using `get_all_findings` tool in task description

### "Facts not being written"
- Check researcher has `write_finding` tool
- Check task description instructs researcher to use the tool
- Check API server logs for write errors

### "Unicode errors on Windows"
- Remove emoji characters from test output
- Use ASCII characters only: `[OK]` instead of ✅

---

## Questions?

- Review existing tests in `clients/experiments/`
- Check `docs/validation_results.md` for examples
- Read `README.md` for architecture overview
- Open an issue on GitHub for bugs or clarifications

---

**Last Updated**: 2026-02-28  
**Maintainer**: Iranti Core Team
