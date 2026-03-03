import json
import os
import re
import sys
from typing import Any, Dict, List, Optional

from openai import OpenAI

sys.path.append("..")
from python.iranti import IrantiClient


# Required env vars:
#   IRANTI_URL
#   IRANTI_API_KEY
#   OPENAI_API_KEY
#
# Optional:
#   OPENAI_MODEL (default gpt-4o-mini)
#   IRANTI_AGENT_ID (default live_chat_agent)
#   IRANTI_SOURCE (default live_chatbot_plus)
#   IRANTI_DEFAULT_CONF (default 85)
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
AGENT_ID = os.getenv("IRANTI_AGENT_ID", "live_chat_agent")
SOURCE = os.getenv("IRANTI_SOURCE", "live_chatbot_plus")
DEFAULT_CONF = int(os.getenv("IRANTI_DEFAULT_CONF", "85"))
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()

if not OPENAI_API_KEY or OPENAI_API_KEY == "your_openai_key":
    raise SystemExit(
        "Missing valid OPENAI_API_KEY. "
        "Set a real key in PowerShell: $env:OPENAI_API_KEY=\"sk-...\""
    )

client = OpenAI(api_key=OPENAI_API_KEY)
iranti = IrantiClient(
    base_url=os.getenv("IRANTI_URL", "http://localhost:3001"),
    api_key=os.getenv("IRANTI_API_KEY", "dev-benchmark-key"),
)

conversation: List[Dict[str, str]] = []
active_entity: Optional[str] = None
auto_extract = False


def build_context_str(msgs: List[Dict[str, str]]) -> str:
    return "\n".join([f"{m['role']}: {m['content']}" for m in msgs])


def render_memory_block(facts: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for f in facts:
        summary = f.get("summary", "")
        entity = f.get("entity", "")
        key = f.get("key", "")
        entity_key = f.get("entityKey", "")

        if isinstance(entity_key, str) and entity_key.count("/") >= 2 and summary:
            e = entity_key.rsplit("/", 1)[0]
            k = entity_key.rsplit("/", 1)[-1]
            lines.append(f"{e}.{k} = {summary}")
            continue

        if entity and key and summary:
            lines.append(f"{entity}.{key} = {summary}")
    return "MEMORY:\n" + "\n".join(lines) + "\n\n" if lines else ""


def injected_key_list(facts: List[Dict[str, Any]]) -> List[str]:
    keys: List[str] = []
    for fact in facts:
        entity_key = fact.get("entityKey")
        if isinstance(entity_key, str) and entity_key:
            keys.append(entity_key)
            continue
        entity = fact.get("entity", "")
        key = fact.get("key", "")
        if entity and key:
            keys.append(f"{entity}/{key}")
    return keys


def print_observe_trace(result: Dict[str, Any], context_str: str) -> None:
    detected = result.get("entitiesDetected", []) or []
    resolved = result.get("entitiesResolved", []) or []
    debug = result.get("debug", {}) or {}
    facts = result.get("facts", []) or []

    print(f"[IRANTI] entitiesDetected: {detected}")
    if resolved:
        print(f"[IRANTI] entitiesResolved: {len(resolved)}")
        for entry in resolved:
            print(
                "  [RESOLVE] "
                f"{entry.get('input')} -> {entry.get('canonicalEntity')} "
                f"via {entry.get('matchedBy')} conf={entry.get('confidence')}"
            )

    if debug:
        print(
            "[IRANTI][DEBUG] "
            f"contextLength={debug.get('contextLength', len(context_str))} "
            f"detectionWindowChars={debug.get('detectionWindowChars', 'n/a')} "
            f"detectedCandidates={debug.get('detectedCandidates', 'n/a')} "
            f"keptCandidates={debug.get('keptCandidates', 'n/a')}"
        )
        dropped = debug.get("dropped", []) or []
        if dropped:
            print(f"[IRANTI][DEBUG] dropped={dropped}")

    print(
        f"[IRANTI] injected_facts: {len(facts)} "
        f"(alreadyPresent={result.get('alreadyPresent', 'n/a')}, "
        f"totalFound={result.get('totalFound', 'n/a')})"
    )
    if facts:
        print(f"[IRANTI] injected_keys: {injected_key_list(facts)}")


def print_http_trace(label: str) -> None:
    meta = iranti.last_http()
    print(
        f"[IRANTI][HTTP] {label} "
        f"status={meta.get('status')} method={meta.get('method')} path={meta.get('path')}"
    )


def safe_json_load(s: str) -> Optional[Any]:
    try:
        return json.loads(s)
    except Exception:
        return None


def extract_facts_from_text(text: str) -> List[Dict[str, Any]]:
    def looks_sensitive(val: str) -> bool:
        if not val:
            return False
        if "sk-" in val:
            return True
        if re.search(r"AKIA[0-9A-Z]{16}", val):
            return True
        return False

    sys_prompt = (
        "You extract structured durable facts from an assistant reply.\n"
        "Return ONLY valid JSON.\n"
        'Schema: {"facts": [{"entity": str, "key": str, "value": str, "summary": str, "confidence": int}]}\n'
        "Rules:\n"
        "- Only extract facts useful later (names, roles, dates, preferences, definitions, decisions, identifiers).\n"
        "- Do NOT extract ephemeral chit-chat.\n"
        "- Keys should be snake_case, short, stable.\n"
        "- entity should look like project/<name>, person/<name>, company/<name>.\n"
        '- If entity is unclear, use "unknown/entity".\n'
        "- confidence 0-100.\n"
        "- Max 6 facts.\n"
    )
    user_prompt = f"ASSISTANT REPLY:\n{text}\n\nReturn JSON now."

    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        temperature=0,
        messages=[{"role": "system", "content": sys_prompt}, {"role": "user", "content": user_prompt}],
    )
    raw = resp.choices[0].message.content or ""
    parsed = safe_json_load(raw)
    if not parsed or "facts" not in parsed or not isinstance(parsed["facts"], list):
        print("[EXTRACT] Could not parse JSON fact extraction. Raw output:")
        print(raw)
        return []

    extracted: List[Dict[str, Any]] = []
    for fact in parsed["facts"]:
        if not isinstance(fact, dict):
            continue
        entity = str(fact.get("entity", "")).strip() or "unknown/entity"
        key = str(fact.get("key", "")).strip()
        value = str(fact.get("value", "")).strip()
        summary = str(fact.get("summary", "")).strip()
        confidence = fact.get("confidence", DEFAULT_CONF)

        if not key or not value or not summary:
            continue
        if looks_sensitive(value) or looks_sensitive(summary):
            continue

        if active_entity and entity == "unknown/entity":
            entity = active_entity

        try:
            confidence = int(confidence)
        except Exception:
            confidence = DEFAULT_CONF
        confidence = max(0, min(100, confidence))

        extracted.append(
            {
                "entity": entity,
                "key": key,
                "value": value,
                "summary": summary,
                "confidence": confidence,
            }
        )

    return extracted[:6]


