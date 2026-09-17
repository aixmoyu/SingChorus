import axios from 'axios'
import type { Router } from 'vue-router'

let _router: Router | null = null

export function setRouter(router: Router) {
  _router = router
}

const http = axios.create({
  baseURL: '/api',
  withCredentials: true,
  // No global Content-Type here: forcing it makes axios serialise even a
  // `null` body into the literal string "null", which express.json (strict
  // mode) rejects with a 400 — "JSON Parse error: Unrecognized token 'n'".
  // Axios sets the JSON content-type automatically for object payloads.
  // Guard against hung requests; long-running endpoints override this.
  // core-D2 coupling: this 30s must stay ABOVE @chorus/core's
  // REQUEST_BUDGET_MS (25s, exported from @chorus/core) so an unreachable
  // cloud surfaces as a structured error envelope, never as this timeout.
  timeout: 30_000,
})

http.interceptors.response.use(
  (r) => r,
  (err) => {
    // Redirect to login on 401 — except for the auth endpoints themselves,
    // where a 401 is an expected, user-visible outcome (wrong password,
    // lockout) and a redirect would just mask the error message.
    const url: string = err.config?.url || ''
    const isAuthEndpoint = url.startsWith('/auth/')
    if (err.response?.status === 401 && !isAuthEndpoint && _router) {
      _router.push({ name: 'login' })
    }
    return Promise.reject(err)
  },
)

/** Standardised error payload returned by all `catch` sites in views/stores. */
export interface ApiError {
  status?: number
  code?: string
  message: string
}

/**
 * Normalise an unknown thrown value (typically an axios error) into a stable
 * `ApiError`. Accepts both the server's `{ code, message }` envelope and the
 * nested `{ error: { code, message } }` shape used by some legacy endpoints.
 */
export function extractApiError(e: unknown, fallback = 'Request failed'): ApiError {
  const err = e as {
    response?: {
      status?: number
      data?: {
        code?: string
        message?: string
        error?: { code?: string; message?: string }
      }
    }
    code?: string
    message?: string
  }
  const data = err?.response?.data
  // Axios aborts hung requests with ECONNABORTED — surface a human-readable
  // hint instead of the raw "timeout of 30000ms exceeded". Common causes:
  // cloud-side 5xx being retried by core, or a genuinely unreachable cloud.
  if (!data && err?.code === 'ECONNABORTED' && /timeout/i.test(err?.message || '')) {
    return { code: 'REQUEST_TIMEOUT', message: 'The request timed out. Check the panel server logs for the upstream error (cloud status / error code), and verify the cloud address in settings.' }
  }
  return {
    status: err?.response?.status,
    code: data?.code || data?.error?.code || err?.code,
    message: data?.message || data?.error?.message || err?.message || fallback,
  }
}

export default http