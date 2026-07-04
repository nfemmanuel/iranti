// Unit tests — src/library/volatility.ts (AX-7)
//
// Pure classifier, no DB. Every pattern class ships with a fire fixture AND
// a near-miss fixture that must NOT fire (PRD acceptance criterion) —
// precision over recall: an uncaught volatile fact is the status quo, a
// wrongly-suppressed durable fact is a NEW harm this gate must not
// introduce.

import { describe, expect, it } from "vitest";
import { classifyVolatility } from "../library/volatility.js";

describe("classifyVolatility — key-shape patterns", () => {
  describe("status-key", () => {
    it("fires on a trailing _status segment", () => {
      expect(classifyVolatility("typecheck_status", "clean").volatile).toBe(true);
    });
    it("fires on a trailing -status segment", () => {
      expect(classifyVolatility("build-status", "passing").volatile).toBe(true);
    });
    it("fires on the bare key 'status'", () => {
      expect(classifyVolatility("status", "green").volatile).toBe(true);
    });
    it("near-miss: does NOT fire when 'status' is not a trailing segment", () => {
      // "status_report" — status is a LEADING segment, not trailing; this
      // classifier's key-shape is deliberately anchored to the tail.
      expect(classifyVolatility("status_report", "weekly summary").volatile).toBe(false);
    });
  });

  describe("runtime-noun-key", () => {
    it("fires on the bare key 'port'", () => {
      expect(classifyVolatility("port", "3000").volatile).toBe(true);
    });
    it("fires on a trailing _port segment", () => {
      expect(classifyVolatility("server_port", "8080").volatile).toBe(true);
    });
    it("fires on a trailing -pid segment", () => {
      expect(classifyVolatility("worker-pid", "12345").volatile).toBe(true);
    });
    it("fires on a trailing _running segment", () => {
      expect(classifyVolatility("is_running", "true").volatile).toBe(true);
    });
    it("near-miss: does NOT fire on a word merely containing 'port' as a substring", () => {
      expect(classifyVolatility("reported", "something happened").volatile).toBe(false);
      expect(classifyVolatility("export_path", "./scripts/sync").volatile).toBe(false);
    });
  });

  describe("currently-key", () => {
    it("fires on a currently- prefix", () => {
      expect(classifyVolatility("currently-on-branch", "feat/x").volatile).toBe(true);
    });
    it("fires on a currently_ prefix", () => {
      expect(classifyVolatility("currently_deployed_sha", "abc123").volatile).toBe(true);
    });
    it("near-miss: does NOT fire when 'currently' appears in the VALUE, not as a key prefix", () => {
      expect(classifyVolatility("tech_stack", "currently using postgres").volatile).toBe(false);
    });
  });
});

describe("classifyVolatility — value-shape patterns", () => {
  describe("port-runtime-value", () => {
    it("fires on 'X is running on port N'", () => {
      expect(
        classifyVolatility("dev_server", "the server is running on port 3000").volatile,
      ).toBe(true);
    });
    it("fires on 'listening on port N'", () => {
      expect(
        classifyVolatility("service_note", "the API is listening on port 8080").volatile,
      ).toBe(true);
    });
    it("MUST NOT FIRE: 'port N is the default for the dev server' (durable config fact)", () => {
      // PRD acceptance criterion, verbatim example.
      expect(
        classifyVolatility(
          "dev_server_default",
          "port 3000 is the default for the dev server",
        ).volatile,
      ).toBe(false);
    });
    it("near-miss: a bare port number with no runtime verb does not fire", () => {
      expect(
        classifyVolatility("staging_config", "use port 5432 for the staging replica").volatile,
      ).toBe(false);
    });
  });

  describe("runtime-state-predicate", () => {
    it("fires on 'the build is passing'", () => {
      expect(classifyVolatility("build", "the build is passing").volatile).toBe(true);
    });
    it("fires on 'tests are green right now'", () => {
      expect(classifyVolatility("tests", "tests are green right now").volatile).toBe(true);
    });
    it("fires on 'CI is currently running'", () => {
      expect(classifyVolatility("ci", "CI is currently running").volatile).toBe(true);
    });
    it("near-miss: a durable claim about test behavior does not fire", () => {
      expect(
        classifyVolatility("tests", "all tests pass reliably once the DB is seeded").volatile,
      ).toBe(false);
    });
  });

  describe("current-branch-value", () => {
    it("fires on 'we are currently on branch X'", () => {
      expect(
        classifyVolatility("branch", "we are currently on branch feat/x").volatile,
      ).toBe(true);
    });
    it("fires on 'on branch X' without 'currently'", () => {
      expect(classifyVolatility("branch", "on branch main").volatile).toBe(true);
    });
    it("near-miss: prose merely discussing branch naming does not fire", () => {
      expect(
        classifyVolatility("project_notes", "we discussed branch naming conventions").volatile,
      ).toBe(false);
    });
  });
});

describe("classifyVolatility — write-issue JSON-value must-not-fire (PRD review finding)", () => {
  it("does NOT fire on write-issue's JSON value shape containing an embedded 'status' field", () => {
    // src/mcp/tools/write-issue.ts stores its value as a JSON string like
    // {"title":"...","status":"open","priority":"medium"}. This is the one
    // real durable "status" in the codebase (an issue's lifecycle state,
    // not a build/CI snapshot) — the gate must not suppress it.
    const value = JSON.stringify({
      title: "fix flaky test",
      description: null,
      status: "open",
      priority: "medium",
    });
    expect(classifyVolatility("issue:fix-flaky-test", value).volatile).toBe(false);
  });

  it("does NOT fire on a JSON value even when the key itself is not issue-shaped", () => {
    const value = JSON.stringify({ status: "in_progress" });
    expect(classifyVolatility("some-arbitrary-key", value).volatile).toBe(false);
  });
});

describe("classifyVolatility — ordinary durable facts (sanity: gate stays quiet)", () => {
  it("does not fire on a timezone fact", () => {
    expect(classifyVolatility("timezone", "UTC+1").volatile).toBe(false);
  });
  it("does not fire on a tech-stack decision fact", () => {
    expect(
      classifyVolatility("decision:tech-stack", "PostgreSQL 16 with Drizzle").volatile,
    ).toBe(false);
  });
});
