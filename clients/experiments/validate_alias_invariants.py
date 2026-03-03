"""
Alias/canonical invariants checker with graceful fallback when resolve/alias
endpoints are not exposed by the running API.
"""

import os
import time
from typing import Dict, List, Optional, Tuple

import requests

import sys
sys.path.append("..")
from python.iranti import IrantiClient


BASE_URL = os.getenv("IRANTI_URL", "http://localhost:3001").rstrip("/")
API_KEY = os.getenv("IRANTI_API_KEY", "dev-benchmark-key")
HEADERS = {"X-Iranti-Key": API_KEY, "Content-Type": "application/json"}

client = IrantiClient(base_url=BASE_URL, api_key=API_KEY)

RESOLVE_PATHS = ["/kb/resolve", "/resolve"]
ALIASES_PATHS = [
    "/kb/entity/{entity_type}/{entity_id}/aliases",
    "/entity/{entity_type}/{entity_id}/aliases",
]


def _request_json(method: str, path: str, payload: Optional[Dict] = None) -> requests.Response:
    if method == "POST":
        return requests.post(f"{BASE_URL}{path}", headers=HEADERS, json=payload, timeout=30)
    return requests.get(f"{BASE_URL}{path}", headers=HEADERS, timeout=30)


def detect_path(method: str, candidate_paths: List[str], probe_payload: Optional[Dict] = None) -> Optional[str]:
    for path in candidate_paths:
        try:
            resp = _request_json(method, path, probe_payload)
            if resp.status_code != 404:
                return path
        except Exception:
            continue
    return None


def resolve_entity(path: str, entity: str, create_if_missing: bool = True, aliases: Optional[List[str]] = None) -> Dict:
    payload = {
        "entity": entity,
        "createIfMissing": create_if_missing,
        "aliases": aliases or [],
        "source": "alias_invariant_test",
        "confidence": 95,
        "agent": "alias_invariant_test",
    }
    resp = _request_json("POST", path, payload)
    if not resp.ok:
        raise RuntimeError(f"{path} failed for {entity}: {resp.status_code} {resp.text}")
    return resp.json()


def list_aliases(path_template: str, canonical_entity: str) -> Dict:
    entity_type, entity_id = canonical_entity.split("/", 1)
    path = path_template.format(entity_type=entity_type, entity_id=entity_id)
    resp = _request_json("GET", path)
    if not resp.ok:
        raise RuntimeError(f"{path} failed: {resp.status_code} {resp.text}")
    return resp.json()


def emit(status: str, label: str, detail: str = "") -> Tuple[str, str]:
    suffix = f" | {detail}" if detail else ""
    print(f"[{status}] {label}{suffix}")
    return status, label


def http_meta_str() -> str:
    meta = client.last_http()
    return (
        f"status={meta.get('status')} method={meta.get('method')} "
        f"path={meta.get('path')} ok={meta.get('ok')}"
    )


