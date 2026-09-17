import request from 'supertest'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Application } from 'express'
import { makeTempHome, loadApp, setupAdmin } from './helpers.js'

describe('settings: save + invalidate chain', () => {
  let app: Application
  let cookie: string

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    app = await loadApp()
    cookie = await setupAdmin(app)
  })

  it('defaults to the built-in cloud URL when unset', async () => {
    const res = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.core_url).toBe('')
    expect(res.body.effective_cloud_url).toBe('http://localhost:8787')
  })

  it('persists trimmed settings and resolves the new effective URL', async () => {
    const saved = await request(app)
      .post('/api/settings')
      .set('Cookie', cookie)
      .send({ core_url: 'http://cloud.example:9999/', node_name: 'panel-node' })
    expect(saved.status).toBe(200)
    expect(saved.body.core_url).toBe('http://cloud.example:9999')

    const res = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(res.body.effective_cloud_url).toBe('http://cloud.example:9999')
    expect(res.body.node_name).toBe('panel-node')
  })

  it('rejects validation failures with the error envelope', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', cookie)
      .send({ node_name: '' })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('probes candidate cloud settings without persisting them', async () => {
    const before = await request(app).get('/api/settings').set('Cookie', cookie)

    const res = await request(app)
      .post('/api/settings/test-candidate')
      .set('Cookie', cookie)
      .send({ cloud_url: 'http://127.0.0.1:1', cloud_token: 'tok' })
    expect(res.status).toBe(200)
    expect(res.body.reachable).toBe(false)
    expect(typeof res.body.error).toBe('string')

    const after = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(after.body.core_url).toBe(before.body.core_url)
  })
})
