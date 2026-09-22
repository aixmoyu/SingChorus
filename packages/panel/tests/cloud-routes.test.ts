import request from 'supertest'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { Application } from 'express'
import { ADMIN_PASSWORD, makeTempHome, loadApp, setupAdmin } from './helpers.js'

/**
 * ST for every route whose outcome depends on the cloud or Docker — the two
 * dependencies we cannot have in a unit suite (unreachable-cloud probes would
 * burn 21s of retry budget; docker commands would leave the suite
 * environment-dependent). `@chorus/core` is replaced with a deterministic
 * stub whose behavior each test pins, so what is actually under test is the
 * panel layer: routing, zod validation, error-code/status mapping, envelope
 * shape and the triggerSync wiring.
 */
const h = vi.hoisted(() => {
  const behavior = {
    calls: [] as string[],
    lastFailures: [] as Array<{ name: string; message: string }>,
    appConfig: {} as Record<string, unknown>,
    getProtocols: undefined as ((noRetry?: boolean) => unknown) | undefined,
    getTemplates: undefined as ((role?: string) => unknown) | undefined,
    generateConfig: undefined as ((type: string, params: unknown) => unknown) | undefined,
    checkTagAvailable: undefined as ((tag: string) => unknown) | undefined,
    getProtocolInstances: undefined as (() => unknown) | undefined,
    registerNode: undefined as ((data: unknown) => unknown) | undefined,
    listSubscriptions: undefined as (() => unknown) | undefined,
    getSubscription: undefined as ((id: string) => unknown) | undefined,
    createSubscription: undefined as ((data: unknown) => unknown) | undefined,
    updateSubscription: undefined as ((id: string, data: unknown) => unknown) | undefined,
    deleteSubscription: undefined as ((id: string) => unknown) | undefined,
    deleteNodeClient: undefined as ((fp: string, name: string) => unknown) | undefined,
    listRemoteConfigs: undefined as (() => unknown) | undefined,
    loadRemoteConfig: undefined as ((fp: string, name: string) => unknown) | undefined,
    deleteRemoteConfig: undefined as ((fp: string, name: string) => unknown) | undefined,
    getAllSyncStatuses: undefined as (() => unknown) | undefined,
    generateServerConfig: undefined as (() => unknown) | undefined,
    generateSubscription: undefined as (() => unknown) | undefined,
    deploy: undefined as (() => unknown) | undefined,
    deployStatus: undefined as (() => unknown) | undefined,
    stopDeploy: undefined as (() => unknown) | undefined,
    restartDeploy: undefined as (() => unknown) | undefined,
    deployLogs: undefined as ((tail: number) => unknown) | undefined,
  }
  return { behavior }
})

const coreErr = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { statusCode: status, code })

