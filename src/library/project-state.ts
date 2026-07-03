// Project-state rollup — Layer 0e
//
// Answers "where did we leave off?" for a project, deterministically, by
// deriving from data iranti already writes — no new table, no migration
// (see docs/prds/phases/layer-0e-checkpoints.md §5 Decision 3).
//
// Sources:
//   - latest checkpoint(s)  — facts with key = CHECKPOINT_KEY, project-scoped
//   - recent decisions      — facts with key prefix "decision:" (the
//                             extractor's existing category convention,
//                             src/extract/index.ts's DECISION_PATTERNS)
//   - open items            — facts with key prefix "issue:" (the
//                             iranti_write_issue convention) whose JSON
//                             value's status is not resolved/wont_fix
//   - last activity         — MAX(updatedAt) across non-archived facts in
//                             the project's effective scope
//
// Escalations are deliberately NOT included (PRD §5 Decision 3): the
// escalations table has no project column and no project-scoped reader
// today: joining one in would be new isolation surface this phase does not
// need. Flagged as future work.
//
// Gap detection (PRD §5 Decision 4): `now` is injectable so tests can
// simulate "reopened after a long gap" without a real sleep — the same
// spirit as persistence.test.ts's module-reset restart simulation, applied
// to a logical clock instead of a physical restart.

import { db } from "../db/connection.js";
import { type Fact } from "../db/schema.js";
import { CHECKPOINT_KEY, readCheckpointStage } from "./checkpoints.js";
import { normalizeProjectId } from "./projects.js";

// Longer than a lunch break, shorter than a full day — a stated, overridable
// default (mirrors attend.ts's IRANTI_TOKEN_BUDGET pattern). Not a claim that
// 4 hours is scientifically the right gap; it's a documented, changeable one.
const GAP_THRESHOLD_MS_DEFAULT = 4 * 60 * 60 * 1000;

export function getGapThresholdMs(): number {
  const env = process.env["IRANTI_PROJECT_STATE_GAP_MS"];
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return GAP_THRESHOLD_MS_DEFAULT;
}

const RECENT_DECISIONS_LIMIT = 5;
const OPEN_ITEMS_LIMIT = 5;

// Per-field character cap: the rollup is attached to attend's response
// OUTSIDE the fitsBudget token accounting (review finding), so its text
// fields are clamped at the source to keep the whole payload
// write-scale-independent — a project with sprawling checkpoint prose or
// long decision values can never dwarf the budgeted rules+facts sections.
const PROJECT_STATE_FIELD_CAP = 300;

function clampField(text: string): string {
  return text.length <= PROJECT_STATE_FIELD_CAP
    ? text
    : `${text.slice(0, PROJECT_STATE_FIELD_CAP - 1)}…`;
}

export interface ProjectStateCheckpoint {
  entity: string;
  text: string;
  stage: string;
  status: string | null;
  updatedAt: string;
}

export interface ProjectStateDecision {
  entity: string;
  key: string;
  value: string;
  updatedAt: string;
}

export interface ProjectStateOpenItem {
  entity: string;
  key: string;
  title: string;
  status: string;
  priority: string;
  updatedAt: string;
}

export interface ProjectStateSummary {
  hasActivity: boolean;
  latestCheckpoint: ProjectStateCheckpoint | null;
  recentDecisions: ProjectStateDecision[];
  openItems: ProjectStateOpenItem[];
  lastActivityAt: string | null;
  gapMs: number | null;
  isLongGap: boolean;
}

function entityLabel(f: Pick<Fact, "entityType" | "entityId">): string {
  return `${f.entityType}/${f.entityId}`;
}

// Fetch the most recent live (non-archived) checkpoint fact in the project's
// effective scope. Unlike getActiveCheckpoint (which is entity-hint-scoped
// for attend()), this is project-WIDE — a rollup has no entity hints.
async function findLatestCheckpointInProject(
  tenantId: string,
  project: string | string[],
): Promise<Fact | undefined> {
  const ids = (Array.isArray(project) ? project : [project]).map(normalizeProjectId);
  const rows = await db.query.facts.findMany({
    where: (f, { and: andOp, eq: eqOp, inArray }) =>
      andOp(
        eqOp(f.tenantId, tenantId),
        ids.length === 1 ? eqOp(f.project, ids[0]!) : inArray(f.project, ids),
        eqOp(f.key, CHECKPOINT_KEY),
        eqOp(f.isArchived, false),
      ),
    // Secondary id tiebreaker: updatedAt alone leaves same-microsecond
    // writes SQL-order-unspecified — nondeterministic "latest" pick under
    // exact-timestamp ties (review finding; G1).
    orderBy: (f, { desc: descOp }) => [descOp(f.updatedAt), descOp(f.id)],
    limit: 1,
  });
  return rows[0];
}

