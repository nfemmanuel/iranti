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
    middleware.after_receive(
        response="The blocker is...",
        conversation_history=[...]
    )
"""
import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from python.iranti import IrantiClient
import re
from typing import List, Dict, Optional

class IrantiMiddleware:
    """Wraps LLM conversations with Iranti memory injection."""
    
    def __init__(
        self,
        agent_id: str,
        iranti_url: str = "http://localhost:3001",
        iranti_api_key: Optional[str] = None,
        context_window: int = 20,
        max_facts: int = 5
    ):
        """
        Initialize middleware.
        
        Args:
            agent_id: Unique identifier for this agent
            iranti_url: Iranti API server URL
            iranti_api_key: API key (or set IRANTI_API_KEY env var)
            context_window: Number of recent messages to include in context (default 20)
            max_facts: Maximum facts to inject per message (default 5)
        """
        self.agent_id = agent_id
        self.context_window = context_window
        self.max_facts = max_facts
        self.client = IrantiClient(base_url=iranti_url, api_key=iranti_api_key)
    
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
        # Build context from recent messages
        recent = conversation_history[-self.context_window:] if len(conversation_history) > self.context_window else conversation_history
        context_parts = [f"{msg['role']}: {msg['content']}" for msg in recent]
        context_parts.append(f"user: {user_message}")
        context_str = "\n".join(context_parts)
        
        # Call observe() to get forgotten facts
        try:
            result = self.client.observe(
                agent_id=self.agent_id,
                current_context=context_str,
                max_facts=self.max_facts
            )
            facts = result.get('facts', [])
            
            if not facts:
                return user_message
            
            # Prepend facts as memory injection
            fact_lines = [f"- {f['summary']}" for f in facts]
            memory_note = "[MEMORY: " + "; ".join(fact_lines) + "]\n\n"
            return memory_note + user_message
            
        except Exception as e:
            # Silent failure - return original message
            print(f"[Iranti] observe() failed: {e}")
            return user_message
    
    def after_receive(
        self,
        response: str,
        conversation_history: List[Dict[str, str]]
    ) -> None:
        """
        Extract and save new facts from LLM response.
        
        Args:
            response: The LLM's response
            conversation_history: Full conversation history
        """
        # Extract factual statements (best-effort heuristic)
        facts = self._extract_facts(response)
        
        if not facts:
            return
        
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
