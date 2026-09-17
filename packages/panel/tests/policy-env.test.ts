import { describe, it, expect, afterEach } from 'vitest'
import { z } from 'zod'
import { validatePasswordPolicy } from '../server/auth.js'
import { toErrorEnvelope, toValidationError } from '../server/api-error.js'
import { getTrustProxy, getAllowedCorsOrigins, resolveCorsOrigin } from '../server/env.js'

/**
 * Pure-function units with zero I/O: password policy, env-derived CORS /
 * trust-proxy resolution, and the error-envelope helpers shared by every
 * route. These pin the exact codes/messages the UI matches against.
 */
describe('auth: validatePasswordPolicy', () => {
  it('accepts a password with 3+ character classes', () => {
    expect(validatePasswordPolicy('Sup3r$ecret9')).toBeNull()
    expect(validatePasswordPolicy('Abcdefg1')).toBeNull() // upper + lower + digit
    expect(validatePasswordPolicy('abcdefg1!')).toBeNull() // lower + digit + symbol
  })

  it('rejects passwords shorter than 8 chars', () => {
    expect(validatePasswordPolicy('Ab1!')?.code).toBe('PASSWORD_TOO_SHORT')
    expect(validatePasswordPolicy('')?.code).toBe('PASSWORD_TOO_SHORT')
  })

  it('rejects passwords with fewer than 3 character classes', () => {
    expect(validatePasswordPolicy('onlylowercase')?.code).toBe('PASSWORD_TOO_WEAK')
    expect(validatePasswordPolicy('1234567890')?.code).toBe('PASSWORD_TOO_WEAK')
    expect(validatePasswordPolicy('LOWERCASE123')?.code).toBe('PASSWORD_TOO_WEAK')
  })
})

describe('api-error: toErrorEnvelope / toValidationError', () => {
  it('wraps code + message', () => {
    expect(toErrorEnvelope('NOPE', 'it broke')).toEqual({
      error: { code: 'NOPE', message: 'it broke' },
    })
  })

  it('attaches details only when provided', () => {
    const withDetails = toErrorEnvelope('NOPE', 'm', { foo: 1 })
    expect(withDetails.error).toHaveProperty('details', { foo: 1 })
    expect(toErrorEnvelope('NOPE', 'm').error).not.toHaveProperty('details')
  })

  it('renders a zod error as "path: message"', () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 5 })
    expect(toValidationError(parsed.error!)).toMatch(/^name: /)
    const bare = z.string().safeParse(5)
    // No path segments → the message is returned unprefixed.
    expect(toValidationError(bare.error!)).toBe(bare.error!.issues[0].message)
  })
})

describe('env: trust proxy + CORS resolution', () => {
  const ORIGINAL = { ...process.env }

  afterEach(() => {
    process.env.CHORUS_PANEL_TRUST_PROXY = ORIGINAL.CHORUS_PANEL_TRUST_PROXY
    process.env.CHORUS_PANEL_CORS_ORIGIN = ORIGINAL.CHORUS_PANEL_CORS_ORIGIN
  })

  it('trusts no proxy by default and passes raw values through', () => {
    delete process.env.CHORUS_PANEL_TRUST_PROXY
    expect(getTrustProxy()).toBe(false)
    process.env.CHORUS_PANEL_TRUST_PROXY = 'true'
    expect(getTrustProxy()).toBe(true)
    process.env.CHORUS_PANEL_TRUST_PROXY = 'false'
    expect(getTrustProxy()).toBe(false)
    process.env.CHORUS_PANEL_TRUST_PROXY = '10.0.0.1,172.16.0.0/12'
    expect(getTrustProxy()).toBe('10.0.0.1,172.16.0.0/12')
  })

  it('reflects all origins in dev when no allow-list is set', () => {
    delete process.env.CHORUS_PANEL_CORS_ORIGIN
    expect(getAllowedCorsOrigins()).toBe(true)
    expect(resolveCorsOrigin('https://anything.example')).toBe(true)
  })

  it('parses the allow-list and matches origins exactly', () => {
    process.env.CHORUS_PANEL_CORS_ORIGIN = 'https://a.example, https://b.example'
    expect(getAllowedCorsOrigins()).toEqual(['https://a.example', 'https://b.example'])
    expect(resolveCorsOrigin('https://a.example')).toBe('https://a.example')
    expect(resolveCorsOrigin('https://evil.example')).toBe(false)
    expect(resolveCorsOrigin(undefined)).toBe(true)
  })
})
