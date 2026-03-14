"""
Iranti Python Client
====================
HTTP client for the Iranti REST API.
Works with any Python agent framework: CrewAI, AutoGen, LangChain, etc.

Usage:
    from iranti import IrantiClient

    client = IrantiClient(
        base_url="http://localhost:3001",
        api_key="your_key_here"
    )

    client.write(
        entity="researcher/jane_smith",
        key="affiliation",
        value={"institution": "MIT"},
        summary="Affiliated with MIT",
        confidence=85,
        source="OpenAlex",
        agent="my_agent"
    )
"""

import os
import requests
from typing import Any, Optional
from dataclasses import dataclass, field

__version__ = "0.1.4"


# ─── Types ────────────────────────────────────────────────────────────────────

@dataclass
class WriteResult:
    action: str
    key: str
    reason: str
    resolved_entity: Optional[str] = None
    input_entity: Optional[str] = None
    http_status: Optional[int] = None


@dataclass
class IngestResult:
    written: int
    rejected: int
    escalated: int
    facts: list[dict]


@dataclass
class QueryResult:
    found: bool
    value: Optional[Any] = None
    summary: Optional[str] = None
    confidence: Optional[int] = None
    source: Optional[str] = None
    valid_from: Optional[str] = None
    valid_until: Optional[str] = None
    contested: Optional[bool] = None
    from_archive: Optional[bool] = None
    archived_reason: Optional[str] = None
    resolution_state: Optional[str] = None
    resolution_outcome: Optional[str] = None
    resolved_entity: Optional[str] = None
    input_entity: Optional[str] = None
    http_status: Optional[int] = None


@dataclass
class HistoryEntry:
    value: Any
    summary: str
    confidence: int
    source: str
    valid_from: str
    valid_until: Optional[str]
    is_current: bool
    contested: bool
    archived_reason: Optional[str] = None
    resolution_state: Optional[str] = None
    resolution_outcome: Optional[str] = None


@dataclass
class WorkingMemoryEntry:
    entity_key: str
    summary: str
    confidence: int
    source: str
    last_updated: str


@dataclass
class WorkingMemoryBrief:
    agent_id: str
    operating_rules: str
    inferred_task_type: str
    working_memory: list[WorkingMemoryEntry]
    session_started: str
    brief_generated_at: str
    context_call_count: int


@dataclass
class AgentStats:
    total_writes: int
    total_rejections: int
    total_escalations: int
    avg_confidence: float
    last_seen: str
    is_active: bool


@dataclass
class AgentRecord:
    profile: dict
    stats: AgentStats


@dataclass
class MaintenanceReport:
    expired_archived: int
    low_confidence_archived: int
    escalations_processed: int
    errors: list[str]


# ─── Exceptions ───────────────────────────────────────────────────────────────

class IrantiError(Exception):
    """Base exception for Iranti client errors."""
    pass


class IrantiAuthError(IrantiError):
    """Raised when API key is invalid or missing."""
    pass


class IrantiNotFoundError(IrantiError):
    """Raised when a resource is not found."""
    pass


class IrantiValidationError(IrantiError):
    """Raised when request data is invalid."""
    pass


# ─── Client ───────────────────────────────────────────────────────────────────

