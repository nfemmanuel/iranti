// Layer 0h — rule & alias correctability surface.
//
// Two layers under test:
//   1. Library scoping: deactivateRule / listRulesForProject /
//      listAliasesForProject are project-boundary-checked — the unscoped
//      deactivateRule was the write-side twin of the Layer 0 F3 fact-UUID
//      leak, applied to rules.
//   2. The MCP tool handlers: the full check-6 deactivate leg the dogfood
//      eval could not run — write rule → fires on a relevant message →
//      deactivate via the tool → same message is silent — plus the honest
//      refusal contract (unknown / out-of-scope indistinguishable).

import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db/connection.js";
import {
  deactivateRule,
  getRulesForAttend,
  listRulesForProject,
  writeRule,
} from "../library/rules.js";
import { learnAlias, listAliasesForProject, resolveAlias } from "../library/aliases.js";
import { archiveFact, writeFact } from "../library/facts.js";
import { resolveCurrentProject } from "../library/projects.js";
import { rulesList, ruleDeactivate } from "../mcp/tools/rules.js";
import { aliasesList, aliasArchive } from "../mcp/tools/entity-aliases.js";
import { writeRuleTool } from "../mcp/tools/write-rule.js";

afterAll(async () => {
  await pool.end({ timeout: 5 });
});

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe("deactivateRule — Layer 0h project scoping", () => {
  it("refuses an out-of-scope rule id and leaves the rule active", async () => {
    const projectA = `proj-a-${randomUUID()}`;
    const entityId = randomUUID();
    const rule = await writeRule({
      entityType: "project",
      entityId,
      text: "always run the smoke suite before tagging a release",
      priority: 10,
      source: "test",
      project: projectA,
    });

    // Caller scoped to a DIFFERENT project: indistinguishable from unknown.
    expect(await deactivateRule(rule.id, "default", [`proj-b-${randomUUID()}`])).toBe(false);

    const stillActive = await listRulesForProject("default", projectA);
    expect(stillActive.some((r) => r.id === rule.id)).toBe(true);
  });

  it("deactivates in-scope, then refuses the second attempt (already inactive)", async () => {
    const projectA = `proj-a-${randomUUID()}`;
    const rule = await writeRule({
      entityType: "project",
      entityId: randomUUID(),
      text: "never push generated files to the main branch",
      priority: 10,
      source: "test",
      project: projectA,
    });

    expect(await deactivateRule(rule.id, "default", [projectA])).toBe(true);
    expect(await deactivateRule(rule.id, "default", [projectA])).toBe(false);

    const active = await listRulesForProject("default", projectA);
    expect(active.some((r) => r.id === rule.id)).toBe(false);
    // The row survives (never hard-deleted): visible with includeInactive.
    const all = await listRulesForProject("default", projectA, true);
    expect(all.some((r) => r.id === rule.id && !r.isActive)).toBe(true);
  });

  it("parity with archiveFact: both refuse out-of-scope ids the same way", async () => {
    const projectA = `proj-a-${randomUUID()}`;
    const otherScope = [`proj-b-${randomUUID()}`];
    const entityId = randomUUID();

    const rule = await writeRule({
      entityType: "project",
      entityId,
      text: "keep the changelog current",
      priority: 0,
      source: "test",
      project: projectA,
    });
    const fact = await writeFact({
      entityType: "project",
      entityId,
      key: "parity-probe",
      value: "a fact for the scoping parity check",
      source: "test",
      project: projectA,
    });

    // Same inputs, same refusal, on both mutation surfaces (PRD 0h D2).
    expect(await deactivateRule(rule.id, "default", otherScope)).toBe(false);
    expect(await archiveFact(fact.id, otherScope)).toBe(false);
    expect(await deactivateRule(rule.id, "default", [projectA])).toBe(true);
    expect(await archiveFact(fact.id, [projectA])).toBe(true);
  });
});

