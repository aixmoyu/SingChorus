import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../auth.js'
import { isInitialized, loadConfig, updateConfig } from '../config.js'
import { getCore, invalidateCore, triggerSync, ensureSyncTimer } from '../core-provider.js'
import { toErrorEnvelope, toValidationError } from '../api-error.js'
import { CloudClient } from '@chorus/core'

/**
 * First-run initialization wizard state: password (via /api/auth/setup) plus
 * node identity and cloud connection, which are stored here.
 */
const router = Router()
router.use(requireAuth)

router.get('/', (_req, res) => {
  const cfg = loadConfig()
  const core = getCore()
  res.json({
    initialized: isInitialized(),
    fingerprint: core.getFingerprint(),
    node_name: cfg.node_name,
    node_address: cfg.node_address,
    cloud_url: cfg.core_url,
    cloud_token: cfg.core_token ? 'set' : '',
  })
})

const initSchema = z.object({
  node_name: z.string().min(1).max(128),
  node_address: z.string().max(255).default(''),
  cloud_url: z.string().min(1).max(255),
  cloud_token: z.string().min(1).max(255),
  cloud_required: z.boolean().default(true),
})

router.post('/', async (req, res) => {
  const parsed = initSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', toValidationError(parsed.error)))
    return
  }
  const { node_name, node_address, cloud_url, cloud_token, cloud_required } = parsed.data
  const trimmedUrl = cloud_url.trim().replace(/\/+$/, '')

  // Verify the cloud accepts this token before committing the setup.
  const probe = new CloudClient({
    cloud_url: trimmedUrl,
    cloud_token,
  })
  let cloudOk = true
  let cloudError = ''
  try {
    // noRetry: fail fast on an unreachable cloud so the wizard stays snappy.
    await probe.getProtocols(true)
  } catch (err) {
    cloudOk = false
    cloudError = (err as { message?: string }).message || 'Cloud unreachable'
    if (cloud_required) {
      res.status(502).json(toErrorEnvelope('CLOUD_UNREACHABLE', cloudError))
      return
    }
  }

  updateConfig({
    node_name,
    node_address,
    core_url: trimmedUrl,
    core_token: cloud_token,
    initialized: true,
  })
  invalidateCore()

  const core = getCore()
  // Node identity also lives in core's app config for ChorusCore.getIdentity().
  core.updateAppConfig({
    cloud_url: trimmedUrl,
    cloud_token,
    node_name,
    node_address,
  })

  // Register with the cloud immediately (best-effort) and start background sync.
  try {
    const identity = core.getIdentity()
    await core.cloud.registerNode({
      fingerprint: identity.fingerprint,
      name: identity.name,
      address: identity.address,
    })
  } catch (err) {
    req.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'node registration failed; will retry via background sync',
    )
  }
  ensureSyncTimer()
  triggerSync()
  req.log.info(
    { node_name, node_address, cloud_url: trimmedUrl, cloud_ok: cloudOk },
    'panel initialized',
  )

  res.json({
    initialized: true,
    cloud_ok: cloudOk,
    ...(cloudOk ? {} : { cloud_error: cloudError }),
  })
})

/** Re-run connectivity test for the currently-saved cloud settings. */
router.post('/test', async (_req, res) => {
  try {
    const core = getCore()
    await core.cloud.getProtocols()
    res.json({ reachable: true })
  } catch (err) {
    const e = err as { message?: string }
    res.json({ reachable: false, error: e.message || 'Cloud unreachable' })
  }
})

export default router
