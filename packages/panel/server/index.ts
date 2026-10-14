import { createApp } from './app.js'
import { logger } from './logger.js'
import { CORE_VERSION } from '@chorus/core'
import { checkCoreVersion, isStrictCompat } from './compat.js'

const PORT = parseInt(process.env.CHORUS_PANEL_PORT || '8088', 10)
const HOST = process.env.CHORUS_PANEL_HOST || '127.0.0.1'

/**
 * Startup compatibility gate for the in-process core. The version of the
 * loaded @chorus/core dist must sit inside the range this panel build
 * declares (server/compat.ts). Default mode: warn and keep serving. Strict
 * mode (CHORUS_PANEL_STRICT_COMPAT=1): refuse to start — this runs before
 * listen(), so there is no socket to shut down gracefully.
 */
function assertCoreCompat(): boolean {
  const check = checkCoreVersion(CORE_VERSION)
  if (check.ok) return true
  if (isStrictCompat()) {
    logger.error(
      { core_version: check.version, supported_range: check.range },
      'incompatible @chorus/core version — refusing to start (CHORUS_PANEL_STRICT_COMPAT=1); upgrade @chorus/core or adjust the supported range in server/compat.ts',
    )
    return false
  }
  logger.warn(
    { core_version: check.version, supported_range: check.range },
    'incompatible @chorus/core version detected — the UI will show a compatibility warning; upgrade @chorus/core or adjust the supported range in server/compat.ts',
  )
  return true
}

export function startServer(): void {
  if (!assertCoreCompat()) {
    process.exit(1)
  }
  const app = createApp()
  app.listen(PORT, HOST, () => {
    logger.info(`ChorusPanel listening on http://${HOST}:${PORT}`)
  })
}

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection')
})

startServer()
