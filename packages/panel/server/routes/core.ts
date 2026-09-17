import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { ensureSyncTimer } from '../core-provider.js'
import { isInitialized } from '../config.js'
import configsRoutes from './core/configs.js'
import cloudRoutes from './core/cloud.js'
import deployRoutes from './core/deploy.js'
import validateRoutes from './core/validate.js'

// Core-capability proxy endpoints, split by domain (PERF-PANEL-002):
// configs/remote-configs, cloud (templates/subscriptions/sync), deploy/logs,
// and validate. All sit behind panel auth.

const router = Router()
router.use(requireAuth)

// Mutation endpoints below auto-sync; the sync timer is only needed once
// the panel is fully initialized (cloud token configured).
if (isInitialized()) ensureSyncTimer()

router.use(configsRoutes)
router.use(cloudRoutes)
router.use(deployRoutes)
router.use(validateRoutes)

export default router
