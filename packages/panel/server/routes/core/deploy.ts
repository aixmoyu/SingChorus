import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../auth.js'
import { getCore, triggerSync } from '../../core-provider.js'
import { toErrorEnvelope, toValidationError } from '../../api-error.js'
import { toCoreError } from './helpers.js'

const router = Router()
router.use(requireAuth)

const deploySchema = z.object({
  // Optional overall template ids — omitted ids fall back to the cloud defaults.
  serverOverallId: z.string().min(1).optional(),
  dockerOverallId: z.string().min(1).optional(),
})

// --- Deploy ---

router.post('/deploy', async (req, res) => {
  const parsed = deploySchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(422).json(toErrorEnvelope('VALIDATION_ERROR', toValidationError(parsed.error)))
    return
  }
  const core = getCore()
  const startedAt = Date.now()
  try {
    await core.deploy(parsed.data)
    // 部署成功改变了 deployed 集合：自动同步，让订阅端立即反映新可见性。
    triggerSync()
    req.log.info({ durationMs: Date.now() - startedAt }, 'deploy succeeded')
    res.json({ status: 'deployed' })
  } catch (err) {
    // 容器可能已启动但标记未写入（如健康检查超时）——服务端必须留痕，
    // 否则 VPS 上只能看到「容器在跑但 Deployed=No」却无从排查。
    req.log.error({ err, durationMs: Date.now() - startedAt }, 'deploy failed')
    const e = toCoreError(err)
    res.status(e.status === 500 ? 400 : e.status).json(toErrorEnvelope(e.code || 'DEPLOY_FAILED', e.message))
  }
})

router.get('/deploy/meta', async (_req, res) => {
  try {
    const core = getCore()
    // 上次成功部署的版本/镜像/时间；旧部署无记录 → null（前端显示 unknown）。
    res.json({ meta: core.deployMeta() })
  } catch (err) {
    const e = toCoreError(err)
    res.status(503).json(toErrorEnvelope(e.code || 'DOCKER_UNAVAILABLE', e.message || 'Docker unavailable'))
  }
})

router.get('/deploy/status', async (_req, res) => {
  try {
    const core = getCore()
    const status = await core.deployStatus()
    res.json({ status })
  } catch (err) {
    const e = toCoreError(err)
    res.status(503).json(toErrorEnvelope('DOCKER_UNAVAILABLE', e.message || 'Docker unavailable'))
  }
})

router.post('/deploy/stop', async (req, res) => {
  try {
    const core = getCore()
    await core.stopDeploy()
    // 停止部署清空 deployed 集合：自动同步，订阅端移除这些节点。
    triggerSync()
    res.json({ status: 'stopped' })
  } catch (err) {
    req.log.error({ err }, 'deploy stop failed')
    const e = toCoreError(err)
    res.status(e.status === 500 ? 503 : e.status).json(toErrorEnvelope(e.code || 'DOCKER_UNAVAILABLE', e.message || 'Docker unavailable'))
  }
})

router.post('/deploy/restart', async (_req, res) => {
  try {
    const core = getCore()
    await core.restartDeploy()
    res.json({ status: 'restarted' })
  } catch (err) {
    const e = toCoreError(err)
    res.status(e.status === 500 ? 503 : e.status).json(toErrorEnvelope(e.code || 'DOCKER_UNAVAILABLE', e.message || 'Docker unavailable'))
  }
})

router.get('/logs', async (req, res) => {
  try {
    const core = getCore()
    const tail = parseInt(req.query.tail as string, 10) || 100
    const logs = await core.deployLogs(tail)
    const lines = logs ? logs.split('\n').filter((l) => l) : []
    res.json({ lines })
  } catch (err) {
    const e = toCoreError(err)
    res.status(503).json(toErrorEnvelope('DOCKER_UNAVAILABLE', e.message || 'Docker unavailable'))
  }
})

export default router
