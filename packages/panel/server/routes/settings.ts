import { Router } from 'express'
import { loadConfig, updateConfig } from '../config.js'
import { requireAuth } from '../auth.js'
import { getCore, invalidateCore, resolveCloudUrl, triggerSync, ensureSyncTimer } from '../core-provider.js'
import { toErrorEnvelope, toValidationError } from '../api-error.js'
import { CloudClient } from '@chorus/core'
import { z } from 'zod'

const router = Router()
router.use(requireAuth)

router.get('/', (_req, res) => {
  const cfg = loadConfig()
  res.json({
    core_url: cfg.core_url,
    core_token: cfg.core_token,
    node_name: cfg.node_name,
    node_address: cfg.node_address,
    effective_cloud_url: resolveCloudUrl(),
  })
})

const settingsSchema = z.object({
  core_url: z.string().optional(),
  core_token: z.string().optional(),
  node_name: z.string().min(1).max(128).optional(),
  node_address: z.string().max(255).optional(),
})

router.post('/', (req, res) => {
  const parsed = settingsSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', toValidationError(parsed.error)))
    return
  }
  const updates: Record<string, string> = {}
  if (parsed.data.core_url !== undefined) updates.core_url = parsed.data.core_url.trim().replace(/\/+$/, '')
  if (parsed.data.core_token !== undefined) updates.core_token = parsed.data.core_token
  if (parsed.data.node_name !== undefined) updates.node_name = parsed.data.node_name
  if (parsed.data.node_address !== undefined) updates.node_address = parsed.data.node_address
  const cfg = updateConfig(updates)
  // Drop the cached ChorusCore instance so the next request picks up the new URL/token.
  invalidateCore()
  // Mirror node identity + cloud settings into core's app config (used by sync).
  const core = getCore()
  core.updateAppConfig({
    cloud_url: resolveCloudUrl(),
    cloud_token: cfg.core_token || '',
    node_name: cfg.node_name,
    node_address: cfg.node_address,
  })
  ensureSyncTimer()
  triggerSync()
  req.log.info({ fields: Object.keys(updates), cloudUrl: updates.core_url }, 'panel settings updated')
  res.json({
    core_url: cfg.core_url,
    core_token: cfg.core_token,
    node_name: cfg.node_name,
    node_address: cfg.node_address,
  })
})

router.post('/test', async (req, res) => {
  try {
    // Ensure we read the latest config (the operator may have just saved).
    invalidateCore()
    const core = getCore()
    await core.cloud.getProtocols()
    req.log.info('cloud connection test succeeded')
    res.json({ reachable: true })
  } catch (err) {
    const e = err as { message?: string }
    req.log.warn({ error: e.message || 'Cloud unreachable' }, 'cloud connection test failed')
    res.json({ reachable: false, error: e.message || 'Cloud unreachable' })
  }
})

const testCandidateSchema = z.object({
  cloud_url: z.string().min(1).max(255),
  cloud_token: z.string().min(1).max(255),
})

/**
 * Probe candidate cloud settings without persisting them — used by the setup
 * wizard's "test connection" step before the user commits.
 */
router.post('/test-candidate', async (req, res) => {
  const parsed = testCandidateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.json({ reachable: false, error: 'cloud_url and cloud_token are required' })
    return
  }
  const { cloud_url, cloud_token } = parsed.data
  try {
    const probe = new CloudClient({
      cloud_url: cloud_url.trim().replace(/\/+$/, ''),
      cloud_token,
    })
    // noRetry: a best-effort pre-flight probe — retrying an unreachable
    // candidate for 25s only burns the user's request budget.
    await probe.getProtocols(true)
    res.json({ reachable: true })
  } catch (err) {
    const e = err as { message?: string }
    res.json({ reachable: false, error: e.message || 'Cloud unreachable' })
  }
})

export default router