describe("listRulesForProject / listAliasesForProject — cross-project isolation", () => {
  it("a rule in project A never lists for project B", async () => {
    const projectA = `proj-a-${randomUUID()}`;
    const projectB = `proj-b-${randomUUID()}`;
    await writeRule({
      entityType: "project",
      entityId: randomUUID(),
      text: "a rule that must stay in its own project",
      priority: 0,
      source: "test",
      project: projectA,
    });

    expect(await listRulesForProject("default", projectB)).toHaveLength(0);
    expect((await listRulesForProject("default", projectA)).length).toBeGreaterThan(0);
  });

  it("an alias in project A never lists for project B", async () => {
    const projectA = `proj-a-${randomUUID()}`;
    const projectB = `proj-b-${randomUUID()}`;
    await learnAlias({
      entityType: "project",
      entityId: randomUUID(),
      rawAlias: "the isolation probe doc",
      factKey: "shared_url:abc123def456",
      source: "test",
      project: projectA,
    });

    expect(await listAliasesForProject("default", projectB)).toHaveLength(0);
    expect((await listAliasesForProject("default", projectA)).length).toBeGreaterThan(0);
  });
});

describe("iranti_rules_list / iranti_rule_deactivate — the check-6 deactivate leg", () => {
  it("write → fires on a relevant message → deactivate via the tool → same message is silent", async () => {
    const entityId = randomUUID();
    const currentProject = (await resolveCurrentProject()).id;

    const written = await writeRuleTool({
      entityType: "project",
      entityId,
      text: "always vacuum the telemetry table before archiving old spans",
      priority: 10,
    });

    // Fires: message shares tokens ("telemetry", "archiving") with the text.
    const triggerMessage = "planning to start archiving last month's telemetry spans today";
    const before = await getRulesForAttend(
      [{ entityType: "project", entityId }],
      "default",
      currentProject,
      triggerMessage,
    );
    expect(before.some((r) => r.id === written.ruleId)).toBe(true);

    // The tool lists it with its id, then deactivates it.
    const listed = await rulesList({});
    expect(listed.rules.some((r) => r.id === written.ruleId)).toBe(true);

    const result = await ruleDeactivate({ ruleId: written.ruleId });
    expect(result.deactivated).toBe(true);

    // Silent on the exact same trigger, and gone from the default list.
    const after = await getRulesForAttend(
      [{ entityType: "project", entityId }],
      "default",
      currentProject,
      triggerMessage,
    );
    expect(after.some((r) => r.id === written.ruleId)).toBe(false);
    expect((await rulesList({})).rules.some((r) => r.id === written.ruleId)).toBe(false);
    // Still auditable with includeInactive (never hard-deleted).
    expect(
      (await rulesList({ includeInactive: true })).rules.some(
        (r) => r.id === written.ruleId && !r.isActive,
      ),
    ).toBe(true);
  });

  it("honestly refuses an unknown rule id", async () => {
    const result = await ruleDeactivate({ ruleId: NIL_UUID });
    expect(result.deactivated).toBe(false);
    expect(result.reason).toContain("project scope");
  });
});

describe("iranti_aliases_list / iranti_alias_archive", () => {
  it("learn → list carries the id → archive → nickname no longer resolves", async () => {
    const entityId = randomUUID();
    const currentProject = (await resolveCurrentProject()).id;
    const learned = await learnAlias({
      entityType: "project",
      entityId,
      rawAlias: "the quarterly numbers sheet",
      factKey: "shared_url:0123456789ab",
      source: "test",
      project: currentProject,
    });

    const listed = await aliasesList({ entityType: "project", entityId });
    expect(listed.aliases.some((a) => a.id === learned.id)).toBe(true);

    const archived = await aliasArchive({ aliasId: learned.id });
    expect(archived.archived).toBe(true);

    expect(
      await resolveAlias(
        "project",
        entityId,
        "can you open the quarterly numbers sheet for me",
        "default",
        currentProject,
      ),
    ).toBeUndefined();
    expect(
      (await aliasesList({ entityType: "project", entityId })).aliases.some(
        (a) => a.id === learned.id,
      ),
    ).toBe(false);
  });

  it("honestly refuses an unknown alias id", async () => {
    const result = await aliasArchive({ aliasId: NIL_UUID });
    expect(result.archived).toBe(false);
    expect(result.reason).toContain("project scope");
  });
});
