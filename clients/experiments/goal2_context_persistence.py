"""
GOAL 2: CONTEXT PERSISTENCE
Prove observe() re-injects facts absent from context in long conversations.

Pass criteria:
- Control: injected facts == 0
- Treatment: injected keys cover all expected fact keys
"""
import os
import sys
import time

sys.path.append("..")
from python.iranti import IrantiClient


def extract_injected_keys(facts):
    keys = set()
    for item in facts or []:
        if not isinstance(item, dict):
            continue
        if "key" in item and isinstance(item["key"], str):
            keys.add(item["key"])
            continue
        ek = item.get("entityKey")
        if isinstance(ek, str) and "/" in ek:
            keys.add(ek.rsplit("/", 1)[-1])
    return keys


def print_observe_trace(label: str, result: dict, context: str) -> None:
    print(f"  [{label}] entitiesDetected: {result.get('entitiesDetected', [])}")
    resolved = result.get("entitiesResolved", []) or []
    if resolved:
        print(f"  [{label}] entitiesResolved: {len(resolved)}")
        for entry in resolved:
            print(
                "    [RESOLVE] "
                f"{entry.get('input')} -> {entry.get('canonicalEntity')} "
                f"via {entry.get('matchedBy')} conf={entry.get('confidence')}"
            )

    debug = result.get("debug", {}) or {}
    if debug:
        print(
            "  "
            f"[{label}][DEBUG] contextLength={debug.get('contextLength', len(context))} "
            f"detectionWindowChars={debug.get('detectionWindowChars', 'n/a')} "
            f"detectedCandidates={debug.get('detectedCandidates', 'n/a')} "
            f"keptCandidates={debug.get('keptCandidates', 'n/a')}"
        )
        dropped = debug.get("dropped", []) or []
        if dropped:
            print(f"  [{label}][DEBUG] dropped={dropped}")


client = IrantiClient(
    base_url=os.getenv("IRANTI_URL", "http://localhost:3001"),
    api_key=os.getenv("IRANTI_API_KEY", "dev-benchmark-key"),
)

ENTITY = f"project/neural_lattice_{int(time.time())}"
AGENT_ID = "context_test"

FACTS = {
    "director": "Dr. Kwame Osei-Tutu",
    "investment": "$18.6 million Series C from Apex Capital",
    "target_date": "February 14, 2028",
    "phase": "Phase 5: synaptic bridge deployment",
    "obstacle": "Regulatory hold from FDA panel decision #2025-NTI-447",
    "architecture": "Hierarchical neural mesh on Synapse-14 substrate",
}
EXPECTED_KEYS = set(FACTS.keys())

print("\n=== GOAL 2: CONTEXT PERSISTENCE TEST ===")
print("\nProving: observe() re-injects facts when they fall out of context\n")
print(f"Entity: {ENTITY}")
print(f"Facts: {len(FACTS)} invented facts\n")

print("[1/3] Writing facts to Iranti...")
for key, value in FACTS.items():
    client.write(
        entity=ENTITY,
        key=key,
        value={"data": value},
        summary=f"{key}: {value}",
        confidence=90,
        source="test",
        agent=AGENT_ID,
    )
print(f"  [OK] {len(FACTS)} facts written\n")

print("[2/4] CONTROL: Facts present in context...")
control_ctx = f"{ENTITY}\n" + "\n".join([f"{k}: {v}" for k, v in FACTS.items()])
control_result = client.observe(agent_id=AGENT_ID, current_context=control_ctx, max_facts=10)
control_facts = control_result.get("facts", []) or []
control_injected = len(control_facts)
print(f"  Control context length: {len(control_ctx)} chars")
print(f"  Control injected: {control_injected} facts (expected 0)")
print_observe_trace("CONTROL", control_result, control_ctx)
if control_injected:
    print(f"  [DEBUG] Control injected keys: {sorted(extract_injected_keys(control_facts))}")
print(f"  [{'PASS' if control_injected == 0 else 'FAIL'}]\n")

print("[3/4] PARTIAL: Some facts present in context...")
partial_present_keys = ["director", "investment"]
partial_missing_keys = EXPECTED_KEYS - set(partial_present_keys)
partial_ctx = (
    f"User: We are discussing {ENTITY}. Here are some known fields:\n"
    + "\n".join([f"{k}: {FACTS[k]}" for k in partial_present_keys])
    + "\nPlease fill any missing fields from memory."
)
partial_result = client.observe(agent_id=AGENT_ID, current_context=partial_ctx, max_facts=10)
partial_facts = partial_result.get("facts", []) or []
partial_inj_keys = extract_injected_keys(partial_facts)
partial_exact = partial_inj_keys == partial_missing_keys
print(f"  Partial context length: {len(partial_ctx)} chars")
print(f"  Partial injected: {len(partial_facts)} facts")
print_observe_trace("PARTIAL", partial_result, partial_ctx)
print(f"  Injected keys: {sorted(partial_inj_keys)}")
print(f"  Expected missing keys: {sorted(partial_missing_keys)}")
print(f"  [{'PASS' if partial_exact else 'FAIL'}]\n")

print("[4/4] TREATMENT: Facts absent from context...")
filler = ("generic chat about weather books travel sports cooking music " * 200)
treatment_ctx = (
    f"User: We are discussing {ENTITY}. "
    f"Please recall and summarize these fields: {', '.join(FACTS.keys())}. "
    "Retrieve memory if needed.\n\n"
    + filler
)

if len(treatment_ctx) < 3000:
    raise SystemExit(f"[FAIL] treatment context too short: {len(treatment_ctx)}")

leaked_values = [v for v in FACTS.values() if v in treatment_ctx]
if leaked_values:
    print("  [FAIL] treatment context accidentally contains fact values:")
    for v in leaked_values:
        print("   -", v)
    raise SystemExit(1)

treatment_result = client.observe(agent_id=AGENT_ID, current_context=treatment_ctx, max_facts=10)
treatment_facts = treatment_result.get("facts", []) or []
treatment_injected = len(treatment_facts)
inj_keys = extract_injected_keys(treatment_facts)
missing = EXPECTED_KEYS - inj_keys
extra = inj_keys - EXPECTED_KEYS
treatment_pass = len(missing) == 0

print(f"  Treatment context length: {len(treatment_ctx)} chars")
print(f"  Treatment injected: {treatment_injected} facts")
print_observe_trace("TREATMENT", treatment_result, treatment_ctx)
print(f"  Injected keys: {sorted(inj_keys)}")
print(f"  Missing keys: {sorted(missing)}")
print(f"  Extra keys:   {sorted(extra)}")
print(f"  [{'PASS' if treatment_pass else 'FAIL'}]\n")

overall = (control_injected == 0) and partial_exact and treatment_pass
print("=== RESULT ===")
print(f"Control (facts in context): {control_injected} injected ({'PASS' if control_injected == 0 else 'FAIL'})")
print(f"Partial (exact missing set): {'PASS' if partial_exact else 'FAIL'}")
print(f"Treatment (facts absent): missing {len(missing)} keys ({'PASS' if treatment_pass else 'FAIL'})")
print(f"\nOverall: {'PASSED' if overall else 'FAILED'}")

if overall:
    print("\nConclusion: observe() correctly injects absent facts and does not re-inject present facts.")
else:
    print("\nConclusion: observe() failed presence detection and/or key coverage.")

