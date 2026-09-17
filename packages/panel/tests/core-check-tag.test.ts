import request from 'supertest'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Application } from 'express'
import { makeTempHome, loadApp, setupAdmin } from './helpers.js'

/**
 * Reachable-by-accident cloud (e.g. a dev worker on localhost:8787) would flip
 * the "cloud unreachable" expectations. Pre-seed an address that always
 * refuses connections so the fallback path is deterministic.
 */
const UNREACHABLE_CLOUD = 'http://127.0.0.1:1'

describe('core configs: check-tag local/cloud checks', () => {
  let app: Application
  let cookie: string

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    app = await loadApp()
    cookie = await setupAdmin(app)
    const saved = await request(app)
      .post('/api/settings')
      .set('Cookie', cookie)
      .send({ core_url: UNREACHABLE_CLOUD })
    expect(saved.status).toBe(200)
  })

  it('requires a tag', async () => {
    const res = await request(app)
      .post('/api/core/configs/check-tag')
      .set('Cookie', cookie)
      .send({})
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('falls back to local_only availability when the cloud is unreachable', async () => {
    const res = await request(app)
      .post('/api/core/configs/check-tag')
      .set('Cookie', cookie)
      .send({ tag: 'fresh-tag' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ tag: 'fresh-tag', available: true, source: 'local_only' })
    expect(typeof res.body.detail).toBe('string')
  })

  it('detects local conflicts without consulting the cloud', async () => {
    const created = await request(app)
      .post('/api/core/configs')
      .set('Cookie', cookie)
      .send({
        name: 'cfg1',
        node: 'node-a',
        type: 'any-type',
        server_config: {},
        client_config: { tag: 'dup-tag' },
        params: {},
      })
    expect(created.status).toBe(201)

    const res = await request(app)
      .post('/api/core/configs/check-tag')
      .set('Cookie', cookie)
      .send({ tag: 'dup-tag' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ tag: 'dup-tag', available: false, source: 'local' })
  })
})
