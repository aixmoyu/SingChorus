import type { ZodError } from 'zod'

/** Normalised API error payload shared by the error handler and routes. */
export interface ApiErrorPayload {
  code: string
  message: string
  details?: unknown
}

/**
 * Wrap a value into the standard `{ error: { code, message } }` envelope.
 * Routes use this to keep error shapes consistent without re-implementing
 * the wrapper every time.
 */
export function toErrorEnvelope(code: string, message: string, details?: unknown) {
  const body: { error: ApiErrorPayload } = { error: { code, message } }
  if (details !== undefined) (body.error as ApiErrorPayload).details = details
  return body
}

/**
 * Render a Zod validation error as a single human-readable message, e.g.
 * `"name: String must contain at least 1 character(s)"` — far friendlier than
 * the raw `JSON.stringify` blob zod puts in `.message`.
 */
export function toValidationError(error: ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'Validation failed'
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}
