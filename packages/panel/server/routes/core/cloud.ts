import { Router } from 'express'
import { requireAuth } from '../../auth.js'
import { getCore, getSyncService } from '../../core-provider.js'
import { toErrorEnvelope, toValidationError } from '../../api-error.js'
import { z } from 'zod'
import { recordSchema, toCoreError } from './helpers.js'

const router = Router()
router.use(requireAuth)

const generateSchema = z.object({
  type: z.string().min(1),
  params: recordSchema.default({}),
})

const createSubscriptionSchema = z.object({
  name: z.string().optional(),
  path: z.string().min(1).max(64).optional(),
  token: z.string().optional(),
  overallTemplateId: z.string().nullable().optional(),
  overallParams: recordSchema.optional(),
  active: z.boolean().optional(),
})

const updateSubscriptionSchema = z.object({
  name: z.string().optional(),
  path: z.string().min(1).max(64).optional(),
  token: z.string().optional(),
  overallTemplateId: z.string().nullable().optional(),
  overallParams: recordSchema.optional(),
  active: z.boolean().optional(),
  regenerateToken: z.boolean().optional(),
})

// --- Cloud ---

router.get('/cloud/templates', async (req, res) => {
  const core = getCore()
  try {
    const role = req.query.role as string | undefined
    // 节点版本注入（§5.2）：cloud 按模板 singbox_compat 过滤，前端零感知。
    const version = core.getAppConfig().singbox_version || undefined
    const { templates, filtered_count } = await core.cloud.getTemplatesWithCount(role, version)
    res.json({ templates, filtered_count })
  } catch (err) {
    const e = toCoreError(err)
    res.status(503).json(toErrorEnvelope(e.code || 'CLOUD_UNREACHABLE', e.message))
  }
})

router.post('/cloud/generate', (req, res) => {
  const parsed = generateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', 'type is required'))
    return
  }
  const core = getCore()
  const { type, params } = parsed.data
  void core
    .generateConfig(type, params)
    .then((result) => res.json(result))
    .catch((err) => {
      const e = toCoreError(err)
      res.status(e.status).json(toErrorEnvelope(e.code || 'CLOUD_GENERATE_FAILED', e.message))
    })
})

router.get('/cloud/sync-status', async (_req, res) => {
  const core = getCore()
  try {
    const statuses = await core.getAllSyncStatuses()
    // Per-config push failures from the last sync round (e.g. cloud 409
    // PORT_CONFLICT) — so a stuck 'pending' badge is explainable in the UI
    // (CONS-PANEL-002) instead of only in server logs.
    const failures = getSyncService().status.lastFailures
    res.json({ statuses, failures })
  } catch (err) {
    const e = toCoreError(err)
    res.status(502).json(toErrorEnvelope('CLOUD_UNREACHABLE', e.message))
  }
})

router.get('/cloud/status', async (_req, res) => {
  const core = getCore()
  try {
    await core.cloud.getProtocols()
    res.json({ connected: true })
  } catch {
    res.json({ connected: false })
  }
})

router.get('/cloud/subscriptions', async (_req, res) => {
  const core = getCore()
  try {
    const subscriptions = await core.listSubscriptions()
    res.json({ subscriptions })
  } catch (err) {
    const e = toCoreError(err)
    res.status(503).json(toErrorEnvelope(e.code || 'CLOUD_UNREACHABLE', e.message))
  }
})

router.get('/cloud/subscriptions/:id', async (req, res) => {
  const core = getCore()
  try {
    const subscription = await core.getSubscription(req.params.id)
    if (!subscription) {
      res.status(404).json(toErrorEnvelope('SUB_NOT_FOUND', 'Subscription not found'))
      return
    }
    res.json({ subscription })
  } catch (err) {
    const e = toCoreError(err)
    res.status(503).json(toErrorEnvelope(e.code || 'CLOUD_UNREACHABLE', e.message))
  }
})

router.post('/cloud/subscriptions', (req, res) => {
  const parsed = createSubscriptionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', toValidationError(parsed.error)))
    return
  }
  const core = getCore()
  void core
    .createSubscription(parsed.data)
    .then((subscription) => {
      req.log.info({ id: subscription.id, path: subscription.path }, 'subscription created')
      res.status(201).json({ subscription })
    })
    .catch((err) => {
      const e = toCoreError(err)
      res.status(502).json(toErrorEnvelope(e.code || 'CLOUD_CREATE_FAILED', e.message))
    })
})

router.put('/cloud/subscriptions/:id', (req, res) => {
  const parsed = updateSubscriptionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', toValidationError(parsed.error)))
    return
  }
  const core = getCore()
  void core
    .updateSubscription(req.params.id, parsed.data)
    .then((subscription) => {
      req.log.info(
        { id: req.params.id, fields: Object.keys(parsed.data), regeneratedToken: parsed.data.regenerateToken === true },
        'subscription updated',
      )
      res.json({ subscription })
    })
    .catch((err) => {
      const e = toCoreError(err)
      res.status(502).json(toErrorEnvelope(e.code || 'CLOUD_UPDATE_FAILED', e.message))
    })
})

router.delete('/cloud/subscriptions/:id', (req, res) => {
  const core = getCore()
  void core
    .deleteSubscription(req.params.id)
    .then(() => {
      req.log.info({ id: req.params.id }, 'subscription deleted')
      res.json({ success: true })
    })
    .catch((err) => {
      const e = toCoreError(err)
      res.status(502).json(toErrorEnvelope(e.code || 'CLOUD_DELETE_FAILED', e.message))
    })
})

router.get('/cloud/instances', async (_req, res) => {
  const core = getCore()
  try {
    const instances = await core.cloud.getProtocolInstances()
    res.json({ instances })
  } catch (err) {
    const e = toCoreError(err)
    res.status(503).json(toErrorEnvelope(e.code || 'CLOUD_UNREACHABLE', e.message))
  }
})

export default router