def main() -> int:
    token = str(int(time.time()))
    base_name = f"Atlas_{token}"
    primary = f"project/{base_name}"
    mismatch_form = f"project/project_atlas_{token}"

    variants = [
        primary,
        f"project/{base_name.lower()}",
        f"project/project_{base_name.lower()}",
        f"project/{base_name.upper()}",
        f"project/Project-Atlas-{token}",
        f"project/{base_name.lower()} ",
        f"project/ {base_name.lower()}",
        mismatch_form,
    ]

    print("\n=== ALIAS INVARIANTS TEST ===")
    print("Primary entity input:", primary)
    print("Variants:", variants, "\n")

    probe_payload = {"entity": primary, "createIfMissing": False}
    resolve_path = detect_path("POST", RESOLVE_PATHS, probe_payload)

    alias_path: Optional[str] = None
    for template in ALIASES_PATHS:
        test = template.format(entity_type="project", entity_id="probe_alias")
        p = detect_path("GET", [test])
        if p:
            alias_path = template
            break

    print(f"[INFO] resolve endpoint: {resolve_path or 'NOT AVAILABLE'}")
    print(f"[INFO] aliases endpoint: {alias_path or 'NOT AVAILABLE'}\n")

    results: List[Tuple[str, str]] = []
    canonical = primary

    # Ensure baseline write exists
    fact_key = "launch_year"
    fact_value = f"20{token[-2:]}"
    client.write(
        entity=primary,
        key=fact_key,
        value={"data": fact_value},
        summary=f"launch_year: {fact_value}",
        confidence=90,
        source="alias_invariant_test",
        agent="alias_invariant_test",
    )
    print(f"[WRITE] {primary}.{fact_key} = {fact_value}\n")

    # A) canonical resolution (if endpoint exists)
    if resolve_path:
        primary_resolved = resolve_entity(resolve_path, primary, create_if_missing=True, aliases=variants)
        canonical = primary_resolved.get("canonicalEntity", primary)
        print("Canonical entity:", canonical)
        canonical_set = set()
        for v in variants:
            r = resolve_entity(resolve_path, v, create_if_missing=True)
            canonical_set.add(r.get("canonicalEntity"))
            print(
                f"[RESOLVE] {v!r} -> {r.get('canonicalEntity')} "
                f"via {r.get('matchedBy')} addedAliases={r.get('addedAliases')}"
            )
        print()
        ok = len(canonical_set) == 1 and canonical in canonical_set
        results.append(emit("PASS" if ok else "FAIL", "All variants resolve to same canonical"))
    else:
        results.append(emit("SKIP", "Canonical resolve checks", "resolve endpoint unavailable"))

    # B) alias listing (if endpoint exists)
    if alias_path and resolve_path:
        alias_info = list_aliases(alias_path, canonical)
        alias_rows = alias_info.get("aliases", []) or []
        alias_norms = {row.get("aliasNorm") for row in alias_rows}
        print(f"[ALIASES] count={len(alias_rows)} sample={[row.get('alias') for row in alias_rows[:8]]}\n")
        results.append(emit("PASS" if len(alias_rows) >= 1 else "FAIL", "Alias list populated", f"alias_count={len(alias_rows)}"))
        contains_norm = any(n and "atlas" in str(n) for n in alias_norms)
        results.append(emit("PASS" if contains_norm else "FAIL", "Alias list contains normalized atlas forms"))
    else:
        results.append(emit("SKIP", "Alias list checks", "aliases endpoint unavailable"))

    # C) query/query_all by each variant (always available via client)
    all_found = True
    resolved_entities = set()
    for v in variants:
        q = client.query(v, fact_key)
        resolved_entities.add(q.resolved_entity or "")
        q_http = http_meta_str()
        qa = client.query_all(v)
        qa_http = http_meta_str()
        has_key = any(entry.get("key") == fact_key for entry in qa)
        ok = bool(q.found and has_key)
        all_found = all_found and ok
        print(
            f"[QUERY] {v!r} found={q.found} has_key={has_key} "
            f"resolved={q.resolved_entity} | query_http=({q_http}) query_all_http=({qa_http})"
        )
    print()
    results.append(emit("PASS" if all_found else "FAIL", "query/query_all work for all variants"))
    results.append(emit("PASS" if len({r for r in resolved_entities if r}) == 1 else "FAIL", "query resolves variants to one canonical entity"))

    # D) observe with mismatched form
    observe_context = (
        f"User: We are discussing {mismatch_form}. "
        f"What is its {fact_key}?\nAssistant: retrieve memory."
    )
    obs = client.observe(
        agent_id="alias_invariant_test",
        current_context=observe_context,
        max_facts=10,
    )
    facts = obs.get("facts", []) or []
    injected_keys = []
    for f in facts:
        ek = f.get("entityKey")
        if isinstance(ek, str):
            injected_keys.append(ek)
    has_launch = any(ek.endswith(f"/{fact_key}") for ek in injected_keys)
    print(f"[OBSERVE] entitiesDetected={obs.get('entitiesDetected', [])}")
    print(f"[OBSERVE] entitiesResolved={obs.get('entitiesResolved', [])}")
    print(f"[OBSERVE] injected_keys={injected_keys}\n")
    print(f"[OBSERVE] http=({http_meta_str()})\n")
    results.append(emit("PASS" if has_launch else "FAIL", "observe reinjects fact for mismatched form"))

    executed = [r for r in results if r[0] != "SKIP"]
    passed = sum(1 for status, _ in executed if status == "PASS")
    total = len(executed)
    skipped = len(results) - total
    overall_ok = total > 0 and passed == total

    print("=== RESULT ===")
    print(f"Executed: {total}, Passed: {passed}, Skipped: {skipped}")
    print(f"Overall: {'PASSED' if overall_ok else 'FAILED'}")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
