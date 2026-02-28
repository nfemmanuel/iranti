"""
Quick smoke test for the Iranti Python client.
Requires the API server to be running: npm run api
"""

import sys
import time
from iranti import IrantiClient, IrantiError

def test():
    print('\nTesting Iranti Python Client...\n')

    client = IrantiClient(
        base_url='http://localhost:3000',
        api_key='dev_test_key_12345'   # match IRANTI_API_KEY in .env
    )

    ts = int(time.time())
    entity = f'researcher/py_test_{ts}'

    # Health
    print('Test 1 — health check:')
    health = client.health()
    print(f'  status: {health["status"]}, provider: {health["provider"]}')

    # Write
    print('\nTest 2 — write:')
    result = client.write(
        entity=entity,
        key='affiliation',
        value={'institution': 'Oxford'},
        summary='Affiliated with Oxford University',
        confidence=85,
        source='OpenAlex',
        agent='py_agent_001'
    )
    print(f'  {result.action} | {result.reason}')

    # Query
    print('\nTest 3 — query:')
    q = client.query(entity, 'affiliation')
    print(f'  found: {q.found}')
    if q.found:
        print(f'  value: {q.value}')
        print(f'  confidence: {q.confidence}')

    # Ingest
    print('\nTest 4 — ingest:')
    result = client.ingest(
        entity=f'researcher/py_ingest_{ts}',
        content='Dr. Alex Kim has 22 publications and is a professor at Cambridge. Research focus: quantum computing.',
        source='OpenAlex',
        confidence=80,
        agent='py_agent_001'
    )
    print(f'  written: {result.written}, rejected: {result.rejected}')

    # Register agent
    print('\nTest 5 — register agent:')
    client.register_agent(
        agent_id=f'py_agent_{ts}',
        name='Python Agent',
        description='Test agent from Python client',
        capabilities=['testing', 'validation'],
        model='mock'
    )
    agent = client.get_agent(f'py_agent_{ts}')
    print(f'  registered: {agent.profile["name"]}')

    # Handshake
    print('\nTest 6 — handshake:')
    brief = client.handshake(
        agent=f'py_agent_{ts}',
        task='Research publication history',
        recent_messages=['Starting research...']
    )
    print(f'  task inferred: {brief.inferred_task_type}')
    print(f'  working memory: {len(brief.working_memory)} entries')

    # Maintenance
    print('\nTest 7 — maintenance:')
    report = client.run_maintenance()
    print(f'  expired archived: {report.expired_archived}')
    print(f'  errors: {report.errors or "none"}')

    print('\n=== Python client test complete ===\n')

if __name__ == '__main__':
    try:
        test()
    except IrantiError as e:
        print(f'\nTest failed: {e}')
        sys.exit(1)
