import { z } from 'zod'

/** Zod v4 requires `z.record(keySchema, valueSchema)`. */
export const recordSchema = z.record(z.string(), z.unknown())

/** Extract a stable error payload from a thrown ChorusCore error. */
export function toCoreError(err: unknown): { status: number; code: string; message: string } {
  const e = err as { statusCode?: number; code?: string; message?: string }
  return {
    status: e.statusCode || 500,
    code: e.code || 'CORE_ERROR',
    message: e.message || 'Core operation failed',
  }
}