vi.mock('@chorus/core', () => {
  class CloudClient {
    constructor(public cfg: Record<string, unknown>) {}
    async getProtocols(noRetry?: boolean) {
      return h.behavior.getProtocols ? h.behavior.getProtocols(noRetry) : [{ id: 'p1' }]
    }
    async getTemplates(role?: string) {
      return h.behavior.getTemplates ? h.behavior.getTemplates(role) : [{ id: 't1' }]
    }
    async getTemplatesWithCount(role?: string) {
      const templates = h.behavior.getTemplates ? h.behavior.getTemplates(role) : [{ id: 't1' }]
      return { templates, filtered_count: 0 }
    }
    async generateConfig(type: string, params: unknown) {
      return h.behavior.generateConfig
        ? h.behavior.generateConfig(type, params)
        : { server_config: {}, client_config: {} }
    }
    async checkTagAvailable(tag: string) {
      return h.behavior.checkTagAvailable ? h.behavior.checkTagAvailable(tag) : true
    }
    async getProtocolInstances() {
      return h.behavior.getProtocolInstances ? h.behavior.getProtocolInstances() : []
    }
    async registerNode(data: unknown) {
      h.behavior.calls.push('registerNode')
      if (h.behavior.registerNode) return h.behavior.registerNode(data)
    }
    async listSubscriptions() {
      return h.behavior.listSubscriptions ? h.behavior.listSubscriptions() : []
    }
    async getSubscription(id: string) {
      return h.behavior.getSubscription ? h.behavior.getSubscription(id) : null
    }
    async createSubscription(data: unknown) {
      return h.behavior.createSubscription
        ? h.behavior.createSubscription(data)
        : { id: 'sub-1', name: 's' }
    }
    async updateSubscription(id: string, data: unknown) {
      return h.behavior.updateSubscription
        ? h.behavior.updateSubscription(id, data)
        : { id, name: 's' }
    }
    async deleteSubscription(_id: string) {
      if (h.behavior.deleteSubscription) return h.behavior.deleteSubscription(_id)
    }
    async deleteNodeClient(fp: string, name: string) {
      h.behavior.calls.push(`deleteNodeClient:${fp}/${name}`)
      if (h.behavior.deleteNodeClient) return h.behavior.deleteNodeClient(fp, name)
    }
    async getNodeClients(_fp: string) {
      return []
    }
  }

  /** core-provider 用它读取 core 的持久 app config（singbox_version 快照）。 */
  class LocalStore {
    loadAppConfig(): Record<string, unknown> {
      return { ...h.behavior.appConfig }
    }
  }

  class ChorusCore {
    readonly cloud: CloudClient
    readonly store: {
      loadAppConfig: () => Record<string, unknown>
      getFingerprint: () => string
      loadRemoteConfig: (fp: string, name: string) => unknown
    }
    readonly configs: Record<string, unknown>

    constructor(appConfig?: Record<string, unknown>) {
      void appConfig
      this.cloud = new CloudClient(appConfig ?? {})
      this.store = {
        loadAppConfig: () => ({
          cloud_token: '',
          node_name: 'node-test',
          node_address: '',
          ...h.behavior.appConfig,
        }),
        getFingerprint: () => 'fp-test',
        loadRemoteConfig: (fp: string, name: string) =>
          h.behavior.loadRemoteConfig ? h.behavior.loadRemoteConfig(fp, name) : null,
      }
      const entries: Array<Record<string, unknown>> = []
      this.configs = {
        listAll: () => entries,
        add: (name: string, node: string, type: string, server: unknown, client: unknown, params: unknown) => {
          const entry = {
            name, node, type, enabled: true, deployed: false, synced: false,
            server_config: server, client_config: client, params,
          }
          entries.push(entry)
          return entry
        },
        get: (name: string) => {
          const entry = entries.find((e) => e.name === name)
          if (!entry) throw coreErr(404, 'CFG_NOT_FOUND', 'Configuration not found')
          return entry
        },
      }
    }

    getFingerprint(): string {
      return 'fp-test'
    }
    /** Mirrors the real core wrapper: render via cloud, tag passthrough. */
    async generateConfig(type: string, params: unknown) {
      return this.cloud.generateConfig(type, params)
    }
    getIdentity() {
      const cfg = this.store.loadAppConfig()
      return {
        fingerprint: 'fp-test',
        name: String(cfg.node_name || 'node-test'),
        address: String(cfg.node_address || ''),
      }
    }
    updateAppConfig(cfg: Record<string, unknown>) {
      Object.assign(h.behavior.appConfig, cfg)
      return h.behavior.appConfig
    }
    // core-D1: panel 面向的门面（测试桩同步真实 core 的 API 面）。
    getAppConfig(): Record<string, unknown> {
      return this.store.loadAppConfig()
    }
    getRemoteConfig(fp: string, name: string): unknown {
      return h.behavior.loadRemoteConfig ? h.behavior.loadRemoteConfig(fp, name) : null
    }
    listRemoteConfigs() {
      return h.behavior.listRemoteConfigs ? h.behavior.listRemoteConfigs() : []
    }
    async deleteRemoteConfig(fp: string, name: string) {
      // Mirrors real core: cloud delete first, then local cache cleanup.
      await this.cloud.deleteNodeClient(fp, name)
      if (h.behavior.deleteRemoteConfig) return h.behavior.deleteRemoteConfig(fp, name)
    }
    async getAllSyncStatuses() {
      return h.behavior.getAllSyncStatuses ? h.behavior.getAllSyncStatuses() : {}
    }
    async generateServerConfig() {
      return h.behavior.generateServerConfig ? h.behavior.generateServerConfig() : {}
    }
    async generateSubscription() {
      return h.behavior.generateSubscription ? h.behavior.generateSubscription() : {}
    }
    async deploy() {
      h.behavior.calls.push('deploy')
      if (h.behavior.deploy) return h.behavior.deploy()
    }
    async deployStatus() {
      return h.behavior.deployStatus ? h.behavior.deployStatus() : 'stopped'
    }
    async stopDeploy() {
      h.behavior.calls.push('stopDeploy')
      if (h.behavior.stopDeploy) return h.behavior.stopDeploy()
    }
    async restartDeploy() {
      if (h.behavior.restartDeploy) return h.behavior.restartDeploy()
    }
    async deployLogs(tail: number) {
      return h.behavior.deployLogs ? h.behavior.deployLogs(tail) : ''
    }
    async listSubscriptions() {
      return this.cloud.listSubscriptions()
    }
    async getSubscription(id: string) {
      return this.cloud.getSubscription(id)
    }
    async createSubscription(data: unknown) {
      return this.cloud.createSubscription(data)
    }
    async updateSubscription(id: string, data: unknown) {
      return this.cloud.updateSubscription(id, data)
    }
    async deleteSubscription(id: string) {
      return this.cloud.deleteSubscription(id)
    }
  }

  class SyncService {
    status = { lastFailures: h.behavior.lastFailures }
    trigger() {
      h.behavior.calls.push('sync')
    }
    async tick() {}
    dispose() {}
  }

  return { ChorusCore, SyncService, CloudClient, LocalStore }
})

