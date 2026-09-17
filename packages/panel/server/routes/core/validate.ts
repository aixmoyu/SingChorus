import { Router } from 'express'
import { requireAuth } from '../../auth.js'
import { getCore } from '../../core-provider.js'
import { toCoreError } from './helpers.js'
import { z } from 'zod'

const router = Router()
router.use(requireAuth)

const validateSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  label: z.string().optional(),
  image: z.string().optional(),
})

// --- Validate ---

router.post('/validate', (req, res) => {
  const parsed = validateSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json({ valid: false, errors: ['config is required'] })
    return
  }
  const core = getCore()
  void core
    .validate(parsed.data.config)
    .then((result) => res.json(result))
    .catch((err) => {
      const e = toCoreError(err)
      res.json({ valid: false, errors: [e.message || 'Validation failed'] })
    })
})

router.post('/validate/entry/:name', (req, res) => {
  const core = getCore()
  void Promise.resolve()
    .then(async () => {
      const side = req.query.side as string
      const entry = core.configs.get(req.params.name)
      const config = side === 'client' ? entry.client_config : entry.server_config
      const result = await core.validate(config)
      res.json(result)
    })
    .catch((err) => {
      const e = toCoreError(err)
      res.json({ valid: false, errors: [e.message || 'Validation failed'] })
    })
})

router.post('/validate/merged', async (_req, res) => {
  const core = getCore()
  try {
    const config = await core.generateServerConfig()
    const result = await core.validate(config)
    res.json(result)
  } catch (err) {
    const e = toCoreError(err)
    res.json({ valid: false, errors: [e.message || 'Validation failed'] })
  }
})

router.post('/validate/subscription', async (_req, res) => {
  const core = getCore()
  try {
    const config = await core.generateSubscription()
    const result = await core.validate(config)
    res.json(result)
  } catch (err) {
    const e = toCoreError(err)
    res.json({ valid: false, errors: [e.message || 'Validation failed'] })
  }
})

export default router