class IrantiClient:
    """
    Python client for the Iranti REST API.

    Args:
        base_url: URL of the running Iranti API server.
                  Defaults to IRANTI_URL env var or http://localhost:3001
        api_key:  API key for authentication.
                  Defaults to IRANTI_API_KEY env var
        timeout:  Request timeout in seconds. Default: 30
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: int = 30,
    ):
        self.base_url = (
            base_url
            or os.getenv('IRANTI_URL')
            or 'http://localhost:3001'
        ).rstrip('/')

        self.api_key = api_key or os.getenv('IRANTI_API_KEY')
        self.timeout = timeout

        if not self.api_key:
            raise IrantiError(
                'API key is required. Pass api_key= or set IRANTI_API_KEY env var.'
            )

        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
            'X-Iranti-Key': self.api_key,
        })
        self.last_http_status: Optional[int] = None
        self.last_http_method: Optional[str] = None
        self.last_http_path: Optional[str] = None
        self.last_http_ok: Optional[bool] = None

    # ── Internal ──────────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, **kwargs) -> Any:
        url = f'{self.base_url}{path}'
        try:
            response = self.session.request(method, url, timeout=self.timeout, **kwargs)
        except requests.ConnectionError:
            raise IrantiError(
                f'Could not connect to Iranti API at {self.base_url}. '
                'Is the server running? Try: npm run api'
            )
        except requests.Timeout:
            raise IrantiError(f'Request timed out after {self.timeout}s.')

        self.last_http_status = response.status_code
        self.last_http_method = method
        self.last_http_path = path
        self.last_http_ok = response.ok

        if response.status_code == 401:
            raise IrantiAuthError('Invalid or missing API key.')
        if response.status_code == 404:
            try:
                error_msg = response.json().get('error', 'Not found.')
            except Exception:
                error_msg = 'Not found.'
            raise IrantiNotFoundError(error_msg)
        if response.status_code == 400:
            raise IrantiValidationError(response.json().get('error', 'Bad request.'))
        if not response.ok:
            raise IrantiError(
                f'API error {response.status_code}: {response.text[:200]}'
            )

        return response.json()

    def _get(self, path: str) -> Any:
        return self._request('GET', path)

    def _post(self, path: str, data: dict) -> Any:
        return self._request('POST', path, json=data)

    # ── Health ────────────────────────────────────────────────────────────────

    def health(self) -> dict:
        """Check if the Iranti API is running. Does not require auth."""
        try:
            response = requests.get(
                f'{self.base_url}/health',
                timeout=self.timeout
            )
            return response.json()
        except requests.ConnectionError:
            raise IrantiError(
                f'Could not connect to Iranti API at {self.base_url}.'
            )

    # ── Write ─────────────────────────────────────────────────────────────────

    def write(
        self,
        entity: str,
        key: str,
        value: Any,
        summary: str,
        confidence: int,
        source: str,
        agent: str,
        valid_from: Optional[str] = None,
        valid_until: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> WriteResult:
        """
        Write an atomic fact to the knowledge base.

        Args:
            entity:      Entity in format "entityType/entityId"
            key:         Fact key e.g. "affiliation"
            value:       Full fact value (any JSON-serializable object)
            summary:     One-sentence summary for working memory
            confidence:  0-100
            source:      Data source name
            agent:       Agent ID writing this fact
            valid_from: ISO datetime string for when the fact became true/current
            valid_until: Deprecated. Not accepted by the temporal-versioning MVP.
            request_id:  Optional idempotency key for safe retries
        """
        payload = {
            'entity': entity,
            'key': key,
            'value': value,
            'summary': summary,
            'confidence': confidence,
            'source': source,
            'agent': agent,
        }
        if valid_from:
            payload['validFrom'] = valid_from
        if valid_until:
            raise IrantiValidationError('valid_until is not accepted by the temporal-versioning MVP.')
        if request_id:
            payload['requestId'] = request_id

        data = self._post('/kb/write', payload)
        return WriteResult(**{
            'action': data['action'],
            'key': data['key'],
            'reason': data['reason'],
            'resolved_entity': data.get('resolvedEntity'),
            'input_entity': data.get('inputEntity'),
            'http_status': self.last_http_status,
        })

    # ── Ingest ────────────────────────────────────────────────────────────────

    def ingest(
        self,
        entity: str,
        content: str,
        source: str,
        confidence: int,
        agent: str,
    ) -> IngestResult:
        """
        Ingest a raw text blob. Iranti chunks it into atomic facts automatically.

        Args:
            entity:     Entity in format "entityType/entityId"
            content:    Raw text content to extract facts from
            source:     Data source name
            confidence: 0-100 applied to all extracted facts
            agent:      Agent ID ingesting this content
        """
        data = self._post('/kb/ingest', {
            'entity': entity,
            'content': content,
            'source': source,
            'confidence': confidence,
            'agent': agent,
        })
        return IngestResult(
            written=data['written'],
            rejected=data['rejected'],
            escalated=data['escalated'],
            facts=data['facts'],
        )

    # ── Query ─────────────────────────────────────────────────────────────────

    def query(
        self,
        entity: str,
        key: str,
        as_of: Optional[str] = None,
        include_expired: bool = False,
        include_contested: bool = True,
    ) -> QueryResult:
        """Query a specific fact about an entity."""
        entity_type, entity_id = entity.split('/', 1)
        params: dict[str, Any] = {
            'includeExpired': str(include_expired).lower(),
            'includeContested': str(include_contested).lower(),
        }
        if as_of:
            params['asOf'] = as_of
        data = self._request('GET', f'/kb/query/{entity_type}/{entity_id}/{key}', params=params)
        return QueryResult(
            found=data['found'],
            value=data.get('value'),
            summary=data.get('summary'),
            confidence=data.get('confidence'),
            source=data.get('source'),
            valid_from=data.get('validFrom'),
            valid_until=data.get('validUntil'),
            contested=data.get('contested'),
            from_archive=data.get('fromArchive'),
            archived_reason=data.get('archivedReason'),
            resolution_state=data.get('resolutionState'),
            resolution_outcome=data.get('resolutionOutcome'),
            resolved_entity=data.get('resolvedEntity'),
            input_entity=data.get('inputEntity'),
            http_status=self.last_http_status,
        )

    def history(
        self,
        entity: str,
        key: str,
        include_expired: bool = False,
        include_contested: bool = True,
    ) -> list[HistoryEntry]:
        """Return the temporal history for a specific fact."""
        entity_type, entity_id = entity.split('/', 1)
        data = self._request(
            'GET',
            f'/kb/history/{entity_type}/{entity_id}/{key}',
            params={
                'includeExpired': str(include_expired).lower(),
                'includeContested': str(include_contested).lower(),
            }
        )
        return [
            HistoryEntry(
                value=row['value'],
                summary=row['summary'],
                confidence=row['confidence'],
                source=row['source'],
                valid_from=row['validFrom'],
                valid_until=row.get('validUntil'),
                is_current=row['isCurrent'],
                contested=row['contested'],
                archived_reason=row.get('archivedReason'),
                resolution_state=row.get('resolutionState'),
                resolution_outcome=row.get('resolutionOutcome'),
            )
            for row in data
        ]

    def query_all(self, entity: str) -> list[dict]:
        """Query all facts about an entity."""
        entity_type, entity_id = entity.split('/', 1)
        return self._get(f'/kb/query/{entity_type}/{entity_id}')

    def search(
        self,
        query: str,
        limit: int = 10,
        entity_type: Optional[str] = None,
        entity_id: Optional[str] = None,
        lexical_weight: float = 0.45,
        vector_weight: float = 0.55,
        min_score: float = 0.0,
    ) -> list[dict]:
        """Run hybrid search (lexical + vector) across knowledge entries."""
        payload: dict[str, Any] = {
            'query': query,
            'limit': limit,
            'lexicalWeight': lexical_weight,
            'vectorWeight': vector_weight,
            'minScore': min_score,
        }
        if entity_type is not None:
            payload['entityType'] = entity_type
        if entity_id is not None:
            payload['entityId'] = entity_id

        data = self._request('GET', '/kb/search', params=payload)
        return data.get('results', [])

    # ── Relationships ─────────────────────────────────────────────────────────

    def relate(
        self,
        from_entity: str,
        relationship_type: str,
        to_entity: str,
        created_by: str,
        properties: Optional[dict] = None,
    ) -> None:
        """Create a directional relationship between two entities."""
        self._post('/kb/relate', {
            'fromEntity': from_entity,
            'relationshipType': relationship_type,
            'toEntity': to_entity,
            'createdBy': created_by,
            'properties': properties or {},
        })

    def get_related(self, entity: str) -> list[dict]:
        """Get directly related entities (1 hop)."""
        entity_type, entity_id = entity.split('/', 1)
        return self._get(f'/kb/related/{entity_type}/{entity_id}')

    def related(self, entity: str) -> list[dict]:
        """Alias for get_related()."""
        return self.get_related(entity)

    def get_related_deep(self, entity: str, depth: int = 2) -> list[dict]:
        """Get related entities up to N hops deep."""
        entity_type, entity_id = entity.split('/', 1)
        return self._get(f'/kb/related/{entity_type}/{entity_id}/deep?depth={depth}')

    def related_deep(self, entity: str, depth: int = 2) -> list[dict]:
        """Alias for get_related_deep()."""
        return self.get_related_deep(entity, depth=depth)

    # ── Working Memory ────────────────────────────────────────────────────────

    def handshake(
        self,
        agent: str,
        task: str,
        recent_messages: list[str],
    ) -> WorkingMemoryBrief:
        """
        Start an agent session. Returns a working memory brief
        containing operating rules and relevant knowledge for the task.
        """
        data = self._post('/memory/handshake', {
            'agent': agent,
            'task': task,
            'recentMessages': recent_messages,
        })
        return self._parse_brief(data)

    def reconvene(
        self,
        agent_id: str,
        task: str,
        recent_messages: list[str],
    ) -> WorkingMemoryBrief:
        """Update working memory if task context has shifted."""
        data = self._post('/memory/reconvene', {
            'agentId': agent_id,
            'task': task,
            'recentMessages': recent_messages,
        })
        return self._parse_brief(data)

    def who_knows(self, entity: str) -> list[dict]:
        """Find all agents that have written facts about an entity."""
        entity_type, entity_id = entity.split('/', 1)
        return self._get(f'/memory/whoknows/{entity_type}/{entity_id}')

    # ── Agents ────────────────────────────────────────────────────────────────

    def register_agent(
        self,
        agent_id: str,
        name: str,
        description: str,
        capabilities: list[str],
        model: Optional[str] = None,
        properties: Optional[dict] = None,
    ) -> None:
        """Register an agent in the registry."""
        payload = {
            'agentId': agent_id,
            'name': name,
            'description': description,
            'capabilities': capabilities,
        }
        if model:
            payload['model'] = model
        if properties:
            payload['properties'] = properties
        self._post('/agents/register', payload)

    def get_agent(self, agent_id: str) -> Optional[AgentRecord]:
        """Get agent profile and stats."""
        try:
            data = self._get(f'/agents/{agent_id}')
            stats_data = data['stats']
            return AgentRecord(
                profile=data['profile'],
                stats=AgentStats(
                    total_writes=stats_data['totalWrites'],
                    total_rejections=stats_data['totalRejections'],
                    total_escalations=stats_data['totalEscalations'],
                    avg_confidence=stats_data['avgConfidence'],
                    last_seen=stats_data['lastSeen'],
                    is_active=stats_data['isActive'],
                ),
            )
        except IrantiNotFoundError:
            return None

    def list_agents(self) -> list[dict]:
        """List all registered agents."""
        return self._get('/agents')

    def assign_to_team(self, agent_id: str, team_id: str) -> None:
        """Assign an agent to a team."""
        self._post(f'/agents/{agent_id}/team', {'teamId': team_id})

    # ── Maintenance ───────────────────────────────────────────────────────────

    def run_maintenance(self) -> MaintenanceReport:
        """Run the Archivist maintenance cycle."""
        data = self._post('/memory/maintenance', {})
        return MaintenanceReport(
            expired_archived=data['expiredArchived'],
            low_confidence_archived=data['lowConfidenceArchived'],
            escalations_processed=data['escalationsProcessed'],
            errors=data['errors'],
        )

    def observe(
        self,
        agent_id: str,
        current_context: str,
        max_facts: int = 5,
        entity_hints: Optional[list[str]] = None,
    ) -> dict:
        """
        Observe an agent's context window and return facts to inject.
        Call this before each agent LLM call to ensure relevant knowledge
        is present in context.

        Args:
            agent_id:        Agent whose knowledge base to search
            current_context: The agent's current prompt or context string
            max_facts:       Maximum facts to inject (default 5)

        Returns:
            dict with keys:
              facts           — list of facts to inject
              entitiesDetected — entities found in context
              alreadyPresent  — facts skipped (already in context)
              totalFound      — total facts found before filtering
        """
        payload = {
            'agentId': agent_id,
            'currentContext': current_context,
            'maxFacts': max_facts,
        }
        if entity_hints:
            payload['entityHints'] = entity_hints
        return self._post('/memory/observe', payload)

    def attend(
        self,
        agent_id: str,
        current_context: str,
        latest_message: Optional[str] = None,
        max_facts: int = 5,
        entity_hints: Optional[list[str]] = None,
        force_inject: bool = False,
    ) -> dict:
        """
        Ask Attendant to decide whether memory is needed for this turn.
        If needed, returns facts to inject; otherwise returns shouldInject=false.
        """
        payload = {
            'agentId': agent_id,
            'currentContext': current_context,
            'maxFacts': max_facts,
            'forceInject': force_inject,
        }
        if latest_message is not None:
            payload['latestMessage'] = latest_message
        if entity_hints:
            payload['entityHints'] = entity_hints
        return self._post('/memory/attend', payload)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _parse_brief(self, data: dict) -> WorkingMemoryBrief:
        entries = [
            WorkingMemoryEntry(
                entity_key=e['entityKey'],
                summary=e['summary'],
                confidence=e['confidence'],
                source=e['source'],
                last_updated=e['lastUpdated'],
            )
            for e in data.get('workingMemory', [])
        ]
        return WorkingMemoryBrief(
            agent_id=data['agentId'],
            operating_rules=data['operatingRules'],
            inferred_task_type=data['inferredTaskType'],
            working_memory=entries,
            session_started=data['sessionStarted'],
            brief_generated_at=data['briefGeneratedAt'],
            context_call_count=data['contextCallCount'],
        )

    def last_http(self) -> dict:
        """Metadata for the most recent API call."""
        return {
            'status': self.last_http_status,
            'method': self.last_http_method,
            'path': self.last_http_path,
            'ok': self.last_http_ok,
        }

