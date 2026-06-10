// End-to-end smoke test for the iranti MCP server.
//
// Spawns dist/mcp/server.js as a real child process and talks to it over
// stdio JSON-RPC — exactly what Claude Desktop does. Verifies the full
// Phase 1 loop: tools list → bidirectional attend → explicit write →
// rule injection → checkpoint → archive.
//
// Usage: pnpm build && node scripts/smoke-mcp.mjs

import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "crypto";

const projectId = `smoke-${randomUUID()}`;
let failures = 0;

function check(name, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

const client = new Client({ name: "smoke-test", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/mcp/server.js"],
  env: { ...process.env, IRANTI_AGENT_NAME: "smoke-test-host" },
});

await client.connect(transport);
console.log("connected to iranti MCP server over stdio\n");

// 1. Tools list
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expectedTools = [
  "iranti_archive",
  "iranti_attend",
  "iranti_checkpoint",
  "iranti_history",
  "iranti_query",
  "iranti_search",
  "iranti_write",
  "iranti_write_issue",
  "iranti_write_rule",
];
check(
  "nine tools registered",
  JSON.stringify(names) === JSON.stringify(expectedTools),
  names.join(", "),
);

// 2. Bidirectional attend: message with a URL should store it
const hints = { entityHints: [{ entityType: "project", entityId: projectId }] };
const attend1 = parse(
  await client.callTool({
    name: "iranti_attend",
    arguments: {
      ...hints,
      message: "the spec lives at https://example.com/spec and in ./docs/spec.md",
      surface: "dev_cli",
    },
  }),
);
check(
  "attend extracted URL + file path",
  attend1.extracted.length === 2,
  attend1.extracted.map((e) => e.value).join(", "),
);

// 3. Rule write
await client.callTool({
  name: "iranti_write_rule",
  arguments: {
    entityType: "project",
    entityId: projectId,
    text: "Smoke-test rule: always be testing.",
    priority: 99,
  },
});

// 4. Explicit fact write + checkpoint
await client.callTool({
  name: "iranti_write",
  arguments: {
    entityType: "project",
    entityId: projectId,
    key: "smoke_status",
    value: "running",
    surface: "dev_cli",
  },
});
await client.callTool({
  name: "iranti_write",
  arguments: {
    entityType: "project",
    entityId: projectId,
    key: "checkpoint",
    value: "smoke test reached step 4",
  },
});

// 5. Second attend: everything written must come back
const attend2 = parse(
  await client.callTool({ name: "iranti_attend", arguments: hints }),
);
check(
  "attend returns extracted URL fact",
  attend2.facts.some((f) => f.value === "https://example.com/spec"),
);
check(
  "attend returns explicit fact",
  attend2.facts.some((f) => f.key === "smoke_status" && f.value === "running"),
);
check(
  "attend returns the rule",
  attend2.rules.some((r) => r.text.includes("always be testing")),
);
check(
  "attend returns checkpoint separately",
  attend2.checkpoint?.text === "smoke test reached step 4" &&
    attend2.facts.every((f) => f.key !== "checkpoint"),
);

// 6. Archive by entity + key, verify it disappears
const archived = parse(
  await client.callTool({
    name: "iranti_archive",
    arguments: { entityType: "project", entityId: projectId, key: "smoke_status" },
  }),
);
check("archive succeeds", archived.archived === true);

const attend3 = parse(
  await client.callTool({ name: "iranti_attend", arguments: hints }),
);
check(
  "archived fact no longer returned",
  !attend3.facts.some((f) => f.key === "smoke_status"),
);

// 7. Invalid surface must be rejected
const bad = await client.callTool({
  name: "iranti_attend",
  arguments: { ...hints, message: "x", surface: "myspace" },
});
check("invalid surface rejected", bad.isError === true || /invalid/i.test(bad.content?.[0]?.text ?? ""));

// 8. iranti_search finds the explicit fact we wrote
const searched = parse(
  await client.callTool({
    name: "iranti_search",
    arguments: { query: "smoke", entityType: "project", entityId: projectId },
  }),
);
check(
  "search finds facts by keyword",
  searched.results.some((r) => r.key === "smoke_status" || r.value?.includes("smoke")),
  `count=${searched.count}`,
);

// 9. iranti_checkpoint — dedicated tool
const cp = parse(
  await client.callTool({
    name: "iranti_checkpoint",
    arguments: {
      entityType: "project",
      entityId: projectId,
      text: "smoke test checkpoint via dedicated tool",
    },
  }),
);
check("checkpoint tool returns factId", typeof cp.factId === "string" && cp.factId.length > 0);

const attend4 = parse(
  await client.callTool({ name: "iranti_attend", arguments: hints }),
);
check(
  "dedicated checkpoint returned by attend",
  attend4.checkpoint?.text === "smoke test checkpoint via dedicated tool",
);

// 10. iranti_history — shows prior values
await client.callTool({
  name: "iranti_write",
  arguments: { entityType: "project", entityId: projectId, key: "smoke_v", value: "v1" },
});
await client.callTool({
  name: "iranti_write",
  arguments: { entityType: "project", entityId: projectId, key: "smoke_v", value: "v2" },
});
const hist = parse(
  await client.callTool({
    name: "iranti_history",
    arguments: { entityType: "project", entityId: projectId, key: "smoke_v" },
  }),
);
check(
  "history returns current value and prior version",
  hist.found && hist.current?.value === "v2" && hist.history.some((h) => h.value === "v1"),
  `current=${hist.current?.value} history=${hist.history.length}`,
);

// 11. iranti_query — exact lookup
const q = parse(
  await client.callTool({
    name: "iranti_query",
    arguments: { entityType: "project", entityId: projectId, key: "smoke_v" },
  }),
);
check("query returns exact fact", q.found && q.fact?.value === "v2");

// 12. iranti_write_issue — structured issue storage
const issue = parse(
  await client.callTool({
    name: "iranti_write_issue",
    arguments: {
      entityType: "project",
      entityId: projectId,
      title: "Smoke test issue",
      status: "open",
      priority: "low",
    },
  }),
);
check(
  "write_issue returns key and status",
  issue.key === "issue:smoke-test-issue" && issue.status === "open",
  `key=${issue.key}`,
);

// 12b. Upsert same issue with resolved status
const issueUpdated = parse(
  await client.callTool({
    name: "iranti_write_issue",
    arguments: {
      entityType: "project",
      entityId: projectId,
      title: "Smoke test issue",
      status: "resolved",
      priority: "low",
    },
  }),
);
check("write_issue upserts by title", issueUpdated.status === "resolved");

// 13. Context window observation — a fact already in currentContext is suppressed
await client.callTool({
  name: "iranti_write",
  arguments: {
    entityType: "project",
    entityId: projectId,
    key: "window_fact",
    value: "the smoke deployment target is fly.io ord region",
    surface: "dev_cli",
  },
});
const observed = parse(
  await client.callTool({
    name: "iranti_attend",
    arguments: {
      ...hints,
      currentContext:
        "Context recap: the smoke deployment target is fly.io ord region, noted.",
    },
  }),
);
check(
  "context window observation suppresses already-present fact",
  observed.alreadyPresent >= 1 &&
    !observed.facts.some((f) => f.key === "window_fact"),
  `alreadyPresent=${observed.alreadyPresent}`,
);

// 14. Phase 2a — edge recording in effect: two attends that return the same
// facts should not break anything (the async recording is best-effort).
// We can't inspect the graph via MCP yet (that's Phase 3), so we just verify
// the server is still healthy and returns the expected facts.
const edgeEntityId = `smoke-edge-${randomUUID()}`;
const edgeHints = { entityHints: [{ entityType: "project", entityId: edgeEntityId }] };
await client.callTool({
  name: "iranti_write",
  arguments: { entityType: "project", entityId: edgeEntityId, key: "edge_fact_a", value: "alpha edge value" },
});
await client.callTool({
  name: "iranti_write",
  arguments: { entityType: "project", entityId: edgeEntityId, key: "edge_fact_b", value: "beta edge value" },
});
// Two attends — co_access edges form async in background.
const edgeAttend1 = parse(await client.callTool({ name: "iranti_attend", arguments: edgeHints }));
const edgeAttend2 = parse(await client.callTool({ name: "iranti_attend", arguments: edgeHints }));
check(
  "edge recording does not break attend (two attends return facts)",
  edgeAttend1.facts.length >= 2 && edgeAttend2.facts.length >= 2,
  `attend1=${edgeAttend1.facts.length} attend2=${edgeAttend2.facts.length} facts`,
);

// 15. Phase 2a — write safety: update a value twice; history must exist.
const safetyId = `smoke-safety-${randomUUID()}`;
await client.callTool({
  name: "iranti_write",
  arguments: { entityType: "project", entityId: safetyId, key: "safety_key", value: "initial" },
});
await client.callTool({
  name: "iranti_write",
  arguments: { entityType: "project", entityId: safetyId, key: "safety_key", value: "updated" },
});
const safetyHist = parse(
  await client.callTool({
    name: "iranti_history",
    arguments: { entityType: "project", entityId: safetyId, key: "safety_key" },
  }),
);
check(
  "write safety: value update produces history (advisory lock in place)",
  safetyHist.found && safetyHist.current?.value === "updated" && safetyHist.history.some((h) => h.value === "initial"),
  `current=${safetyHist.current?.value} history=${safetyHist.history.length}`,
);

// 16. Phase 2b — semantic extraction: decision marker → fact on next attend
const extractId = `smoke-extract-${randomUUID()}`;
const extractHints = { entityHints: [{ entityType: "project", entityId: extractId }] };
await client.callTool({
  name: "iranti_attend",
  arguments: {
    ...extractHints,
    message: "we decided to use Vitest as the test runner for this project",
  },
});
// Allow async extraction to flush.
await new Promise((r) => setTimeout(r, 600));
const extractAttend = parse(
  await client.callTool({ name: "iranti_attend", arguments: extractHints }),
);
const extractedFact = extractAttend.facts.find(
  (f) => f.key.startsWith("decision:") && f.value.toLowerCase().includes("vitest"),
);
check(
  "semantic extraction: decision surfaces on next attend",
  Boolean(extractedFact),
  extractedFact ? `key=${extractedFact.key}` : "no matching fact found",
);

// 17. Phase 2b — conflict detection: escalation blocks low-reliability write
// We can't boost reliability scores through MCP directly, so we verify the
// basic supersede path works (equal scores → new value wins). The escalation
// path is covered in vitest integration tests.
const conflictId = `smoke-conflict-${randomUUID()}`;
await client.callTool({
  name: "iranti_write",
  arguments: { entityType: "project", entityId: conflictId, key: "runtime", value: "node", source: "test" },
});
await client.callTool({
  name: "iranti_write",
  arguments: { entityType: "project", entityId: conflictId, key: "runtime", value: "bun", source: "test" },
});
const conflictQ = parse(
  await client.callTool({
    name: "iranti_query",
    arguments: { entityType: "project", entityId: conflictId, key: "runtime" },
  }),
);
check(
  "conflict detection: equal-reliability supersede — new value wins",
  conflictQ.found && conflictQ.fact?.value === "bun",
  `value=${conflictQ.fact?.value}`,
);

await client.close();
console.log(failures === 0 ? "\nSMOKE TEST PASSED" : `\nSMOKE TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
