"""
Raw OpenAI API Validation
Entity: project/void_runner (fictional)
Framework: OpenAI API with function calling (no agent framework)
Goal: Validate Iranti works with raw OpenAI function calling
"""

import os
import json
from datetime import datetime
from dotenv import load_dotenv
from openai import OpenAI
import sys
sys.path.append('.')
from clients.python.iranti import IrantiClient

load_dotenv()

# Configuration
ENTITY = "project/void_runner"
IRANTI_URL = "http://localhost:3001"
IRANTI_API_KEY = os.getenv("IRANTI_API_KEY", "dev-benchmark-key")

# Initialize clients
iranti = IrantiClient(base_url=IRANTI_URL, api_key=IRANTI_API_KEY)
openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Fictional facts
FACTS = [
    {"key": "architect", "value": {"name": "Dr. Chioma Adebayo"}, "summary": "Chief architect is Dr. Chioma Adebayo", "confidence": 94},
    {"key": "investment", "value": {"amount": "$47.2 million", "source": "Apex Ventures Series E"}, "summary": "Investment: $47.2 million from Apex Ventures Series E", "confidence": 92},
    {"key": "completion", "value": {"date": "January 23, 2029"}, "summary": "Completion date: January 23, 2029", "confidence": 96},
    {"key": "milestone", "value": {"current": "Phase 9: void propulsion testing"}, "summary": "Current milestone: Phase 9 void propulsion testing", "confidence": 90},
    {"key": "challenge", "value": {"issue": "Quantum stabilizer failure in module QS-3304"}, "summary": "Challenge: Quantum stabilizer failure in module QS-3304", "confidence": 86}
]

# Function definitions for OpenAI
FUNCTIONS = [
    {
        "name": "save_fact",
        "description": "Save a fact to shared memory",
        "parameters": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "Fact key (e.g. 'architect', 'budget')"},
                "value": {"type": "string", "description": "Fact value"},
                "summary": {"type": "string", "description": "Brief summary of the fact"},
                "confidence": {"type": "integer", "description": "Confidence score 0-100"}
            },
            "required": ["key", "value", "summary", "confidence"]
        }
    },
    {
        "name": "load_facts",
        "description": "Load all facts from shared memory",
        "parameters": {"type": "object", "properties": {}}
    }
]

def execute_function(function_name: str, arguments: dict) -> str:
    """Execute function calls from OpenAI."""
    if function_name == "save_fact":
        result = iranti.write(
            entity=ENTITY,
            key=arguments["key"],
            value={"data": arguments["value"]},
            summary=arguments["summary"],
            confidence=arguments["confidence"],
            source="openai_function",
            agent="raw_api_agent"
        )
        return json.dumps({"status": "saved", "action": result.action})
    
    elif function_name == "load_facts":
        facts = iranti.query_all(ENTITY)
        return json.dumps([{"key": f["key"], "summary": f["summary"], "confidence": f["confidence"]} for f in facts])
    
    return json.dumps({"error": "Unknown function"})

def run_agent_with_functions(system_prompt: str, user_message: str) -> str:
    """Run OpenAI agent with function calling."""
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message}
    ]
    
    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        functions=FUNCTIONS,
        function_call="auto",
        temperature=0
    )
    
    # Handle function calls
    while response.choices[0].message.function_call:
        function_call = response.choices[0].message.function_call
        function_name = function_call.name
        function_args = json.loads(function_call.arguments)
        
        # Execute function
        function_result = execute_function(function_name, function_args)
        
        # Add function result to messages
        messages.append({
            "role": "assistant",
            "content": None,
            "function_call": {"name": function_name, "arguments": function_call.arguments}
        })
        messages.append({
            "role": "function",
            "name": function_name,
            "content": function_result
        })
        
        # Get next response
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            functions=FUNCTIONS,
            function_call="auto",
            temperature=0
        )
    
    return response.choices[0].message.content

def run_experiment():
    print("=" * 80)
    print("RAW OPENAI API VALIDATION EXPERIMENT")
    print("=" * 80)
    print(f"Entity: {ENTITY}")
    print(f"Framework: OpenAI API + Function Calling (no agent framework)")
    print(f"Facts: {len(FACTS)}")
    print()
    
    start_time = datetime.now()
    
    # Agent 1: Writer
    print("AGENT 1: WRITER (Raw OpenAI)")
    print("-" * 80)
    
    briefing = f"""
    PROJECT BRIEFING: Void Runner Initiative
    
    Chief Architect: Dr. Chioma Adebayo
    Investment: $47.2 million from Apex Ventures Series E round
    Completion: January 23, 2029
    Milestone: Phase 9 - void propulsion testing underway
    Challenge: Quantum stabilizer failure detected in module QS-3304
    
    Extract all facts and save them using the save_fact function.
    """
    
    writer_output = run_agent_with_functions(
        system_prompt="You are a research analyst. Extract facts from briefings and save them using save_fact function.",
        user_message=briefing
    )
    
    print(f"Writer output: {writer_output}")
    print()
    
    # Verify facts were written
    saved_facts = iranti.query_all(ENTITY)
    print(f"Facts saved to Iranti: {len(saved_facts)}")
    print()
    
    # Agent 2: Reader (separate execution)
    print("AGENT 2: READER (Raw OpenAI)")
    print("-" * 80)
    
    reader_output = run_agent_with_functions(
        system_prompt="You are a project analyst. Use load_facts to retrieve information, then answer questions.",
        user_message="Load all facts from memory and tell me: who's the architect, what's the investment, when's completion, what milestone are we at, and what's the challenge?"
    )
    
    print(f"Reader output: {reader_output}")
    print()
    
    # Score results
    print("VALIDATION")
    print("-" * 80)
    
    output = reader_output.lower()
    scores = {
        "architect": "chioma adebayo" in output,
        "investment": "47.2" in output and "million" in output,
        "completion": "january" in output and "2029" in output,
        "milestone": "phase 9" in output or "void propulsion" in output,
        "challenge": "quantum stabilizer" in output and "qs-3304" in output
    }
    
    correct = sum(scores.values())
    total = len(scores)
    
    print(f"Facts retrieved: {correct}/{total}")
    for key, found in scores.items():
        print(f"  {key}: {'PASS' if found else 'FAIL'}")
    
    elapsed = (datetime.now() - start_time).total_seconds()
    print(f"\nTime elapsed: {elapsed:.1f}s")
    
    status = "PASSED" if correct == total else "FAILED"
    print(f"Status: {status}")
    
    # Save results
    result_data = {
        "experiment": "Raw OpenAI API",
        "entity": ENTITY,
        "framework": "OpenAI API + Function Calling",
        "facts_total": len(FACTS),
        "facts_saved": len(saved_facts),
        "facts_retrieved": correct,
        "score": f"{correct}/{total}",
        "details": scores,
        "elapsed_seconds": elapsed,
        "status": "PASSED" if correct == total else "FAILED",
        "timestamp": datetime.now().isoformat()
    }
    
    output_file = f"clients/experiments/results/openai_void_runner_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    os.makedirs("clients/experiments/results", exist_ok=True)
    with open(output_file, 'w') as f:
        json.dump(result_data, f, indent=2)
    
    print(f"\nResults saved: {output_file}")
    
    return correct == total

if __name__ == "__main__":
    success = run_experiment()
    exit(0 if success else 1)
