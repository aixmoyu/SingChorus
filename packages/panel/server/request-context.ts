/**
 * Per-request context via AsyncLocalStorage.
 *
 * The pino-http middleware generates the request id and stores it here; deep
 * layers (core-provider → ChorusCore → CloudClient) read it through
 * `currentRequestId()` to forward `X-Request-ID` to the cloud, so one ID
 * traces panel logs → cloud logs (Workers Logs / docker logs) end to end.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface RequestContext {
  requestId: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId
}
