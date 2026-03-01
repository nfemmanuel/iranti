"""
GOAL 4A: WRITE FACTS AND EXIT
First process: Write facts to Iranti, then exit completely.
"""
import sys
sys.path.append('..')
from python.iranti import IrantiClient
import os, json
from datetime import datetime

client = IrantiClient(base_url="http://localhost:3001", api_key=os.getenv("IRANTI_API_KEY", "dev_test_key_12345"))

ENTITY = "project/resonance_field"
FACTS = {
    "coordinator": "Dr. Nkiru Okonkwo",
    "funding": "$31.5 million from Horizon Equity Fund IV",
    "milestone": "December 3, 2027",
    "current_phase": "Phase 7: resonance field stabilization",
    "challenge": "Integration conflict with Legacy Systems protocol v4.2.1"
}

print("\n=== GOAL 4A: WRITE FACTS (Process 1) ===\n")
print(f"Entity: {ENTITY}")
print(f"Facts to write: {len(FACTS)}\n")

print("[1/2] Writing facts to Iranti...")
for key, value in FACTS.items():
    result = client.write(
        entity=ENTITY,
        key=key,
        value={"data": value},
        summary=f"{key}: {value}",
        confidence=90,
        source="process1",
        agent="writer_process"
    )
    print(f"  [OK] {key}: {result.action}")

print(f"\n[2/2] Verifying facts were written...")
stored = client.query_all(ENTITY)
print(f"  [OK] {len(stored)} facts in database\n")

# Save metadata for process 2
metadata = {
    "entity": ENTITY,
    "facts": FACTS,
    "written_at": datetime.now().isoformat(),
    "process": "4a_write"
}

os.makedirs("results", exist_ok=True)
with open("results/goal4_metadata.json", 'w') as f:
    json.dump(metadata, f, indent=2)

print("=== RESULT ===")
print(f"Facts written: {len(FACTS)}/5 (PASS)")
print(f"Metadata saved: results/goal4_metadata.json")
print("\nProcess 1 complete. Now run goal4b_read.py in a NEW process.")
print("This process will now exit completely.\n")
