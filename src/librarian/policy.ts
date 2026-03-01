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