async function findRecentByKeyPrefix(
  tenantId: string,
  project: string | string[],
  keyPrefix: string,
  limit: number,
): Promise<Fact[]> {
  const ids = (Array.isArray(project) ? project : [project]).map(normalizeProjectId);
  return db.query.facts.findMany({
    where: (f, { and: andOp, eq: eqOp, inArray, like }) =>
      andOp(
        eqOp(f.tenantId, tenantId),
        ids.length === 1 ? eqOp(f.project, ids[0]!) : inArray(f.project, ids),
        eqOp(f.isArchived, false),
        like(f.key, `${keyPrefix}%`),
      ),
    // Same deterministic tiebreaker as findLatestCheckpointInProject.
    orderBy: (f, { desc: descOp }) => [descOp(f.updatedAt), descOp(f.id)],
    limit,
  });
}

async function findMostRecentActivity(
  tenantId: string,
  project: string | string[],
): Promise<Fact | undefined> {
  const ids = (Array.isArray(project) ? project : [project]).map(normalizeProjectId);
  const rows = await db.query.facts.findMany({
    where: (f, { and: andOp, eq: eqOp, inArray }) =>
      andOp(
        eqOp(f.tenantId, tenantId),
        ids.length === 1 ? eqOp(f.project, ids[0]!) : inArray(f.project, ids),
        eqOp(f.isArchived, false),
      ),
    // Same deterministic tiebreaker as findLatestCheckpointInProject.
    orderBy: (f, { desc: descOp }) => [descOp(f.updatedAt), descOp(f.id)],
    limit: 1,
  });
  return rows[0];
}

// Parse an issue fact's JSON value (see write-issue.ts's shape). Never
// throws — a malformed/foreign value is skipped rather than crashing the
// rollup (facts are free-text at the storage layer; the issue JSON shape is
// a convention, not an enforced schema).
function parseIssueValue(
  value: string,
): { title: string; status: string; priority: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      "title" in parsed &&
      "status" in parsed &&
      "priority" in parsed
    ) {
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj["title"] === "string" &&
        typeof obj["status"] === "string" &&
        typeof obj["priority"] === "string"
      ) {
        return {
          title: obj["title"],
          status: obj["status"],
          priority: obj["priority"],
        };
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const CLOSED_ISSUE_STATUSES = new Set(["resolved", "wont_fix"]);

// The deterministic "where did we leave off?" rollup for one project.
// `now` is injectable (PRD Decision 4) — defaults to the real clock, but
// tests pass a fixed/future Date to simulate a long gap without sleeping.
export async function getProjectState(
  project: string | string[],
  opts: { tenantId?: string; now?: Date } = {},
): Promise<ProjectStateSummary> {
  const tenantId = opts.tenantId ?? "default";
  const now = opts.now ?? new Date();

  const [checkpointFact, decisionFacts, issueFacts, latestActivityFact] =
    await Promise.all([
      findLatestCheckpointInProject(tenantId, project),
      findRecentByKeyPrefix(tenantId, project, "decision:", RECENT_DECISIONS_LIMIT),
      // Over-fetch issues since some will be filtered out as closed; capped
      // generously (5x) rather than paginating — issue volume per project is
      // small at this scale (matches readRelevantFactsByEntity's over-fetch
      // pattern in facts.ts).
      findRecentByKeyPrefix(tenantId, project, "issue:", OPEN_ITEMS_LIMIT * 5),
      findMostRecentActivity(tenantId, project),
    ]);

  const latestCheckpoint: ProjectStateCheckpoint | null = checkpointFact
    ? {
        entity: entityLabel(checkpointFact),
        text: clampField(checkpointFact.value),
        ...(() => {
          const { stage, status } = readCheckpointStage(checkpointFact);
          return { stage, status };
        })(),
        updatedAt: checkpointFact.updatedAt.toISOString(),
      }
    : null;

  const recentDecisions: ProjectStateDecision[] = decisionFacts.map((f) => ({
    entity: entityLabel(f),
    key: f.key,
    value: clampField(f.value),
    updatedAt: f.updatedAt.toISOString(),
  }));

  const openItems: ProjectStateOpenItem[] = issueFacts
    .map((f) => {
      const parsed = parseIssueValue(f.value);
      if (!parsed) return undefined;
      if (CLOSED_ISSUE_STATUSES.has(parsed.status)) return undefined;
      const item: ProjectStateOpenItem = {
        entity: entityLabel(f),
        key: f.key,
        title: clampField(parsed.title),
        status: parsed.status,
        priority: parsed.priority,
        updatedAt: f.updatedAt.toISOString(),
      };
      return item;
    })
    .filter((x): x is ProjectStateOpenItem => x !== undefined)
    .slice(0, OPEN_ITEMS_LIMIT);

  const lastActivityAt = latestActivityFact
    ? latestActivityFact.updatedAt.toISOString()
    : null;

  const gapMs = latestActivityFact
    ? now.getTime() - latestActivityFact.updatedAt.getTime()
    : null;

  const hasActivity =
    checkpointFact !== undefined ||
    decisionFacts.length > 0 ||
    openItems.length > 0 ||
    latestActivityFact !== undefined;

  return {
    hasActivity,
    latestCheckpoint,
    recentDecisions,
    openItems,
    lastActivityAt,
    gapMs,
    isLongGap: gapMs !== null && gapMs > getGapThresholdMs(),
  };
}
