/**
 * Per-request async context for Iranti's MCP/API server.
 *
 * Provides an AsyncLocalStorage store that flows through a single request's
 * call stack without threading it through every function signature.
 * Currently holds `llmCount` (LLM calls made within this request) and an
 * optional `requestId` for correlation.
 *
 * Key exports:
 *   - requestContext  — the AsyncLocalStorage instance; run() to bind a new store
 *   - getContext()    — read the current store, or null if called outside a request
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  llmCount: number;
  requestId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | null {
  return requestContext.getStore() ?? null;
}
