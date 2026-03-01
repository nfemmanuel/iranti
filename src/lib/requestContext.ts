import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  llmCount: number;
  requestId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getContext(): RequestContext | null {
  return requestContext.getStore() ?? null;
}
