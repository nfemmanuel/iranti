#!/usr/bin/env python3
"""
CrewAI + Iranti Integration Experiment

Uses CrewAI agents with Iranti API as the LLM provider.
No external API keys needed - uses your local Iranti mock provider.
"""

import os
import time
import json
from datetime import datetime
from typing import List, Dict, Any
import concurrent.futures
import requests

# Set environment variables for CrewAI to use Iranti API
os.environ["OPENAI_API_BASE"] = "http://localhost:3001/v1"
os.environ["OPENAI_API_KEY"] = "dev_test_key_12345"
os.environ["OPENAI_MODEL_NAME"] = "mock"

try:
    from crewai import Agent, Task, Crew
    from crewai.llm import LLM
    CREWAI_AVAILABLE = True
except ImportError:
    print("CrewAI not installed. Install with: pip install crewai")
    CREWAI_AVAILABLE = False

class IrantiLLM:
    """Custom LLM wrapper for Iranti API"""
    def __init__(self, base_url: str = "http://localhost:3001", api_key: str = "dev_test_key_12345"):
        self.base_url = base_url
        self.api_key = api_key
        self.headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
    
    def call(self, messages: List[Dict[str, str]]) -> str:
        """Call Iranti API directly"""
        response = requests.post(
            f"{self.base_url}/v1/chat/completions",
            headers=self.headers,
            json={"messages": messages}
        )
        if response.status_code == 200:
            return response.json()["choices"][0]["message"]["content"]
        else:
            raise Exception(f"Iranti API error: {response.status_code}")

def create_research_agent(agent_id: str, use_iranti_memory: bool = False) -> Agent:
    """Create a CrewAI research agent"""
    
    # Configure LLM to use Iranti
    llm = LLM(
        model="mock",
        base_url="http://localhost:3001/v1",
        api_key="dev_test_key_12345"
    )
    
    role = "Research Specialist"
    if use_iranti_memory:
        role += " with Memory System"
        backstory = f"""You are {agent_id}, a research specialist with access to a persistent memory system (Iranti).
        You can remember findings from previous sessions and build upon existing knowledge.
        You excel at connecting information across different research sessions."""
    else:
        backstory = f"""You are {agent_id}, a research specialist working independently.
        You gather information for each task from scratch without access to previous findings."""
    
    return Agent(
        role=role,
        goal="Conduct thorough research and provide accurate, detailed findings",
        backstory=backstory,
        llm=llm,
        verbose=True,
        allow_delegation=False
    )

def create_research_task(topic: str, agent: Agent) -> Task:
    """Create a research task for the agent"""
    return Task(
        description=f"""Research the following topic thoroughly: {topic}
        
        Provide:
        1. Key facts and findings
        2. Important details and context
        3. Relevant connections to related topics
        4. Confidence level in your findings (1-100)
        
        Format your response as structured information that could be stored and referenced later.""",
        agent=agent,
        expected_output="Detailed research findings with key facts, context, and confidence level"
    )

def run_crewai_experiment(agent_id: str, use_iranti: bool, topic: str) -> Dict[str, Any]:
    """Run a single CrewAI experiment"""
    start_time = time.time()
    
    try:
        # Create agent and task
        agent = create_research_agent(agent_id, use_iranti)
        task = create_research_task(topic, agent)
        
        # Create and run crew
        crew = Crew(
            agents=[agent],
            tasks=[task],
            verbose=True
        )
        
        result = crew.kickoff()
        
        end_time = time.time()
        
        return {
            "agent_id": agent_id,
            "group": "iranti" if use_iranti else "control",
            "topic": topic,
            "result": str(result),
            "duration": end_time - start_time,
            "success": True,
            "memory_enabled": use_iranti
        }
        
    except Exception as e:
        end_time = time.time()
        return {
            "agent_id": agent_id,
            "group": "iranti" if use_iranti else "control", 
            "topic": topic,
            "result": f"Error: {str(e)}",
            "duration": end_time - start_time,
            "success": False,
            "memory_enabled": use_iranti
        }

