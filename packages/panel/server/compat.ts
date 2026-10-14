import semver from 'semver'
import { loadConfig } from './config.js'
import { resolveCloudUrl } from './core-provider.js'
import { logger } from './logger.js'

/**
 * Single point of declaration for the component version ranges this panel
 * build supports. When a dependency ships a breaking change, bump its
 * package version and update the matching range here — the compat tests
 * turn red if core's version drifts outside the declared range without
 * this file being touched.
 */
export const SUPPORTED_CORE_RANGE = '>=0.1.0 <0.2.0'
export const SUPPORTED_CLOUD_RANGE = '>=0.1.0 <0.2.0'

export interface CompatCheck {
  version: string | null
  range: string
  /** true = compatible, false = incompatible, null = unknown (unreachable). */
  ok: boolean | null
}

export function checkCoreVersion(version: string): CompatCheck {
  const ok = semver.valid(version) != null && semver.satisfies(version, SUPPORTED_CORE_RANGE)
  return { version, range: SUPPORTED_CORE_RANGE, ok }
}

export function checkCloudVersion(version: string): CompatCheck {
  const ok = semver.valid(version) != null && semver.satisfies(version, SUPPORTED_CLOUD_RANGE)
  return { version, range: SUPPORTED_CLOUD_RANGE, ok }
}

/** Strict mode: refuse startup instead of warning on a core mismatch. */
export function isStrictCompat(): boolean {
  return process.env.CHORUS_PANEL_STRICT_COMPAT === '1'
}

const CLOUD_PROBE_TIMEOUT_MS = 3_000
const CLOUD_PROBE_TTL_MS = 60_000

let cloudProbe: { promise: Promise<string | null>; at: number } | null = null

/**
 * Best-effort probe of the cloud's version via the public /health endpoint.
 * Returns null when the cloud is not configured, unreachable, or returned no
 * version. Results are cached for 60s (with in-flight promise de-duplication)
 * so /api/info is never slowed down by an unreachable cloud beyond one probe.
 */
export async function fetchCloudVersion(): Promise<string | null> {
  // Cloud not configured (empty core_url — resolveCloudUrl would fall back to
  // DEFAULT_CLOUD_URL): "not configured" is not "unreachable", so skip the
  // probe entirely instead of hammering the default address every TTL.
  if (!loadConfig().core_url?.trim()) return null
  if (cloudProbe && Date.now() - cloudProbe.at < CLOUD_PROBE_TTL_MS) {
    return cloudProbe.promise
  }
  const url = `${resolveCloudUrl().replace(/\/+$/, '')}/health`
  const promise = (async () => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(CLOUD_PROBE_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { version?: unknown }
      return typeof body.version === 'string' && body.version.length > 0 ? body.version : null
    } catch (err) {
      logger.debug({ err, url }, 'cloud version probe failed')
      return null
    }
  })()
  cloudProbe = { promise, at: Date.now() }
  return promise
}

/**
 * Drop the cached cloud version probe. Called when the operator saves a new
 * cloud URL so /api/info doesn't report a stale version from the old target.
 */
export function invalidateCloudVersion(): void {
  cloudProbe = null
}
