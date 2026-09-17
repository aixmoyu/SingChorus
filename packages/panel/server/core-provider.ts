/**
 * Single source of truth for the `ChorusCore` instance.
 *
 * Previously each route file (`routes/core.ts`, `routes/info.ts`,
 * `routes/settings.ts`) independently instantiated `ChorusCore` and re-derived
 * the cloud URL from `loadConfig()` with a hardcoded `CLOUD_WORKER_URL` fallback
 * of `http://localhost:8787`. This module consolidates that into one cached
 * provider so config changes invalidate the cache uniformly and there is no
 * drift between route files.
 *
 * It also owns the automatic sync engine: after the first `getCore()` call,
 * mutations route through `triggerSync()` and a background timer keeps
 * retrying failed pushes and pulling other nodes' configs.
 */
import { ChorusCore, SyncService } from '@chorus/core'
import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { currentRequestId } from './request-context.js'

/**
 * The default cloud URL used when the operator has not configured one.
 * Kept here (instead of duplicated across route files) so the fallback is
 * discoverable and overridable in one place.
 */
export const DEFAULT_CLOUD_URL = 'http://localhost:8787'

/** Resolve the effective cloud URL from the stored panel config. */
export function resolveCloudUrl(): string {
  // Historical `http://127.0.0.1:8080` sentinel values are migrated to '' on
  // read by config.ts, so an empty value is the only "unset" marker.
  const url = loadConfig().core_url?.trim()
  return url ? url : DEFAULT_CLOUD_URL
}

let cachedInstance: ChorusCore | null = null
let cachedConfigRef: PanelConfigSnapshot | null = null
let cachedSyncService: SyncService | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null

/** Background tick: retry failed pushes every 30s (SyncService adds backoff). */
const SYNC_TICK_MS = 30_000

interface PanelConfigSnapshot {
  cloudUrl: string
  cloudToken: string
}

function snapshot(): PanelConfigSnapshot {
  const cfg = loadConfig()
  return {
    cloudUrl: resolveCloudUrl(),
    cloudToken: cfg.core_token || '',
  }
}

/**
 * Get the shared `ChorusCore` instance, recreating it when the underlying
 * config (URL / token) changes.
 */
export function getCore(): ChorusCore {
  const snap = snapshot()
  if (cachedInstance && cachedConfigRef) {
    if (
      cachedConfigRef.cloudUrl === snap.cloudUrl &&
      cachedConfigRef.cloudToken === snap.cloudToken
    ) {
      return cachedInstance
    }
  }
  cachedInstance = new ChorusCore({
    cloud_url: snap.cloudUrl,
    cloud_token: snap.cloudToken,
  }, {
    // core 日志统一进 pino（component: core）；出站请求自动携带当前
    // X-Request-ID，panel → cloud 全链路可追踪。
    logger: logger.child({ component: 'core' }),
    getRequestId: currentRequestId,
  })
  cachedConfigRef = snap
  if (cachedSyncService) {
    cachedSyncService.dispose()
    cachedSyncService = new SyncService(cachedInstance, logger.child({ component: 'sync' }))
  }
  return cachedInstance
}

/**
 * The shared automatic-sync engine. Created lazily on first use and rebound to
 * the current core instance whenever the core is recreated.
 */
export function getSyncService(): SyncService {
  if (!cachedSyncService) {
    cachedSyncService = new SyncService(getCore(), logger.child({ component: 'sync' }))
  }
  return cachedSyncService
}

/**
 * Kick the background sync timer. Called once the panel is initialized and
 * after every local mutation via `triggerSync()`.
 */
export function ensureSyncTimer(): void {
  if (syncTimer) return
  syncTimer = setInterval(() => {
    const core = getCore()
    if (!core.getAppConfig().cloud_token) return // not configured yet
    void getSyncService().tick()
  }, SYNC_TICK_MS)
  syncTimer.unref?.()
}

/** Trigger an immediate sync run (used after local mutations). Fire-and-forget. */
export function triggerSync(): void {
  const core = getCore()
  if (!core.getAppConfig().cloud_token) return // not configured yet
  void getSyncService().trigger()
}

/**
 * Drop the cached instance. Used by the settings route after the operator
 * saves a new cloud URL / token so the next request re-creates the instance
 * with the updated config.
 */
export function invalidateCore(): void {
  cachedInstance = null
  cachedConfigRef = null
  if (cachedSyncService) {
    cachedSyncService.dispose()
    cachedSyncService = null
  }
}
