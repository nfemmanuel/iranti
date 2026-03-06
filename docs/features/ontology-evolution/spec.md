# Ontology Evolution

## Overview
Ontology Evolution adds a governed way for Iranti to learn recurring concepts without allowing uncontrolled schema drift. The system keeps a small canonical ontology in the Staff Namespace, stages repeated new terms as candidates, allows provisional extension namespaces, and only promotes terms to canonical status under explicit policy. This preserves cross-instance consistency while still letting the memory layer adapt over time.

## Inputs
| Input | Type | Description |
|---|---|---|
| Core ontology seed | Protected Staff Namespace entries | Initial entity types, keys, relationships, and normalization rules stored under `system / ontology / *` |
| Incoming writes | `EntryInput` or chunked facts | Candidate facts observed by the Librarian during normal write or ingest flow |
| Repeated unknown concepts | Derived pattern | Concepts that do not map cleanly to core schema or extension registry |
| Promotion policy | Protected Staff Namespace entry | Rules controlling transition from candidate to provisional to canonical |
| Human approval | Operational decision | Required for promotion of provisional terms into the core canonical ontology |

## Outputs
| Output | Type | Description |
|---|---|---|
| Core schema snapshot | JSON | Canonical ontology definition under `system / ontology / core_schema` |
| Extension registry | JSON | Allowed extension namespaces and their status under `system / ontology / extension_registry` |
| Candidate term registry | JSON | Terms being observed but not yet promoted under `system / ontology / candidate_terms` |
| Promotion policy | JSON | Deterministic governance rules under `system / ontology / promotion_policy` |
| Change log | JSON | Append-only ontology governance events under `system / ontology / change_log` |

## Decision Tree / Flow
1. The Librarian receives a fact or chunked fact during `librarianWrite()` or `librarianIngest()`.
2. It attempts to map the fact onto the canonical ontology using current entity type, key, alias, and namespace rules.
3. If the concept fits the core ontology, it is stored normally with no ontology change.
4. If the concept does not fit the core ontology, the Librarian checks the extension registry for an existing provisional namespace.
5. If an appropriate extension exists, the fact is stored using that namespaced term.
6. If no extension exists, the concept is recorded in `system / ontology / candidate_terms` as a candidate rather than promoted immediately.
7. Candidate terms accumulate evidence such as seen count, distinct agents, and distinct projects.
8. Once promotion thresholds are met, the term may be promoted to provisional status inside an extension namespace.
9. Promotion from provisional to canonical requires stricter thresholds and human approval according to the promotion policy.
10. Every ontology change is written to `system / ontology / change_log`.

## Edge Cases
- Unknown concept appears once only: keep it as a candidate or caller-local namespaced term, do not promote.
- Multiple synonyms for one concept: learn aliases first before creating a new canonical term.
- A proposed term conflicts with existing canonical meaning: reject promotion and map to existing canonical vocabulary where possible.
- A candidate is common in one project but nowhere else: allow provisional extension use, but do not promote to canonical.
- Two instances evolve separately: export and import the ontology snapshot and change log to align them deterministically.
- Automatic learning tries to modify core schema directly: blocked by policy; core promotion is never automatic.

## Test Results
Initial foundation implemented:
- Seeded protected Staff Namespace entries for ontology evolution in `scripts/seed.ts`
- Reserved ontology governance keys in `src/librarian/guards.ts`
- No promotion engine or automatic candidate accumulation has been implemented yet
- Current result is governance scaffolding, not autonomous ontology evolution behavior

## Related
- [AGENTS.md](/C:/Users/NF/Documents/Projects/iranti/AGENTS.md)
- [seed.ts](/C:/Users/NF/Documents/Projects/iranti/scripts/seed.ts)
- [guards.ts](/C:/Users/NF/Documents/Projects/iranti/src/librarian/guards.ts)
- [spec.md](/C:/Users/NF/Documents/Projects/iranti/docs/features/chunking/spec.md)
- [004-ontology-evolution-governance.md](/C:/Users/NF/Documents/Projects/iranti/docs/decisions/004-ontology-evolution-governance.md)
