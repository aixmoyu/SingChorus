import { Router } from 'express'
import { requireAuth } from '../../auth.js'
import { getCore, triggerSync } from '../../core-provider.js'
import { toErrorEnvelope, toValidationError } from '../../api-error.js'
import { z } from 'zod'
import { recordSchema, toCoreError } from './helpers.js'

const router = Router()
router.use(requireAuth)

const createConfigSchema = z.object({
  name: z.string().min(1).max(64),
  node: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  server_config: recordSchema.default({}),
  client_config: recordSchema.default({}),
  params: recordSchema.default({}),
})

const updateConfigSchema = z.object({
  server_config: recordSchema.optional(),
  client_config: recordSchema.optional(),
  params: recordSchema.optional(),
  node: z.string().optional(),
  enabled: z.boolean().optional(),
})

// --- Configs ---

router.get('/configs', (_req, res) => {
  const core = getCore()
  const configs = core.configs.listAll()
  res.json({ configs })
})

router.post('/configs', (req, res) => {
  const parsed = createConfigSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', toValidationError(parsed.error)))
    return
  }
  const core = getCore()
  const { name, node, type, server_config, client_config, params } = parsed.data
  try {
    const entry = core.configs.add(name, node, type, server_config, client_config, params)
    triggerSync()
    req.log.info({ name, node, type }, 'config created')
    res.status(201).json(entry)
  } catch (err) {
    const e = toCoreError(err)
    res.status(e.status).json(toErrorEnvelope(e.code, e.message))
  }
})

/** Pre-fill data for the create form: node address for the `domain` param. */
router.get('/configs/prefill', (_req, res) => {
  const core = getCore()
  const identity = core.getIdentity()
  res.json({
    node_address: identity.address,
    node_name: identity.name,
  })
})

/**
 * Verify a config's tag is unique before the panel commits it:
 * locally (own configs) and in the cloud (all nodes' configs).
 */
router.post('/configs/check-tag', async (req, res) => {
  const tag = String((req.body as { tag?: unknown })?.tag ?? '').trim()
  if (!tag) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', 'tag is required'))
    return
  }
  const core = getCore()
  // Local check: no existing config (own or remote) may use this tag.
  const tagOf = (e: { client_config?: { tag?: unknown } }) => String(e.client_config?.tag ?? '')
  const localConflict =
    core.configs.listAll().some((e) => tagOf(e) === tag) ||
    core.listRemoteConfigs().some((e) => tagOf(e) === tag)
  if (localConflict) {
    res.json({ tag, available: false, source: 'local' })
    return
  }
  try {
    const available = await core.cloud.checkTagAvailable(tag)
    res.json({ tag, available })
  } catch (err) {
    // Cloud unavailable — report availability based on local data only, but
    // keep the underlying reason so the UI/log can explain why the remote
    // check was skipped.
    const detail = err instanceof Error ? err.message : String(err)
    req.log.warn({ tag, detail }, 'check-tag: remote check unavailable, degrading to local-only')
    res.json({ tag, available: true, source: 'local_only', detail })
  }
})

/**
 * Verify a config's listen port doesn't collide with another config already
 * stored on this machine (ports are per-machine; cloud enforces the same rule
 * per fingerprint on upload).
 */
router.post('/configs/check-port', (req, res) => {
  const port = Number((req.body as { port?: unknown })?.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', 'valid port (1-65535) is required'))
    return
  }
  const core = getCore()
  const conflict = core.configs.listAll().find((e) => {
    const p = Number(e.server_config?.listen_port ?? e.client_config?.server_port)
    return Number.isInteger(p) && p === port
  })
  res.json({ port, available: !conflict, conflictWith: conflict?.name ?? null })
})

router.get('/configs/:name', (req, res) => {
  const core = getCore()
  try {
    const entry = core.configs.get(req.params.name)
    res.json(entry)
  } catch (err) {
    const e = toCoreError(err)
    res.status(e.status === 500 ? 404 : e.status).json(toErrorEnvelope(e.code, e.message))
  }
})

router.put('/configs/:name', (req, res) => {
  const parsed = updateConfigSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', toValidationError(parsed.error)))
    return
  }
  const core = getCore()
  try {
    const entry = core.configs.update(req.params.name, parsed.data as Parameters<typeof core.configs.update>[1])
    triggerSync()
    req.log.info({ name: req.params.name, fields: Object.keys(parsed.data) }, 'config updated')
    res.json(entry)
  } catch (err) {
    const e = toCoreError(err)
    res.status(e.status).json(toErrorEnvelope(e.code, e.message))
  }
})

router.delete('/configs/:name', (req, res) => {
  const core = getCore()
  try {
    core.configs.delete(req.params.name)
    triggerSync()
    req.log.info({ name: req.params.name }, 'config deleted')
    res.json({ status: 'deleted' })
  } catch (err) {
    const e = toCoreError(err)
    res.status(e.status === 500 ? 404 : e.status).json(toErrorEnvelope(e.code, e.message))
  }
})

router.post('/configs/:name/enable', (req, res) => {
  const core = getCore()
  try {
    core.configs.enable(req.params.name)
    const entry = core.configs.get(req.params.name)
    triggerSync()
    req.log.info({ name: req.params.name }, 'config enabled')
    res.json(entry)
  } catch (err) {
    const e = toCoreError(err)
    res.status(e.status).json(toErrorEnvelope(e.code, e.message))
  }
})

router.post('/configs/:name/disable', (req, res) => {
  const core = getCore()
  try {
    core.configs.disable(req.params.name)
    const entry = core.configs.get(req.params.name)
    triggerSync()
    req.log.info({ name: req.params.name }, 'config disabled')
    res.json(entry)
  } catch (err) {
    const e = toCoreError(err)
    res.status(e.status).json(toErrorEnvelope(e.code, e.message))
  }
})

// --- Remote configs (owned by other machines, read-only) ---

router.get('/remote-configs', (_req, res) => {
  const core = getCore()
  res.json({ configs: core.listRemoteConfigs() })
})

router.get('/remote-configs/:fingerprint/:name', (req, res) => {
  const core = getCore()
  // core-D1: 走 core 门面读取，不深读 core.store 内部。
  const entry = core.getRemoteConfig(req.params.fingerprint, req.params.name)
  if (!entry) {
    res.status(404).json(toErrorEnvelope('CFG_NOT_FOUND', 'Remote configuration not found'))
    return
  }
  res.json(entry)
})

router.delete('/remote-configs/:fingerprint/:name', async (req, res) => {
  const core = getCore()
  try {
    await core.deleteRemoteConfig(req.params.fingerprint, req.params.name)
    triggerSync()
    req.log.info({ fingerprint: req.params.fingerprint, name: req.params.name }, 'remote config deleted')
    res.json({ status: 'deleted' })
  } catch (err) {
    const e = toCoreError(err)
    res.status(e.status).json(toErrorEnvelope(e.code, e.message))
  }
})

export default router
