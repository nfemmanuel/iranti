# iranti benchmarking PRD

**Status:** template  
**[Back to map](../MAP.md)**

---

> This is a placeholder. Design begins when iranti-core is done enough.

## Overview

An evaluation and benchmarking suite for iranti. Covers recall quality measurement, latency benchmarks, cost-per-session baselines, and regression detection.

## What we know so far

- iranti-core is the priority. Benchmarking comes after.
- Direct measurement of successful recall is not possible without reading session content, which is not allowed. Benchmark design must use behavioural proxies.
- The proxies defined in [iranti-core PRD §11](../rough-notes/iranti-core-prd.md#11-metrics-and-observability) are the starting point:
  - **Disconnect rate** — primary signal that recall is or is not providing value
  - **Correction-to-injection ratio** — proxy for write path health
  - **Short sessions on existing projects** — proxy for successful context retrieval

## The core challenge

How do you benchmark a memory system without reading the content it stores?

This is the central unsolved question. The benchmarking suite needs a principled answer before it can be built.

## Open questions

- Can a synthetic session environment be constructed that allows content reading for benchmark purposes only?
- Which latency measurements matter most — Attendant response time, Librarian write latency, or end-to-end session completion?
- How do we detect regressions in recall quality between iranti versions?

## Prerequisites before writing this PRD

- iranti-core done enough
- Real usage data to understand what good vs. bad performance looks like

---

_Fill this out when iranti-core is in real use and there is baseline data to measure against._
