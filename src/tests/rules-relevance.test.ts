// Unit tests — situational relevance (Layer 0d).
//
// Pure-function tests against scoreRuleRelevance / isRuleSituationallyRelevant
// (no DB round-trip — see rules.test.ts / mcp-tools.test.ts for the
// integration-level getRulesForAttend(message) coverage).

import { describe, expect, it } from "vitest";
import {
  CRITICAL_RULE_PRIORITY,
  isRuleSituationallyRelevant,
  scoreRuleRelevance,
} from "../library/rules.js";
import { tokenizeMessage } from "../library/facts.js";

describe("scoreRuleRelevance", () => {
  it("scores 0 for an empty token list", () => {
    expect(scoreRuleRelevance({ text: "never use SELECT * in reports" }, [])).toBe(0);
  });

  it("scores > 0 when the message shares a keyword with the rule text", () => {
    const tokens = tokenizeMessage("Can I use SELECT * to pull the reporting numbers?");
    const score = scoreRuleRelevance(
      { text: "Never use SELECT * in the reporting queries." },
      tokens,
    );
    expect(score).toBeGreaterThan(0);
  });

  it("scores 0 when the message shares no keyword with the rule text", () => {
    const tokens = tokenizeMessage("What's our Redis eviction policy?");
    const score = scoreRuleRelevance(
      { text: "Never use SELECT * in the reporting queries." },
      tokens,
    );
    expect(score).toBe(0);
  });

  it("is case-insensitive", () => {
    const tokens = tokenizeMessage("ARIA labels matter for icon buttons");
    const score = scoreRuleRelevance(
      { text: "always add an aria-label to icon-only buttons" },
      tokens,
    );
    expect(score).toBeGreaterThan(0);
  });
});

describe("isRuleSituationallyRelevant", () => {
  it("returns true for a critical-priority rule regardless of token overlap", () => {
    const tokens = tokenizeMessage("what's the weather like today");
    const rule = { text: "never mention competitor X", priority: CRITICAL_RULE_PRIORITY };
    expect(isRuleSituationallyRelevant(rule, tokens)).toBe(true);
  });

  it("returns true for a priority just above the critical floor", () => {
    const tokens = tokenizeMessage("totally unrelated message");
    const rule = { text: "always respond formally", priority: CRITICAL_RULE_PRIORITY + 50 };
    expect(isRuleSituationallyRelevant(rule, tokens)).toBe(true);
  });

  it("returns false for a sub-critical rule with zero token overlap", () => {
    const tokens = tokenizeMessage("what's our Redis eviction policy?");
    const rule = { text: "never use SELECT * in the reporting queries", priority: 10 };
    expect(isRuleSituationallyRelevant(rule, tokens)).toBe(false);
  });

  it("returns true for a sub-critical rule with token overlap", () => {
    const tokens = tokenizeMessage("should I write a SELECT * query for the report?");
    const rule = { text: "never use SELECT * in the reporting queries", priority: 10 };
    expect(isRuleSituationallyRelevant(rule, tokens)).toBe(true);
  });

  it("returns true for the default priority (0) when tokens overlap", () => {
    const tokens = tokenizeMessage("building an icon-only button, what's needed?");
    const rule = { text: "always add an aria-label to icon-only buttons", priority: 0 };
    expect(isRuleSituationallyRelevant(rule, tokens)).toBe(true);
  });

  it("returns false for the default priority (0) with no overlap", () => {
    const tokens = tokenizeMessage("what color should the button be?");
    const rule = { text: "always add an aria-label to icon-only buttons", priority: 0 };
    expect(isRuleSituationallyRelevant(rule, tokens)).toBe(false);
  });
});

// RULE-1 (backlog): digit-bearing 2-char tokens (S3, R2) survive the
// tokenizer's length floor, so a rule authored around a short identifier
// can match on exactly that identifier. The reviewer's production example.
describe("short-identifier tokens (RULE-1)", () => {
  it("a rule about S3 fires on a message that only shares the token 's3'", () => {
    const rule = {
      text: "always use presigned URLs for S3, never public buckets",
      priority: 0,
    };
    // No other content overlap — "s3" carries the match alone.
    const tokens = tokenizeMessage("should this go straight into S3?");
    expect(tokens).toContain("s3");
    expect(isRuleSituationallyRelevant(rule, tokens)).toBe(true);
  });

  it("case-insensitive: lowercase 's3' in the message matches too", () => {
    const rule = { text: "always use presigned URLs for S3", priority: 0 };
    const tokens = tokenizeMessage("putting the exports in s3 tonight");
    expect(isRuleSituationallyRelevant(rule, tokens)).toBe(true);
  });

  it("pure-alpha 2-char tokens are still dropped (documented RULE-1 residual)", () => {
    // "pr" must NOT be admitted — admitting pure-alpha 2-char tokens would
    // admit every un-stopworded preposition ('is', 'to', 'on', ...).
    const tokens = tokenizeMessage("opening a pr for it now");
    expect(tokens).not.toContain("pr");
    expect(tokens).not.toContain("it");
  });
});
