/**
 * Environment helpers for the panel server.
 *
 * Centralises feature detection (Node version, runtime, NODE_ENV) so that
 * security-sensitive code paths (cookie flags, CORS, etc.) can branch on a
 * single source of truth instead of re-deriving it in every module.
 */

export const isProduction: boolean = process.env.NODE_ENV === 'production'

export const isBunRuntime: boolean =
  typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/** Result of resolving the CORS allow-list. */
export type CorsAllowList = true | false | string[]

/**
 * Comma-separated list of allowed CORS origins for production.
 * Falls back to a permissive `true` (reflect origin) when unset so that the
 * local dev workflow keeps working without extra configuration.
 *
 * In production this MUST be set to a concrete allow-list.
 */
export function getAllowedCorsOrigins(): CorsAllowList {
  const raw = process.env.CHORUS_PANEL_CORS_ORIGIN
  if (!raw) return isProduction ? false : true
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Express `trust proxy` setting, derived from CHORUS_PANEL_TRUST_PROXY.
 *
 * Unset (default) → trust nothing: the panel binds 127.0.0.1 for direct
 * access and `req.ip` is the socket address. When deployed behind a reverse
 * proxy, set this to the proxy's IP/CIDR list (comma-separated) or `true` to
 * trust all hops — Express then derives `req.ip` from X-Forwarded-For so the
 * login rate limiter keys on the real client instead of the proxy (RISK-
 * PANEL-003). Only set this when an actual proxy is in front, otherwise
 * clients can spoof X-Forwarded-For.
 */
export function getTrustProxy(): boolean | string {
  const raw = process.env.CHORUS_PANEL_TRUST_PROXY
  if (!raw) return false
  if (raw === 'true') return true
  if (raw === 'false') return false
  return raw
}

/**
 * Normalise a request origin against the allow-list.
 * Returns the origin string if allowed, otherwise `false` (CORS rejection) or
 * `true` (reflect request origin — dev only).
 */
export function resolveCorsOrigin(
  origin: string | undefined,
): string | boolean | undefined {
  const allowed = getAllowedCorsOrigins()
  if (allowed === true) return true
  if (allowed === false) return false
  if (!origin) return true // same-origin / curl — allow non-CORS requests
  return allowed.includes(origin) ? origin : false
}
