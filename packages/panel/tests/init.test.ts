import request from 'supertest'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Application } from 'express'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { makeTempHome, loadApp, setupAdmin } from './helpers.js'

// 版本目录用测试自建 stub 的字面量（不涉及种子数据，允许钉值）
const CATALOG = ['1.11.0', '1.10.0']

/**
 * Minimal cloud stub: the init route probes GET /api/protocols (reachability)
 * and GET /api/singbox-versions (catalog check); node registration and the
 * background sync's first round hit the catch-all 200.
 */
function startCloudStub(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      const url = req.url || ''
      if (url.startsWith('/api/singbox-versions')) {
        res.end(JSON.stringify({ versions: CATALOG }))
      } else if (url.startsWith('/api/protocols')) {
        res.end(JSON.stringify({ protocols: [] }))
      } else {
        res.end(JSON.stringify({ ok: true }))
      }
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

describe('init: sing-box version pinning', () => {
  let app: Application
  let cookie: string
  let stub: Server
  let stubUrl: string

  const basePayload = () => ({
    node_name: 'node-a',
    node_address: '10.0.0.1',
    cloud_url: stubUrl,
    cloud_token: 'tok',
  })

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    // server 模块必须在 HOME 隔离后动态导入（见 loadApp 的约定）
    app = await loadApp()
    cookie = await setupAdmin(app)
    stub = await startCloudStub()
    const addr = stub.address()
    if (typeof addr !== 'object' || !addr) throw new Error('stub not listening')
    stubUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    stub.close()
  })

  it('GET / exposes singbox_version for wizard preselection', async () => {
    const res = await request(app).get('/api/init').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.singbox_version).toBe('')
  })

  it('POST rejects a missing or malformed singbox_version with 422', async () => {
    const missing = await request(app).post('/api/init').set('Cookie', cookie).send(basePayload())
    expect(missing.status).toBe(422)
    expect(missing.body.error.code).toBe('VALIDATION_ERROR')

    const malformed = await request(app)
      .post('/api/init')
      .set('Cookie', cookie)
      .send({ ...basePayload(), singbox_version: 'not-semver' })
    expect(malformed.status).toBe(422)
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('POST rejects a version outside the cloud catalog with 400', async () => {
    const res = await request(app)
      .post('/api/init')
      .set('Cookie', cookie)
      .send({ ...basePayload(), singbox_version: '9.9.9' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('SBX_VERSION_NOT_OFFERED')
  })

  it('candidate-singbox-versions probes candidate settings without persisting', async () => {
    const bad = await request(app)
      .post('/api/settings/candidate-singbox-versions')
      .set('Cookie', cookie)
      .send({})
    expect(bad.status).toBe(200)
    expect(bad.body.versions).toEqual([])
    expect(typeof bad.body.error).toBe('string')

    const ok = await request(app)
      .post('/api/settings/candidate-singbox-versions')
      .set('Cookie', cookie)
      .send({ cloud_url: stubUrl, cloud_token: 'tok' })
    expect(ok.status).toBe(200)
    expect(ok.body.versions).toEqual(CATALOG)

    // 未持久化：settings 里的 cloud_url 不受影响
    const settings = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(settings.body.core_url).toBe('')
  })

  it('POST persists a catalog version into the core store', async () => {
    const res = await request(app)
      .post('/api/init')
      .set('Cookie', cookie)
      .send({ ...basePayload(), singbox_version: CATALOG[0] })
    expect(res.status).toBe(200)

    const init = await request(app).get('/api/init').set('Cookie', cookie)
    expect(init.body.singbox_version).toBe(CATALOG[0])
    expect(init.body.initialized).toBe(true)

    // settings 视角同源（core store）
    const settings = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(settings.body.singbox_version).toBe(CATALOG[0])
  })
})
