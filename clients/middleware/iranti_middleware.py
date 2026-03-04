"""
Iranti Middleware
=================
Adds persistent memory to any LLM conversation.

Usage:
    from iranti_middleware import IrantiMiddleware

    middleware = IrantiMiddleware(
        agent_id="my_agent",
        iranti_url="http://localhost:3001",
        iranti_api_key="your_key"
    )

    # Before sending to LLM
    augmented = middleware.before_send(
        user_message="What was the blocker?",
        conversation_history=[...]
    )

    # After receiving response
    final_response = middleware.after_receive(
        response="The blocker is...",
        conversation_history=[...]
    )
"""
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from python.iranti import IrantiClient
import re
from typing import Any, List, Dict, Optional, Set, Tuple

class IrantiMiddleware:
    """Wraps LLM conversations with Iranti memory injection."""

    def __init__(
        self,
        agent_id: str,
        iranti_url: str = "http://localhost:3001",
        iranti_api_key: Optional[str] = None,
        context_window: int = 20,
        max_facts: int = 5,
        memory_entity: Optional[str] = None,
        auto_remember: bool = True,
        enforce_consistency: bool = True,
        source: str = "middleware_user",
        write_confidence: int = 100,
    ):
        """
        Initialize middleware.

        Args:
            agent_id: Unique identifier for this agent
            iranti_url: Iranti API server URL
            iranti_api_key: API key (or set IRANTI_API_KEY env var)
            context_window: Number of recent messages to include in context (default 20)
            max_facts: Maximum facts to inject per message (default 5)
            memory_entity: Entity used for user/profile memory (default: conversation/<agent_id>)
            auto_remember: Automatically persist explicit user profile statements/corrections
            enforce_consistency: Correct model answers that conflict with current memory
            source: Source label used for middleware writes
            write_confidence: Confidence for explicit user-memory writes (0-100)
        """
        self.agent_id = agent_id
        self.context_window = context_window
        self.max_facts = max_facts
        self.client = IrantiClient(base_url=iranti_url, api_key=iranti_api_key)
        self.memory_entity = memory_entity or f"conversation/{agent_id}"
        self.auto_remember = auto_remember
        self.enforce_consistency = enforce_consistency
        self.source = source
        self.write_confidence = max(0, min(100, int(write_confidence)))

        self._known_keys: Set[str] = set()
        self._known_keys_loaded = False
        self._last_memory_key_context: Optional[str] = None
        self._last_user_message: Optional[str] = None

    def before_send(
        self,
        user_message: str,
        conversation_history: List[Dict[str, str]]
    ) -> str:
        """
        Inject forgotten facts before sending to LLM.
        
        Args:
            user_message: The user's current message
            conversation_history: List of {"role": "user/assistant", "content": "..."}
        
        Returns:
            Augmented message with memory injection prepended
        """
        self._last_user_message = user_message
        self._bootstrap_known_keys()

        turn_key = self._resolve_turn_key(user_message)
        if turn_key:
            self._last_memory_key_context = turn_key

        if self.auto_remember:
            extracted = self._extract_contextual_correction(user_message, self._last_memory_key_context)
            if not extracted:
                extracted = self._extract_auto_memory_fact(user_message, self._last_memory_key_context)
            if extracted:
                key, value = extracted
                self._remember_if_changed(self.memory_entity, key, value)

        # Build context from recent messages
        recent = conversation_history[-self.context_window:] if len(conversation_history) > self.context_window else conversation_history
        context_parts = [f"{msg['role']}: {msg['content']}" for msg in recent]
        context_parts.append(f"user: {user_message}")
        context_str = "\n".join(context_parts)

        # Call attend() so Attendant decides if memory is needed
        try:
            result = self.client.attend(
                agent_id=self.agent_id,
                latest_message=user_message,
                current_context=context_str,
                max_facts=self.max_facts,
                entity_hints=[self.memory_entity],
            )
            if not result.get('shouldInject', False):
                return user_message

            facts = result.get('facts', [])

            if not facts:
                return user_message

            # Prepend facts as memory injection
            fact_lines = [f"- {f['summary']}" for f in facts]
            memory_note = "[MEMORY: " + "; ".join(fact_lines) + "]\n\n"
            return memory_note + user_message

        except Exception as e:
            # Silent failure - return original message
            print(f"[Iranti] attend() failed: {e}")
            return user_message

    def after_receive(
        self,
        response: str,
        conversation_history: List[Dict[str, str]],
        user_message: Optional[str] = None,
    ) -> str:
        """
        Optionally correct inconsistent memory answers, then extract and save facts.

        Args:
            response: The LLM's response
            conversation_history: Full conversation history
            user_message: Current user prompt for this response (optional)

        Returns:
            Final response (possibly corrected for memory consistency)
        """
        self._bootstrap_known_keys()
        final_response = response

        effective_user_message = user_message or self._last_user_message or self._find_last_user_message(conversation_history)
        if self.enforce_consistency and effective_user_message:
            key = self._resolve_turn_key(effective_user_message)
            if key:
                self._last_memory_key_context = key
                try:
                    expected = self.client.query(self.memory_entity, key)
                    if expected.found:
                        expected_value = expected.value
                        if isinstance(expected_value, dict):
                            expected_value = expected_value.get("text", expected_value)
                        if expected_value and not self._reply_mentions_value(final_response, expected_value):
                            final_response = self._format_memory_reply(key, expected_value)
                except Exception as e:
                    print(f"[Iranti] consistency check failed: {e}")

        # Extract factual statements (best-effort heuristic)
        facts = self._extract_facts(final_response)

        if not facts:
            return final_response

        # Write each fact to Iranti
        for i, fact_text in enumerate(facts):
            try:
                # Generate entity from context (simple heuristic)
                entity = self._infer_entity(conversation_history)

                self.client.write(
                    entity=entity,
                    key=f"fact_{i}_{hash(fact_text) % 10000}",
                    value={"data": fact_text},
                    summary=fact_text[:100],
                    confidence=70,
                    source="conversation",
                    agent=self.agent_id
                )
            except Exception:
                # Silent failure
                pass

        return final_response

    def _bootstrap_known_keys(self) -> None:
        if self._known_keys_loaded:
            return
        self._known_keys_loaded = True
        try:
            entries = self.client.query_all(self.memory_entity)
            self._known_keys = {str(e.get("key", "")).strip() for e in entries if e.get("key")}
        except Exception:
            self._known_keys = set()

    def _normalize_key(self, text: str) -> str:
        t = text.strip().lower().replace("-", " ")
        t = re.sub(r"\s+", "_", t)
        t = re.sub(r"[^a-z0-9_]+", "", t)
        t = re.sub(r"_+", "_", t).strip("_")
        return t

    def _token_set(self, text: str) -> Set[str]:
        return set(re.findall(r"[a-z0-9_]+", text.lower()))

    def _extract_my_fact_key(self, user_message: str) -> Optional[str]:
        text = user_message.strip().lower()
        m = re.match(r"^(?:what\s+is|what'?s|do\s+you\s+remember)\s+my\s+([a-z0-9_\-\s]+)\??$", text)
        if not m:
            return None
        key = self._normalize_key(m.group(1))
        return key if key else None

    def _extract_referenced_known_key(self, user_message: str) -> Optional[str]:
        text = user_message.strip().lower()
        if not text or not self._known_keys:
            return None

        memory_cues = (" my ", "my ", "remember", "recall", "preference", "favorite", "favourite")
        if "?" not in text and not any(cue in text for cue in memory_cues):
            return None

        toks = self._token_set(text)
        stopwords = {"my", "is", "the", "a", "an", "of", "to", "in", "on", "for", "and", "or"}
        scored: List[Tuple[int, int, str]] = []

        for key in self._known_keys:
            key_parts = [p for p in key.split("_") if p and p not in stopwords]
            if not key_parts:
                continue
            hits = sum(1 for part in key_parts if part in toks)
            if (len(key_parts) == 1 and hits == 1) or (len(key_parts) >= 2 and hits >= max(1, len(key_parts) // 2)):
                scored.append((hits, len(key_parts), key))

        if not scored:
            return None

        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return scored[0][2]

    def _resolve_turn_key(self, user_message: str) -> Optional[str]:
        key = self._extract_my_fact_key(user_message)
        if key:
            return key
        return self._extract_referenced_known_key(user_message)

    def _extract_contextual_correction(self, user_message: str, last_key: Optional[str]) -> Optional[Tuple[str, str]]:
        if not last_key:
            return None

        lowered = user_message.strip().lower()
        if not lowered or lowered.startswith("/") or lowered.endswith("?"):
            return None

        correction_cues = [
            "not anymore",
            "actually",
            "instead",
            "correction",
            "changed",
            "changed my mind",
            "now it's",
            "now it is",
        ]
        if not any(cue in lowered for cue in correction_cues):
            return None

        patterns = [
            r"\bi\s+(?:prefer|like|love)\s+(.+)$",
            r"\bnow\s+it(?:'s| is)\s+(.+)$",
            r"\b(?:actually|instead)\s*,?\s*it(?:'s| is)\s+(.+)$",
            r"\b(?:correction)\s*[:\-]?\s*(.+)$",
            r"\bit(?:'s| is)\s+(.+)$",
        ]
        for pattern in patterns:
            m = re.search(pattern, lowered)
            if not m:
                continue
            value = m.group(1).strip(" .!")
            if value:
                return last_key, value
        return None

    def _extract_auto_memory_fact(self, user_message: str, last_key: Optional[str]) -> Optional[Tuple[str, str]]:
        raw = user_message.strip()
        if not raw or raw.startswith("/"):
            return None

        lowered = raw.lower().strip()
        if lowered.endswith("?"):
            return None

        pref_match = re.search(r"\bi\s+(?:like|love|prefer)\s+(.+)$", lowered)
        if pref_match:
            pref_value = pref_match.group(1).strip(" .!")
            correction_cues = ("changed my mind", "not anymore", "actually", "instead", "now")
            if last_key and any(cue in lowered for cue in correction_cues):
                if pref_value:
                    return last_key, pref_value
            if pref_value:
                return "likes", pref_value

        patterns = [
            (r"\bmy\s+favorite\s+([a-z0-9_\-\s]+?)\s+is\s+(.+)$", lambda g1, g2: (f"favorite_{self._normalize_key(g1)}", g2.strip(" .!"))),
            (r"\bmy\s+([a-z0-9_\-\s]+?)\s+is\s+(.+)$", lambda g1, g2: (self._normalize_key(g1), g2.strip(" .!"))),
            (r"\bi\s+live\s+in\s+(.+)$", lambda _g1, g2: ("home_city", g2.strip(" .!"))),
            (r"\bi\s*(?:am|'m)\s+from\s+(.+)$", lambda _g1, g2: ("hometown", g2.strip(" .!"))),
        ]

        for pattern, builder in patterns:
            m = re.search(pattern, lowered)
            if not m:
                continue
            g1 = m.group(1) if m.lastindex and m.lastindex >= 1 else ""
            g2 = m.group(2) if m.lastindex and m.lastindex >= 2 else g1
            key, value = builder(g1, g2)
            key = self._normalize_key(key)
            value = value.strip()
            if key and value:
                return key, value
        return None

    def _remember_if_changed(self, entity: str, key: str, value: str) -> None:
        try:
            existing = self.client.query(entity, key)
            if existing.found:
                current_value = existing.value
                if isinstance(current_value, dict):
                    current_value = current_value.get("text", current_value)
                if str(current_value).strip().lower() == value.strip().lower():
                    self._known_keys.add(key)
                    return
        except Exception:
            # If query fails, still attempt write.
            pass

        try:
            self.client.write(
                entity=entity,
                key=key,
                value={"text": value},
                summary=f"{key.replace('_', ' ')} is {value}",
                confidence=self.write_confidence,
                source=self.source,
                agent=self.agent_id,
            )
            self._known_keys.add(key)
        except Exception:
            pass

    def _humanize_value(self, value: Any) -> str:
        if isinstance(value, str):
            out = value.replace("_", " ").strip()
            return out or value
        return str(value)

    def _normalize_for_compare(self, text: str) -> str:
        lowered = text.lower().replace("_", " ")
        lowered = re.sub(r"[^a-z0-9\s]+", " ", lowered)
        lowered = re.sub(r"\s+", " ", lowered).strip()
        return lowered

    def _reply_mentions_value(self, reply: str, expected_value: Any) -> bool:
        expected = self._normalize_for_compare(self._humanize_value(expected_value))
        if not expected:
            return True
        reply_norm = self._normalize_for_compare(reply)
        if expected in reply_norm:
            return True

        tokens = [t for t in expected.split(" ") if len(t) > 2]
        if not tokens:
            return expected in reply_norm
        if len(tokens) == 1:
            return tokens[0] in reply_norm
        hits = sum(1 for token in tokens if token in reply_norm)
        needed = max(1, len(tokens) - 1)
        return hits >= needed

    def _format_memory_reply(self, key: str, value: Any) -> str:
        label = key.replace("_", " ").strip()
        clean = self._humanize_value(value)
        return f"I remember your {label} is {clean}."

    def _find_last_user_message(self, conversation_history: List[Dict[str, str]]) -> Optional[str]:
        for msg in reversed(conversation_history):
            if msg.get("role") == "user" and msg.get("content"):
                return str(msg["content"])
        return None

    def _extract_facts(self, text: str) -> List[str]:
        """Extract factual statements using simple heuristics."""
        sentences = re.split(r'[.!?]+', text)
        facts = []

        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue

            # Heuristic: contains numbers, proper nouns, or dates
            has_number = bool(re.search(r'\d+', sentence))
            has_proper_noun = bool(re.search(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', sentence))
            has_date = bool(re.search(r'\b\d{4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b', sentence))

            if has_number or has_proper_noun or has_date:
                facts.append(sentence)

        return facts[:5]  # Limit to 5 facts per response

    def _infer_entity(self, conversation_history: List[Dict[str, str]]) -> str:
        """Infer entity from conversation context."""
        # Look for entity mentions in recent messages
        recent = conversation_history[-10:] if len(conversation_history) > 10 else conversation_history

        for msg in reversed(recent):
            content = msg['content'].lower()
            # Look for project/entity patterns
            match = re.search(r'(project|entity|system|product)[\s_/-](\w+)', content)
            if match:
                return f"{match.group(1)}/{match.group(2)}"

        # Default fallback
        return f"conversation/{self.agent_id}"
