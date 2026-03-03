"""
Deterministic 60-second demo:
1) write memory under one alias form
2) query under a different alias form
3) run observe() on long context and verify injection
"""

import os
import time
import sys

sys.path.append("..")
from python.iranti import IrantiClient


BASE_URL = os.getenv("IRANTI_URL", "http://localhost:3001")
API_KEY = os.getenv("IRANTI_API_KEY", "dev-benchmark-key")
AGENT_ID = "demo_memory_agent"


def print_http(client: IrantiClient, label: str) -> None:
    meta = client.last_http()
    print(
        f"[HTTP] {label}: status={meta.get('status')} "
        f"method={meta.get('method')} path={meta.get('path')} ok={meta.get('ok')}"
    )


def main() -> int:
    client = IrantiClient(base_url=BASE_URL, api_key=API_KEY)
    token = str(int(time.time()))

    write_entity = f"project/Atlas_{token}"
    read_entity = f"project/project_atlas_{token}"
    fact_key = "launch_year"
    fact_value = "2029"

    print("\n=== DEMO: ENTITY MEMORY LOOP ===")
    print(f"write_entity={write_entity}")
    print(f"read_entity={read_entity}\n")

    # Step 1: write using alias A
    write_result = client.write(
        entity=write_entity,
        key=fact_key,
        value={"data": fact_value},
        summary=f"{fact_key}: {fact_value}",
        confidence=90,
        source="demo_loop",
        agent=AGENT_ID,
    )
    print_http(client, "write")
    print(
        f"write.action={write_result.action} "
        f"resolvedEntity={write_result.resolved_entity} "
        f"inputEntity={write_result.input_entity}\n"
    )

    # Step 2: query using alias B
    query_result = client.query(read_entity, fact_key)
    print_http(client, "query")
    print(
        f"query.found={query_result.found} "
        f"resolvedEntity={query_result.resolved_entity} "
        f"inputEntity={query_result.input_entity}\n"
    )

    # Step 3: observe on long context, then verify injected fact
    filler = " random discussion about unrelated topics " * 200
    context = (
        f"Earlier we discussed many things.{filler}\n"
        f"Now answer about {read_entity}: when does it launch?"
    )
    observe_result = client.observe(
        agent_id=AGENT_ID,
        current_context=context,
        max_facts=10,
    )
    print_http(client, "observe")

    entities_detected = observe_result.get("entitiesDetected", []) or []
    entities_resolved = observe_result.get("entitiesResolved", []) or []
    facts = observe_result.get("facts", []) or []
    injected_keys = [f.get("entityKey", "") for f in facts if isinstance(f, dict)]
    already_present = observe_result.get("alreadyPresent", 0)

    print(f"detected={entities_detected}")
    print(f"resolved={entities_resolved}")
    print(f"injected_keys={injected_keys}")
    print(f"already_present={already_present}\n")

    has_launch_year = any(str(k).endswith(f"/{fact_key}") for k in injected_keys)
    success = bool(query_result.found and has_launch_year)

    print("=== RESULT ===")
    print(f"PASS={success}")
    if not success:
        print("Expected query.found=true and observe launch_year injection.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