def write_facts(facts: List[Dict[str, Any]]) -> None:
    if not facts:
        return
    print(f"[IRANTI] Writing {len(facts)} extracted facts...")
    for fact in facts:
        try:
            result = iranti.write(
                entity=fact["entity"],
                key=fact["key"],
                value={"data": fact["value"]},
                summary=fact["summary"],
                confidence=fact["confidence"],
                source=SOURCE,
                agent=AGENT_ID,
            )
            print_http_trace("write")
            print(f"  [WROTE] {fact['entity']}.{fact['key']} (conf={fact['confidence']})")
            print(
                f"    resolvedEntity={result.resolved_entity} "
                f"inputEntity={result.input_entity} http={result.http_status}"
            )
        except Exception as err:
            print(
                "  [WRITE-ERROR] "
                f"{fact['entity']}.{fact['key']} failed: {err}"
            )


def manual_remember(payload: str) -> None:
    # Supported:
    #   /remember project/atlas launch_year=2029
    #   /remember launch_year=2029   (uses active_entity)
    match = re.match(r"^(?:(?P<entity>\S+)\s+)?(?P<key>[a-zA-Z0-9_]+)\s*=\s*(?P<value>.+)$", payload.strip())
    if not match:
        print("[USAGE] /remember <entityType/entityId> <key>=<value>")
        print("        /remember <key>=<value>  (uses /entity active entity)")
        return

    entity = match.group("entity") or active_entity
    key = match.group("key")
    value = match.group("value").strip()

    if not entity:
        print("[ERROR] No entity provided. Use /entity <entityType/entityId> or include entity in /remember.")
        return

    try:
        result = iranti.write(
            entity=entity,
            key=key,
            value={"data": value},
            summary=f"{key}: {value}",
            confidence=100,
            source="manual_remember",
            agent=AGENT_ID,
        )
        print_http_trace("remember")
        if result.action in ("created", "updated", "escalated"):
            print(
                f"[REMEMBERED] {entity}.{key}={value} | action={result.action} "
                f"resolvedEntity={result.resolved_entity} inputEntity={result.input_entity}"
            )
        else:
            print(f"[ERROR] Write rejected: {result.reason}")
            return
    except Exception as err:
        print(f"[REMEMBER-ERROR] {err}")


