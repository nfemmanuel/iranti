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
check(
  "four tools registered",
  JSON.stringify(names) ===
    JSON.stringify(["iranti_archive", "iranti_attend", "iranti_write", "iranti_write_rule"]),
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

await client.close();
console.log(failures === 0 ? "\nSMOKE TEST PASSED" : `\nSMOKE TEST FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
