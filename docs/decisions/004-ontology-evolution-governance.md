# 004 - Ontology Evolution Governance

## Context
Iranti needs enough standardization to make retrieval consistent across agents and deployments, but it also needs enough flexibility to absorb new domains over time. If the system is fully rigid, new use cases become awkward and require manual schema work. If the system is fully adaptive, the ontology drifts and retrieval quality degrades. The system needs a governed mechanism for evolving its ontology without allowing arbitrary self-invention.

## Decision
Iranti will use a governed ontology evolution model stored in the protected Staff Namespace. A small canonical ontology will define core entity types, core keys, relationship vocabulary, and normalization rules. New concepts will be staged as `candidate` terms, may be promoted to `provisional` extension terms under deterministic policy thresholds, and may only become `canonical` through stricter rules plus human approval. Core ontology changes will never be automatic.

## Consequences
This adds a stable path for ontology growth while preserving consistency. It improves cross-instance alignment, reduces duplicate vocabularies, and gives the Librarian a clear place to record repeated unknown concepts. It also adds governance overhead: promotion policy, review rules, and ontology exports/imports become part of operations. In the near term, only the Staff Namespace foundation is being added; the automatic candidate accumulation and promotion engine still need implementation.

## Alternatives Considered
Fully caller-defined ontology was considered and rejected because it leads to uncontrolled vocabulary drift and inconsistent retrieval across instances. Fully rigid canonical schema was considered and rejected because it cannot scale gracefully across homework, research, programming, and large project management use cases. Free-form autonomous ontology invention by the Librarian was considered and rejected because it would optimize for short-term convenience at the cost of long-term memory quality and portability.