const authed = (req: request.Test, cookie: string) => req.set('Cookie', cookie)

describe('cloud/deploy routes against a stubbed core', () => {
  let app: Application
  let cookie: string

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    app = await loadApp()
    cookie = await setupAdmin(app)
  })

  beforeEach(() => {
    h.behavior.calls.length = 0
    h.behavior.lastFailures.length = 0
    // Reset every overridable function hook to "use the default".
    for (const key of [
      'getProtocols', 'getTemplates', 'generateConfig', 'checkTagAvailable', 'getProtocolInstances',
      'registerNode', 'listSubscriptions', 'getSubscription', 'createSubscription',
      'updateSubscription', 'deleteSubscription', 'deleteNodeClient', 'listRemoteConfigs',
      'loadRemoteConfig', 'deleteRemoteConfig', 'getAllSyncStatuses', 'generateServerConfig',
      'generateSubscription', 'deploy', 'deployStatus', 'stopDeploy',
      'restartDeploy', 'deployLogs',
    ]) {
      ;(h.behavior as Record<string, unknown>)[key] = undefined
    }
  })

  // --- settings wiring ---

  it('does not trigger sync while no cloud token is configured', async () => {
    // First save in this file — panel config has no core_token yet.
    const res = await authed(request(app).post('/api/settings'), cookie)
      .send({ node_name: 'nn0' })
    expect(res.status).toBe(200)
    expect(h.behavior.calls).not.toContain('sync')
  })

  it('saves trimmed settings and mirrors them into core + triggers sync', async () => {
    const res = await authed(request(app).post('/api/settings'), cookie)
      .send({ core_url: ' http://cloud.example:9999/ ', node_name: 'nn', core_token: 'tok' })
    expect(res.status).toBe(200)
    expect(res.body.core_url).toBe('http://cloud.example:9999')
    expect(h.behavior.appConfig.cloud_url).toBe('http://cloud.example:9999')
    expect(h.behavior.appConfig.node_name).toBe('nn')
    // Sync only fires once a cloud token exists — an unconfigured panel must not sync.
    expect(h.behavior.calls).toContain('sync')
  })

  it('rejects invalid settings payloads', async () => {
    const res = await authed(request(app).post('/api/settings'), cookie)
      .send({ node_name: '' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('probes candidate cloud settings: reachable / unreachable / invalid body', async () => {
    const ok = await authed(request(app).post('/api/settings/test-candidate'), cookie)
      .send({ cloud_url: 'http://ok.example', cloud_token: 't' })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ reachable: true })

    h.behavior.getProtocols = () => {
      throw coreErr(503, 'CLOUD_UNREACHABLE', 'down')
    }
    const bad = await authed(request(app).post('/api/settings/test-candidate'), cookie)
      .send({ cloud_url: 'http://bad.example', cloud_token: 't' })
    expect(bad.status).toBe(200)
    expect(bad.body.reachable).toBe(false)
    expect(bad.body.error).toBe('down')

    const invalid = await authed(request(app).post('/api/settings/test-candidate'), cookie)
      .send({})
    expect(invalid.body.reachable).toBe(false)
    expect(invalid.body.error).toContain('required')
  })

  // --- init wizard ---

  it('reports wizard state before initialization', async () => {
    const res = await authed(request(app).get('/api/init'), cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ initialized: false, fingerprint: 'fp-test' })
  })

  it('validates the init payload', async () => {
    const res = await authed(request(app).post('/api/init'), cookie)
      .send({ cloud_url: 'http://c.example', cloud_token: 't' })
    expect(res.status).toBe(422)
  })

  it('fails loudly when cloud_required and the probe fails', async () => {
    h.behavior.getProtocols = () => {
      throw coreErr(503, 'CLOUD_UNREACHABLE', 'down')
    }
    const res = await authed(request(app).post('/api/init'), cookie)
      .send({ node_name: 'n1', cloud_url: 'http://c.example', cloud_token: 't' })
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('CLOUD_UNREACHABLE')
  })

  it('tolerates an unreachable cloud when cloud_required=false', async () => {
    h.behavior.getProtocols = () => {
      throw coreErr(503, 'CLOUD_UNREACHABLE', 'down')
    }
    const res = await authed(request(app).post('/api/init'), cookie)
      .send({ node_name: 'n1', cloud_url: 'http://c.example', cloud_token: 't', cloud_required: false })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ initialized: true, cloud_ok: false })
    expect(res.body.cloud_error).toBe('down')
  })

  it('completes the wizard: persists config, registers node, starts sync', async () => {
    h.behavior.getProtocols = undefined // probe succeeds
    const res = await authed(request(app).post('/api/init'), cookie)
      .send({ node_name: 'n2', node_address: 'a.example', cloud_url: 'http://c.example', cloud_token: 'tok' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ initialized: true, cloud_ok: true })
    expect(h.behavior.calls).toContain('registerNode')
    expect(h.behavior.calls).toContain('sync')

    const state = await authed(request(app).get('/api/init'), cookie)
    expect(state.body).toMatchObject({
      initialized: true,
      node_name: 'n2',
      node_address: 'a.example',
      cloud_token: 'set',
    })
  })

  // --- cloud proxy routes ---

  it('lists templates, mapping failures to 503 CLOUD_UNREACHABLE', async () => {
    const ok = await authed(request(app).get('/api/core/cloud/templates'), cookie)
    expect(ok.status).toBe(200)
    expect(ok.body.templates).toEqual([{ id: 't1' }])

    h.behavior.getTemplates = () => {
      throw coreErr(500, 'INTERNAL', 'kaboom')
    }
    const bad = await authed(request(app).get('/api/core/cloud/templates'), cookie)
    expect(bad.status).toBe(503)
    // The upstream code passes through; only the status is forced to 503.
    expect(bad.body.error.code).toBe('INTERNAL')
    expect(bad.body.error.message).toBe('kaboom')
  })

  it('passes the role query through to getTemplates', async () => {
    const seen: Array<string | undefined> = []
    h.behavior.getTemplates = (role) => {
      seen.push(role)
      return []
    }
    await authed(request(app).get('/api/core/cloud/templates?role=client'), cookie)
    expect(seen).toEqual(['client'])
  })

  it('generates a config, mapping validation and upstream errors', async () => {
    const missing = await authed(request(app).post('/api/core/cloud/generate'), cookie)
      .send({})
    expect(missing.status).toBe(422)

    const ok = await authed(request(app).post('/api/core/cloud/generate'), cookie)
      .send({ type: 'any-type', params: { a: 1 } })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ server_config: {}, client_config: {} })

    h.behavior.generateConfig = () => {
      throw coreErr(422, 'GEN_FAILED', 'bad params')
    }
    const bad = await authed(request(app).post('/api/core/cloud/generate'), cookie)
      .send({ type: 'any-type' })
    expect(bad.status).toBe(422)
    expect(bad.body.error.code).toBe('GEN_FAILED')
  })

  it('reports cloud connectivity via /cloud/status', async () => {
    const ok = await authed(request(app).get('/api/core/cloud/status'), cookie)
    expect(ok.body).toEqual({ connected: true })

    h.behavior.getProtocols = () => {
      throw new Error('nope')
    }
    const bad = await authed(request(app).get('/api/core/cloud/status'), cookie)
    expect(bad.status).toBe(200)
    expect(bad.body).toEqual({ connected: false })
  })

  it('exposes sync statuses and last failures', async () => {
    h.behavior.getAllSyncStatuses = () => ({ cfg1: 'pending_upload' })
    h.behavior.lastFailures.push({ name: 'cfg1', message: '409 PORT_CONFLICT' })
    const res = await authed(request(app).get('/api/core/cloud/sync-status'), cookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      statuses: { cfg1: 'pending_upload' },
      failures: [{ name: 'cfg1', message: '409 PORT_CONFLICT' }],
    })

    h.behavior.getAllSyncStatuses = () => {
      throw new Error('unreachable')
    }
    const bad = await authed(request(app).get('/api/core/cloud/sync-status'), cookie)
    expect(bad.status).toBe(502)
  })

  it('lists protocol instances or 503s', async () => {
    h.behavior.getProtocolInstances = () => [{ id: 'i1' }]
    const ok = await authed(request(app).get('/api/core/cloud/instances'), cookie)
    expect(ok.body.instances).toEqual([{ id: 'i1' }])

    h.behavior.getProtocolInstances = () => {
      throw new Error('x')
    }
    const bad = await authed(request(app).get('/api/core/cloud/instances'), cookie)
    expect(bad.status).toBe(503)
  })

  // --- subscriptions ---

  it('CRUDs subscriptions with envelope and status mapping', async () => {
    h.behavior.listSubscriptions = () => [{ id: 'sub-1' }]
    const list = await authed(request(app).get('/api/core/cloud/subscriptions'), cookie)
    expect(list.status).toBe(200)
    expect(list.body.subscriptions).toEqual([{ id: 'sub-1' }])

    h.behavior.listSubscriptions = () => {
      throw new Error('down')
    }
    const listBad = await authed(request(app).get('/api/core/cloud/subscriptions'), cookie)
    expect(listBad.status).toBe(503)

    const created = await authed(request(app).post('/api/core/cloud/subscriptions'), cookie)
      .send({ name: 's1', path: 's1', singboxVersion: '1.14.1' })
    expect(created.status).toBe(201)
    expect(created.body.subscription.id).toBe('sub-1')

    const invalid = await authed(request(app).post('/api/core/cloud/subscriptions'), cookie)
      .send({ path: 'x'.repeat(65), singboxVersion: '1.14.1' })
    expect(invalid.status).toBe(422)

    h.behavior.createSubscription = () => {
      throw coreErr(409, 'TAG_TAKEN', 'taken')
    }
    const createBad = await authed(request(app).post('/api/core/cloud/subscriptions'), cookie)
      .send({ name: 's1', singboxVersion: '1.14.1' })
    expect(createBad.status).toBe(502)
    expect(createBad.body.error.code).toBe('TAG_TAKEN')

    h.behavior.getSubscription = () => ({ id: 'sub-1' })
    const got = await authed(request(app).get('/api/core/cloud/subscriptions/sub-1'), cookie)
    expect(got.status).toBe(200)
    expect(got.body.subscription).toEqual({ id: 'sub-1' })

    // Default stub returns null → 404 mapping.
    h.behavior.getSubscription = undefined
    const missing = await authed(request(app).get('/api/core/cloud/subscriptions/gone'), cookie)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('SUB_NOT_FOUND')

    const updated = await authed(request(app).put('/api/core/cloud/subscriptions/sub-1'), cookie)
      .send({ active: false })
    expect(updated.status).toBe(200)
    expect(updated.body.subscription).toEqual({ id: 'sub-1', name: 's' })

    const deleted = await authed(request(app).delete('/api/core/cloud/subscriptions/sub-1'), cookie)
    expect(deleted.status).toBe(200)
    expect(deleted.body).toEqual({ success: true })

    h.behavior.deleteSubscription = () => {
      throw coreErr(502, 'CLOUD_DELETE_FAILED', 'down')
    }
    const delFail = await authed(request(app).delete('/api/core/cloud/subscriptions/sub-2'), cookie)
    expect(delFail.status).toBe(502)
    expect(delFail.body.error.code).toBe('CLOUD_DELETE_FAILED')
  })

  // --- remote configs ---

  it('lists / loads / deletes remote configs with correct 404 + sync wiring', async () => {
    h.behavior.listRemoteConfigs = () => [
      { name: 'r1', node_fingerprint: 'fp-other', client_config: {} },
    ]
    const list = await authed(request(app).get('/api/core/remote-configs'), cookie)
    expect(list.body.configs).toHaveLength(1)

    h.behavior.loadRemoteConfig = (fp, name) =>
      fp === 'fp-other' && name === 'r1' ? { name: 'r1' } : null
    const got = await authed(request(app).get('/api/core/remote-configs/fp-other/r1'), cookie)
    expect(got.status).toBe(200)
    const missing = await authed(request(app).get('/api/core/remote-configs/fp-other/gone'), cookie)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('CFG_NOT_FOUND')

    const del = await authed(request(app).delete('/api/core/remote-configs/fp-other/r1'), cookie)
    expect(del.status).toBe(200)
    expect(h.behavior.calls).toContain('deleteNodeClient:fp-other/r1')
    expect(h.behavior.calls).toContain('sync')

    h.behavior.deleteRemoteConfig = () => {
      throw coreErr(502, 'CLOUD_DELETE_FAILED', 'down')
    }
    const delBad = await authed(request(app).delete('/api/core/remote-configs/fp-other/r1'), cookie)
    expect(delBad.status).toBe(502)
    expect(delBad.body.error.code).toBe('CLOUD_DELETE_FAILED')
  })

  // --- deploy ---

  it('deploys and triggers sync; maps 500-class failures to 400', async () => {
    const ok = await authed(request(app).post('/api/core/deploy'), cookie)
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ status: 'deployed' })
    expect(h.behavior.calls).toContain('deploy')
    expect(h.behavior.calls).toContain('sync')

    h.behavior.deploy = () => {
      throw coreErr(500, 'DEPLOY_FAILED', 'docker exploded')
    }
    const bad = await authed(request(app).post('/api/core/deploy'), cookie)
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('DEPLOY_FAILED')
  })

  it('passes through 4xx deploy failures untouched', async () => {
    h.behavior.deploy = () => {
      throw coreErr(400, 'CFG_NONE_ENABLED', 'No enabled configs to deploy')
    }
    const res = await authed(request(app).post('/api/core/deploy'), cookie)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('CFG_NONE_ENABLED')
  })

  it('reports deploy status', async () => {
    const stopped = await authed(request(app).get('/api/core/deploy/status'), cookie)
    expect(stopped.body).toEqual({ status: 'stopped' })

    h.behavior.deployStatus = () => 'running'
    const running = await authed(request(app).get('/api/core/deploy/status'), cookie)
    expect(running.body).toEqual({ status: 'running' })

    h.behavior.deployStatus = () => {
      throw new Error('no docker')
    }
    const bad = await authed(request(app).get('/api/core/deploy/status'), cookie)
    expect(bad.status).toBe(503)
    expect(bad.body.error.code).toBe('DOCKER_UNAVAILABLE')
  })

  it('stops and restarts, remapping 500 to 503', async () => {
    const stop = await authed(request(app).post('/api/core/deploy/stop'), cookie)
    expect(stop.status).toBe(200)
    expect(stop.body).toEqual({ status: 'stopped' })
    expect(h.behavior.calls).toContain('stopDeploy')
    expect(h.behavior.calls).toContain('sync')

    h.behavior.stopDeploy = () => {
      throw coreErr(500, 'DOCKER_UNAVAILABLE', 'down')
    }
    const stopBad = await authed(request(app).post('/api/core/deploy/stop'), cookie)
    expect(stopBad.status).toBe(503)

    const restart = await authed(request(app).post('/api/core/deploy/restart'), cookie)
    expect(restart.status).toBe(200)
    expect(restart.body).toEqual({ status: 'restarted' })

    h.behavior.restartDeploy = () => {
      throw coreErr(500, 'DOCKER_UNAVAILABLE', 'down')
    }
    const restartBad = await authed(request(app).post('/api/core/deploy/restart'), cookie)
    expect(restartBad.status).toBe(503)
  })

  it('splits logs into lines', async () => {
    const empty = await authed(request(app).get('/api/core/logs'), cookie)
    expect(empty.body).toEqual({ lines: [] })

    h.behavior.deployLogs = (tail) => {
      expect(tail).toBe(100)
      return 'line1\nline2\n\n'
    }
    const some = await authed(request(app).get('/api/core/logs'), cookie)
    expect(some.body.lines).toEqual(['line1', 'line2'])

    h.behavior.deployLogs = () => {
      throw new Error('no docker')
    }
    const bad = await authed(request(app).get('/api/core/logs?tail=5'), cookie)
    expect(bad.status).toBe(503)
  })
})
