import request from 'supertest'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Application } from 'express'
import { makeTempHome, loadApp, setupAdmin } from './helpers.js'

/**
 * Full CRUD lifecycle over the real (local, cloud-free) ChorusCore storage:
 * create/read/update/delete, duplicate + port-conflict rejection, sync/deploy
 * flag invalidation on content change, enable/disable, prefill, check-port
 * and the /api/info dashboard counts. All state lives under a temp $HOME.
 */
describe('core configs: CRUD + port checks + info', () => {
  let app: Application
  let cookie: string

  const createBody = (over: Record<string, unknown> = {}) => ({
    name: 'cfg1',
    node: 'node-a',
    type: 'any-type',
    server_config: {},
    client_config: { tag: 'tag-1' },
    params: {},
    ...over,
  })

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    app = await loadApp()
    cookie = await setupAdmin(app)
  })

  it('creates a config and returns the full entry', async () => {
    const res = await request(app)
      .post('/api/core/configs')
      .set('Cookie', cookie)
      .send(createBody())
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      name: 'cfg1',
      node: 'node-a',
      type: 'any-type',
      enabled: true,
      synced: false,
      deployed: false,
    })
    expect(typeof res.body.content_hash).toBe('string')
  })

  it('lists configs', async () => {
    const res = await request(app).get('/api/core/configs').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.configs.map((c: { name: string }) => c.name)).toEqual(['cfg1'])
  })

  it('rejects a duplicate name with 409', async () => {
    const res = await request(app)
      .post('/api/core/configs')
      .set('Cookie', cookie)
      .send(createBody())
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CFG_DUPLICATE')
  })

  it('validates the create payload', async () => {
    const missing = await request(app)
      .post('/api/core/configs')
      .set('Cookie', cookie)
      .send({ node: 'n', type: 't' })
    expect(missing.status).toBe(422)
    expect(missing.body.error.code).toBe('VALIDATION_ERROR')

    const badConfig = await request(app)
      .post('/api/core/configs')
      .set('Cookie', cookie)
      .send(createBody({ name: 'cfg-bad', server_config: 'not-an-object' }))
    expect(badConfig.status).toBe(422)
  })

  it('rejects a new config that collides on listen port', async () => {
    const first = await request(app)
      .post('/api/core/configs')
      .set('Cookie', cookie)
      .send(createBody({ name: 'cfg2', server_config: { listen_port: 40001 } }))
    expect(first.status).toBe(201)

    const clash = await request(app)
      .post('/api/core/configs')
      .set('Cookie', cookie)
      .send(createBody({ name: 'cfg3', server_config: { listen_port: 40001 } }))
    expect(clash.status).toBe(409)
    expect(clash.body.error.code).toBe('CFG_PORT_CONFLICT')
    expect(clash.body.error.message).toContain('40001')
  })

  it('gets one config, 404s on unknown', async () => {
    const got = await request(app).get('/api/core/configs/cfg1').set('Cookie', cookie)
    expect(got.status).toBe(200)
    expect(got.body.name).toBe('cfg1')

    const missing = await request(app).get('/api/core/configs/nope').set('Cookie', cookie)
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('CFG_NOT_FOUND')
  })

  it('invalidates sync/deploy flags when content actually changes', async () => {
    const res = await request(app)
      .put('/api/core/configs/cfg1')
      .set('Cookie', cookie)
      .send({ params: { key: 'value' } })
    expect(res.status).toBe(200)
    expect(res.body.params).toEqual({ key: 'value' })
    expect(res.body.synced).toBe(false)
    expect(res.body.deployed).toBe(false)
  })

  it('validates the update payload', async () => {
    const res = await request(app)
      .put('/api/core/configs/cfg1')
      .set('Cookie', cookie)
      .send({ enabled: 'yes' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('disables and re-enables, 404s on unknown names', async () => {
    const off = await request(app).post('/api/core/configs/cfg1/disable').set('Cookie', cookie)
    expect(off.status).toBe(200)
    expect(off.body).toMatchObject({ enabled: false, deployed: false })

    const on = await request(app).post('/api/core/configs/cfg1/enable').set('Cookie', cookie)
    expect(on.status).toBe(200)
    expect(on.body.enabled).toBe(true)

    const missing = await request(app).post('/api/core/configs/ghost/enable').set('Cookie', cookie)
    expect(missing.status).toBe(404)
  })

  it('deletes a config, 404s afterwards and on unknown names', async () => {
    const del = await request(app).delete('/api/core/configs/cfg2').set('Cookie', cookie)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ status: 'deleted' })

    const gone = await request(app).get('/api/core/configs/cfg2').set('Cookie', cookie)
    expect(gone.status).toBe(404)

    const again = await request(app).delete('/api/core/configs/cfg2').set('Cookie', cookie)
    expect(again.status).toBe(404)
  })

  it('prefills the create form from node identity', async () => {
    const res = await request(app).get('/api/core/configs/prefill').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(typeof res.body.node_name).toBe('string')
    expect(res.body.node_name.length).toBeGreaterThan(0)
    expect(typeof res.body.node_address).toBe('string')
  })

  it('checks port availability and reports the conflicting config', async () => {
    const invalid = await request(app)
      .post('/api/core/configs/check-port')
      .set('Cookie', cookie)
      .send({ port: 70000 })
    expect(invalid.status).toBe(422)

    const free = await request(app)
      .post('/api/core/configs/check-port')
      .set('Cookie', cookie)
      .send({ port: 49999 })
    expect(free.status).toBe(200)
    expect(free.body).toEqual({ port: 49999, available: true, conflictWith: null })

    // cfg1 was updated with params but still has no port; recreate a port holder.
    await request(app)
      .post('/api/core/configs')
      .set('Cookie', cookie)
      .send(createBody({ name: 'porty', server_config: { listen_port: 41234 } }))
    const clash = await request(app)
      .post('/api/core/configs/check-port')
      .set('Cookie', cookie)
      .send({ port: 41234 })
    expect(clash.body).toEqual({ port: 41234, available: false, conflictWith: 'porty' })
  })

  it('reports data dir, config count and sync health on /api/info', async () => {
    const res = await request(app).get('/api/info').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.data_dir).toContain('.singchorus')
    expect(res.body.config_count).toBe(2) // cfg1 + porty
    expect(res.body.sync).toBeNull() // wizard not completed
    expect(typeof res.body.panel_version).toBe('string')
  })
})
