import { describe, it, expect, vi, beforeEach } from 'vitest'
import http, { extractApiError, setRouter } from '../src/lib/http'

/**
 * Units for the frontend API layer: extractApiError normalises every failure
 * shape views/stores rely on, and the response interceptor's 401 → login
 * redirect (with its auth-endpoint exemption) guards session-expiry UX.
 * The axios import is safe in the node environment — nothing touches the DOM.
 */
describe('extractApiError', () => {
  it('reads the flat { code, message } envelope', () => {
    const err = { response: { status: 422, data: { code: 'VALIDATION_ERROR', message: 'bad input' } } }
    expect(extractApiError(err)).toEqual({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'bad input',
    })
  })

  it('reads the nested { error: { code, message } } envelope', () => {
    const err = {
      response: {
        status: 401,
        data: { error: { code: 'wrong_password', message: 'Incorrect password' } },
      },
    }
    expect(extractApiError(err)).toEqual({
      status: 401,
      code: 'wrong_password',
      message: 'Incorrect password',
    })
  })

  it('maps axios timeout aborts to a human-readable hint', () => {
    const err = { code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' }
    const out = extractApiError(err)
    expect(out.code).toBe('REQUEST_TIMEOUT')
    expect(out.message).toContain('timed out')
    expect(out.message).toContain('settings')
  })

  it('passes through non-timeout network errors', () => {
    const err = { code: 'ERR_NETWORK', message: 'Network Error' }
    expect(extractApiError(err)).toMatchObject({ code: 'ERR_NETWORK', message: 'Network Error' })
  })

  it('falls back for unrecognised throwables', () => {
    expect(extractApiError(undefined)).toEqual({ code: undefined, message: 'Request failed' })
    expect(extractApiError(new Error('boom'))).toMatchObject({ code: undefined, message: 'boom' })
    expect(extractApiError(null, 'custom')).toMatchObject({ message: 'custom' })
  })
})

describe('401 redirect interceptor', () => {
  const handlers = (http.interceptors.response as unknown as {
    handlers: Array<{ fulfilled: (v: unknown) => unknown; rejected: (e: unknown) => Promise<unknown> }>
  }).handlers
  const rejected = handlers[0].rejected

  let push: ReturnType<typeof vi.fn>

  beforeEach(() => {
    push = vi.fn()
    setRouter({ push } as never)
  })

  it('redirects to login on a 401 from a protected endpoint', async () => {
    const err = { config: { url: '/core/configs' }, response: { status: 401 } }
    await expect(rejected(err)).rejects.toBe(err)
    expect(push).toHaveBeenCalledWith({ name: 'login' })
  })

  it('does not redirect on auth endpoints (wrong-password stays visible)', async () => {
    const err = { config: { url: '/auth/login' }, response: { status: 401 } }
    await expect(rejected(err)).rejects.toBe(err)
    expect(push).not.toHaveBeenCalled()
  })

  it('does not redirect for non-401 failures', async () => {
    const err = { config: { url: '/core/configs' }, response: { status: 503 } }
    await expect(rejected(err)).rejects.toBe(err)
    expect(push).not.toHaveBeenCalled()
  })

  it('no-ops safely when no router is installed', async () => {
    setRouter(null as never)
    const err = { config: { url: '/core/configs' }, response: { status: 401 } }
    await expect(rejected(err)).rejects.toBe(err)
  })
})