def show_help() -> None:
    print(
        "\nCommands:\n"
        "  /entity <entity_id>   Set default entity for extracted facts\n"
        "  /entity               Show current entity\n"
        "  /extract off|on       Toggle auto-extraction/writes\n"
        "  /remember ...         Write memory directly (/remember project/x key=value)\n"
        "  /write ...            Alias of /remember\n"
        "  /observe              Force observe() and print injected facts\n"
        "  /clear                Clear conversation transcript\n"
        "  /help                 Show this help\n"
        "  exit                  Quit\n"
    )


print("\n=== LIVE IRANTI CHATBOT (PLUS) ===")
print("observe() + injection + auto fact extraction + live writes")
show_help()

while True:
    user_input = input("\nYou: ").strip()
    if user_input.lower() == "exit":
        break

    if user_input.startswith("/help"):
        show_help()
        continue

    if user_input.startswith("/entity"):
        parts = user_input.split(maxsplit=1)
        if len(parts) == 1:
            print("[STATE] active_entity =", active_entity)
        else:
            active_entity = parts[1].strip()
            print("[STATE] active_entity set to:", active_entity)
        continue

    if user_input.startswith("/extract"):
        parts = user_input.split(maxsplit=1)
        if len(parts) == 2 and parts[1].strip().lower() in ("on", "off"):
            requested_on = parts[1].strip().lower() == "on"
            if requested_on and not active_entity:
                auto_extract = False
                print("[STATE] auto_extract requires /entity first. auto_extract = False")
                continue
            auto_extract = requested_on
            print("[STATE] auto_extract =", auto_extract)
        else:
            print("[STATE] auto_extract =", auto_extract)
        continue

    if user_input.startswith("/remember") or user_input.startswith("/write"):
        parts = user_input.split(maxsplit=1)
        payload = parts[1] if len(parts) > 1 else ""
        manual_remember(payload)
        continue

    if user_input.startswith("/clear"):
        conversation = []
        print("[STATE] conversation cleared")
        continue

    if user_input.startswith("/observe"):
        context_str = build_context_str(conversation)
        obs = iranti.observe(agent_id=AGENT_ID, current_context=context_str, max_facts=10)
        print_http_trace("observe")
        facts = obs.get("facts", []) or []
        print_observe_trace(obs, context_str)
        for fact in facts:
            print(
                " ",
                fact.get("entityKey") or f"{fact.get('entity')}/{fact.get('key')}",
                "=>",
                fact.get("summary"),
            )
        continue

    conversation.append({"role": "user", "content": user_input})
    context_str = build_context_str(conversation)

    print("\n[IRANTI] observe() ...")
    observe_result = iranti.observe(
        agent_id=AGENT_ID,
        current_context=context_str,
        max_facts=10,
    )
    print_http_trace("observe")
    injected_facts = observe_result.get("facts", []) or []
    print_observe_trace(observe_result, context_str)

    memory_block = render_memory_block(injected_facts)
    system_prompt = (
        "You are a helpful assistant.\n"
        "When MEMORY is provided, treat it as authoritative for the referenced entities.\n"
        "Do not mention training-data cutoffs or 'last update'.\n"
        "If the requested fact is not present in MEMORY, respond with UNKNOWN."
    )
    if active_entity:
        system_prompt += f"\nActive entity: {active_entity}"

    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    if memory_block:
        messages.append({"role": "system", "content": memory_block})
    messages.extend(conversation)

    print("[LLM] sending ...")
    resp = client.chat.completions.create(
        model=OPENAI_MODEL,
        temperature=0,
        messages=messages,
    )
    reply = resp.choices[0].message.content or ""
    print("\nAssistant:", reply)
    conversation.append({"role": "assistant", "content": reply})

    if auto_extract:
        if not active_entity:
            print("\n[EXTRACT] skipped: set /entity first to avoid cross-entity contamination.")
            print("-" * 60)
            continue

        print("\n[EXTRACT] extracting facts from assistant reply ...")
        facts = extract_facts_from_text(reply)
        scoped_facts: List[Dict[str, Any]] = []
        skipped = 0
        for fact in facts:
            entity = fact.get("entity", "")
            if entity == "unknown/entity":
                fact["entity"] = active_entity
                scoped_facts.append(fact)
            elif entity == active_entity:
                scoped_facts.append(fact)
            else:
                skipped += 1

        if skipped:
            print(f"[EXTRACT] skipped {skipped} fact(s) due to entity mismatch with active entity.")

        facts = scoped_facts
        print(f"[EXTRACT] extracted {len(facts)} facts")
        for fact in facts:
            print(
                f"  [FACT] {fact['entity']}.{fact['key']} = "
                f"{fact['value']} (conf={fact['confidence']})"
            )
        write_facts(facts)

    usage = getattr(resp, "usage", None)
    if usage:
        print("\n[DEBUG] prompt_tokens:", usage.prompt_tokens)
        print("[DEBUG] completion_tokens:", usage.completion_tokens)

    print("-" * 60)
