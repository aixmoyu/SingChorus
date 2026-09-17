import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { getStoreDirPath, isInitialized } from '../config.js'
import { getCore, getSyncService } from '../core-provider.js'

const router = Router()
router.use(requireAuth)

router.get('/', (_req, res) => {
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
  res.json({
    data_dir: storeDir,
    config_count: configCount,
    sync,
    panel_version: '0.2.0',
    framework: 'Vue 3 + Express',
  })
})

export default router
