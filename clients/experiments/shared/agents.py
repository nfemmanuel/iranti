"""
Shared agent and task definitions.
Both control and treatment crews use identical agents and tasks.
The only difference: treatment agents have Iranti tools available.
"""

RESEARCHER_ROLE = "Academic Researcher"
RESEARCHER_GOAL = "Find accurate, detailed information about AI researchers including their affiliations, publication counts, research focus areas, and career history."
RESEARCHER_BACKSTORY = "You are a meticulous academic researcher with access to databases like OpenAlex and ORCID. You verify facts carefully and note your confidence level in each finding."

ANALYST_ROLE = "Research Analyst"  
ANALYST_GOAL = "Synthesize and verify research findings, identify any gaps or inconsistencies, and produce a final verified profile."
ANALYST_BACKSTORY = "You are a senior research analyst who cross-references multiple sources. You build on prior research rather than starting from scratch, and you flag any contradictions you find."

# The three researchers we'll investigate
# Using real, well-documented researchers for accurate LLM responses
RESEARCH_TARGETS = [
    {
        "name": "Yann LeCun",
        "entity": "researcher/yann_lecun",
        "task": "Research Yann LeCun's current affiliation, approximate publication count, primary research focus, and most notable contribution to AI.",
    },
    {
        "name": "Andrej Karpathy", 
        "entity": "researcher/andrej_karpathy",
        "task": "Research Andrej Karpathy's current affiliation, approximate publication count, primary research focus, and career history including any industry roles.",
    },
    {
        "name": "Fei-Fei Li",
        "entity": "researcher/fei_fei_li", 
        "task": "Research Fei-Fei Li's current affiliation, approximate publication count, primary research focus, and most notable contribution to AI.",
    },
]
