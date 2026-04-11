/**
 * Librarian conflict policy — defines the rules that govern how conflicting
 * knowledge entries are resolved.
 *
 * `ConflictPolicy` is the primary configuration object for the Librarian.
 * `DEFAULT_POLICY` provides sensible defaults that work out of the box;
 * deployments can override fields by storing a `conflict_policy` entry under
 * `system/librarian` in the knowledge store (see `getPolicy.ts`).
 *
 * Key policy fields:
 *  - `minConfidenceToOverwrite` — incoming entry must exceed this to replace an existing one
 *  - `minConfidenceToAccept`    — minimum confidence for any entry to be written at all
 *  - `minResolutionCertainty`   — floor for the resolution certainty score (0-1)
 *  - `sourceReliability`        — per-source trust multiplier (0-1), merged with learned scores
 *  - `ttlDefaultsByKey`         — default TTL in seconds per key name
 *  - `authoritativeSourcesByKey`— sources that always win for a given key
 *  - `maxKeysPerEntity`         — soft cap on how many keys the observe path injects per entity
 *  - `maxEntitiesPerObserve`    — soft cap on how many entities observe injects per call
 */

export type ConflictPolicy = {
  minConfidenceToOverwrite: number;
  minConfidenceToAccept: number;
  minResolutionCertainty: number;
  sourceReliability: Record<string, number>;
  ttlDefaultsByKey: Record<string, number>;
  authoritativeSourcesByKey: Record<string, string[]>;
  observeKeyPriority?: Record<string, string[]>;
  maxKeysPerEntity?: number;
  maxEntitiesPerObserve?: number;
};

export const DEFAULT_POLICY: ConflictPolicy = {
  minConfidenceToOverwrite: 10,
  minConfidenceToAccept: 50,
  minResolutionCertainty: 0.7,
  sourceReliability: {
    HumanReview: 1.0,
    OpenAlex: 0.9,
    Librarian: 0.8,
    seed: 1.0,
  },
  ttlDefaultsByKey: {},
  authoritativeSourcesByKey: {},
  observeKeyPriority: {},
  maxKeysPerEntity: 5,
  maxEntitiesPerObserve: 5,
};
