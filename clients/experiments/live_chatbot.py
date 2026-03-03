import os
import sys
from typing import Any, Dict, List

from openai import OpenAI

sys.path.append("..")
from python.iranti import IrantiClient


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

AGENT_ID = "live_chat_agent"
conversation: List[Dict[str, str]] = []


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

print("\n=== LIVE IRANTI CHATBOT ===")
print("Type 'exit' to quit.\n")

while True:
    user_input = input("You: ")
    if user_input.lower() == "exit":
        break

    conversation.append({"role": "user", "content": user_input})
    context_str = "\n".join([f"{m['role']}: {m['content']}" for m in conversation])

    print("\n[IRANTI] Calling observe()...")
    observe_result: Dict[str, Any] = iranti.observe(
        agent_id=AGENT_ID,
        current_context=context_str,
        max_facts=10,
    )
    print_http_trace("observe")

    injected_facts = observe_result.get("facts", []) or []
    print_observe_trace(observe_result, context_str)

    memory_block = ""
    if injected_facts:
        memory_lines = []
        for f in injected_facts:
            entity = f.get("entity", "")
            key = f.get("key", "")
            summary = f.get("summary", "")
            if entity and key and summary:
                memory_lines.append(f"{entity}.{key} = {summary}")
        if memory_lines:
            memory_block = "MEMORY:\n" + "\n".join(memory_lines) + "\n\n"

    messages: List[Dict[str, str]] = [{"role": "system", "content": "You are a helpful assistant."}]
    if memory_block:
        messages.append({"role": "system", "content": memory_block})
    messages.extend(conversation)

    print("[LLM] Sending prompt...")
    response = client.chat.completions.create(
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        temperature=0,
        messages=messages,
    )

    reply = response.choices[0].message.content or ""
    print("\nAssistant:", reply)

    conversation.append({"role": "assistant", "content": reply})

    if response.usage is not None:
        print("\n[DEBUG] Prompt tokens:", response.usage.prompt_tokens)
        print("[DEBUG] Completion tokens:", response.usage.completion_tokens)

    print("-" * 50)
