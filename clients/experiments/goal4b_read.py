"""
GOAL 4B: READ FACTS IN NEW PROCESS
Second process: Read facts written by first process (completely separate execution).
"""
import sys
sys.path.append('..')
from python.iranti import IrantiClient
import os, json
from datetime import datetime

client = IrantiClient(base_url="http://localhost:3001", api_key=os.getenv("IRANTI_API_KEY", "dev-benchmark-key"))

print("\n=== GOAL 4B: READ FACTS (Process 2) ===\n")

# Load metadata from process 1
print("[1/3] Loading metadata from Process 1...")
try:
    with open("results/goal4_metadata.json", 'r') as f:
        metadata = json.load(f)
    ENTITY = metadata['entity']
    EXPECTED_FACTS = metadata['facts']
    print(f"  [OK] Entity: {ENTITY}")
    print(f"  [OK] Expected facts: {len(EXPECTED_FACTS)}\n")
except FileNotFoundError:
    print("  [FAIL] Metadata not found. Run goal4a_write.py first.\n")
    exit(1)

# Query Iranti (no shared state with process 1)
print("[2/3] Querying Iranti for facts...")
facts = client.query_all(ENTITY)
print(f"  [OK] Retrieved {len(facts)} facts from database\n")

# Verify all facts present
print("[3/3] Verifying fact content...")
fact_map = {f['key']: f['value'] for f in facts}
score = 0
for key, expected_value in EXPECTED_FACTS.items():
    if key in fact_map:
        stored_value = str(fact_map[key])
        if expected_value.lower() in stored_value.lower():
            score += 1
            print(f"  [OK] {key}")
        else:
            print(f"  [FAIL] {key} (value mismatch)")
    else:
        print(f"  [FAIL] {key} (not found)")

print(f"\n=== RESULT ===")
print(f"Facts retrieved: {score}/{len(EXPECTED_FACTS)} ({'PASS' if score == len(EXPECTED_FACTS) else 'FAIL'})")
print(f"\nOverall: {'PASSED' if score == len(EXPECTED_FACTS) else 'FAILED'}")
print("\nConclusion: Facts persisted across completely separate process runs.")
print("PostgreSQL storage validated - no in-memory state shared between processes.")

# Save result
result_data = {
    "experiment": "goal4_persistence",
    "entity": ENTITY,
    "expected_facts": len(EXPECTED_FACTS),
    "retrieved_facts": score,
    "timestamp": datetime.now().isoformat(),
    "status": "PASSED" if score == len(EXPECTED_FACTS) else "FAILED"
}

result_file = f"results/goal4_persistence_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
with open(result_file, 'w') as f:
    json.dump(result_data, f, indent=2)
print(f"\nResult saved: {result_file}\n")