def run_parallel_crewai_experiments(num_agents: int = 4) -> List[Dict[str, Any]]:
    """Run parallel CrewAI experiments"""
    
    topics = [
        "Artificial Intelligence in Healthcare",
        "Climate Change Mitigation Strategies", 
        "Quantum Computing Applications",
        "Sustainable Energy Technologies",
        "Machine Learning Ethics",
        "Blockchain Technology Use Cases"
    ]
    
    experiments = []
    
    # Create experiments: half control, half with Iranti memory
    for i in range(num_agents):
        use_iranti = i >= num_agents // 2
        topic = topics[i % len(topics)]
        agent_id = f"crew_agent_{i:03d}_{'iranti' if use_iranti else 'control'}"
        
        experiments.append((agent_id, use_iranti, topic))
    
    print(f"🚀 Starting {num_agents} CrewAI agents in parallel...")
    
    # Run experiments in parallel
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(num_agents, 4)) as executor:
        future_to_experiment = {
            executor.submit(run_crewai_experiment, agent_id, use_iranti, topic): (agent_id, use_iranti, topic)
            for agent_id, use_iranti, topic in experiments
        }
        
        for future in concurrent.futures.as_completed(future_to_experiment):
            try:
                result = future.result()
                results.append(result)
                status = "✓" if result["success"] else "✗"
                print(f"{status} {result['agent_id']} ({result['group']}) - {result['duration']:.2f}s")
            except Exception as exc:
                agent_id, use_iranti, topic = future_to_experiment[future]
                print(f"✗ {agent_id} - Exception: {exc}")
    
    return results

def analyze_crewai_results(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Analyze CrewAI experiment results"""
    control_results = [r for r in results if r["group"] == "control" and r["success"]]
    iranti_results = [r for r in results if r["group"] == "iranti" and r["success"]]
    
    analysis = {
        "timestamp": datetime.now().isoformat(),
        "total_experiments": len(results),
        "successful_experiments": len([r for r in results if r["success"]]),
        "control_group": {
            "count": len(control_results),
            "avg_duration": sum(r["duration"] for r in control_results) / len(control_results) if control_results else 0,
            "success_rate": len(control_results) / len([r for r in results if r["group"] == "control"]) if results else 0,
        },
        "iranti_group": {
            "count": len(iranti_results),
            "avg_duration": sum(r["duration"] for r in iranti_results) / len(iranti_results) if iranti_results else 0,
            "success_rate": len(iranti_results) / len([r for r in results if r["group"] == "iranti"]) if results else 0,
        }
    }
    
    return analysis

def main():
    if not CREWAI_AVAILABLE:
        print("Please install CrewAI first:")
        print("pip install crewai")
        return
    
    print("🤖 CrewAI + Iranti Integration Experiment")
    print("=" * 50)
    
    # Check if Iranti API is running
    try:
        response = requests.get("http://localhost:3001/health")
        if response.status_code == 200:
            print("✓ Iranti API is running")
        else:
            print("✗ Iranti API health check failed")
            return
    except requests.exceptions.ConnectionError:
        print("✗ Cannot connect to Iranti API. Make sure it's running on port 3001")
        return
    
    # Run CrewAI experiments
    start_time = time.time()
    results = run_parallel_crewai_experiments(num_agents=4)
    total_time = time.time() - start_time
    
    print(f"\n⏱️  Total experiment time: {total_time:.2f}s")
    
    # Analyze results
    analysis = analyze_crewai_results(results)
    
    print("\n📊 CrewAI Results Analysis:")
    print("=" * 35)
    print(f"Total Experiments: {analysis['total_experiments']}")
    print(f"Successful: {analysis['successful_experiments']}")
    
    print(f"\nControl Group (no Iranti memory):")
    print(f"  - Count: {analysis['control_group']['count']}")
    print(f"  - Avg Duration: {analysis['control_group']['avg_duration']:.2f}s")
    print(f"  - Success Rate: {analysis['control_group']['success_rate']:.1%}")
    
    print(f"\nIranti Group (with memory):")
    print(f"  - Count: {analysis['iranti_group']['count']}")
    print(f"  - Avg Duration: {analysis['iranti_group']['avg_duration']:.2f}s")
    print(f"  - Success Rate: {analysis['iranti_group']['success_rate']:.1%}")
    
    # Save results
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    results_file = f"crewai_experiment_results_{timestamp}.json"
    
    with open(results_file, 'w') as f:
        json.dump({
            "analysis": analysis,
            "raw_results": results
        }, f, indent=2)
    
    print(f"\n💾 Detailed results saved to: {results_file}")
    
    # Show sample outputs
    if results:
        print(f"\n📝 Sample Research Output:")
        print("=" * 30)
        for result in results[:2]:  # Show first 2 results
            print(f"\n{result['agent_id']} ({result['group']}):")
            print(f"Topic: {result['topic']}")
            if result['success']:
                # Truncate long outputs
                output = result['result'][:300] + "..." if len(result['result']) > 300 else result['result']
                print(f"Output: {output}")
            else:
                print(f"Error: {result['result']}")

if __name__ == "__main__":
    main()