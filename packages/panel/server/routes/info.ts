import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { getStoreDirPath, isInitialized } from '../config.js'
import { getCore, getSyncService } from '../core-provider.js'
import { CORE_VERSION } from '@chorus/core'
import { PANEL_VERSION } from '../version.js'
import { checkCoreVersion, checkCloudVersion, fetchCloudVersion, isStrictCompat, SUPPORTED_CLOUD_RANGE } from '../compat.js'

const router = Router()
router.use(requireAuth)

router.get('/', async (_req, res) => {
  const storeDir = getStoreDirPath()
  let configCount = 0
  let sync: ReturnType<typeof getSyncService>['status'] | null = null
  try {
    const core = getCore()
    configCount = core.configs.listAll().length
    // Expose sync engine health (last sync time, pending changes, failure
    // count) so "why isn't this on the cloud yet" is diagnosable from the UI.
    if (isInitialized()) sync = getSyncService().status
  } catch {
    /* core not initialized yet */
  }
  // Component compatibility report: core is checked synchronously (static
  // import), cloud is probed best-effort (null version = unreachable/unknown,
  // reported as ok:null so the UI does not raise a false alarm).
  const cloudVersion = await fetchCloudVersion()
  res.json({
    data_dir: storeDir,
    config_count: configCount,
    sync,
    panel_version: PANEL_VERSION,
    core_version: CORE_VERSION,
    cloud_version: cloudVersion,
    compat: {
      core: checkCoreVersion(CORE_VERSION),
      cloud: cloudVersion === null
        ? { version: null, range: SUPPORTED_CLOUD_RANGE, ok: null }
        : checkCloudVersion(cloudVersion),
      strict: isStrictCompat(),
    },
    framework: 'Vue 3 + Express',
  })
})

export default router
