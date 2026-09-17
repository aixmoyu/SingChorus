import request from 'supertest'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Application } from 'express'
import { ADMIN_PASSWORD, makeTempHome, loadApp, setupAdmin } from './helpers.js'

/**
 * Hardening middleware from app.ts: the CSRF origin check, the JSON 404 for
 * unknown /api paths, and the security headers. These run before auth, so
 * most assertions only need the app to exist.
 *
 * The origin check consults the CORS allow-list for cross-origin requests;
 * an allow-list must be configured here, otherwise dev mode reflects every
 * origin and cross-origin POSTs pass by design.
 */
const ALLOW_LIST = 'https://friendly.example'

describe('app hardening: origin check / 404 / headers', () => {
  let app: Application

  beforeAll(async () => {
    process.env.CHORUS_PANEL_CORS_ORIGIN = ALLOW_LIST
    process.env.HOME = await makeTempHome()
    app = await loadApp()
    await setupAdmin(app)
  })

  it('answers unknown /api paths with a JSON 404 envelope (not the SPA)', async () => {
    const res = await request(app).get('/api/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(res.type).toBe('application/json')
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('sends the hardening headers on every response', async () => {
    const res = await request(app).get('/api/auth/status')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('rejects a cross-origin state-changing request', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ password: 'x' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN')
  })

  it('rejects a malformed Origin header', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'not-a-url')
      .send({ password: 'x' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN_ORIGIN')
  })

  it('allows a same-origin POST (Origin host matches Host header)', async () => {
    // Passes the origin check, then fails auth downstream (401) — the point
    // is that it is NOT rejected by the origin middleware with 403.
    const res = await request(app)
      .post('/api/auth/login')
      .set('Host', 'panel.local')
      .set('Origin', 'http://panel.local')
      .send({ password: 'x' })
    expect(res.status).not.toBe(403)
  })

  it('allows a cross-origin request that is on the allow-list', async () => {
    // Passes the origin check (allow-listed), then fails auth downstream —
    // the point is that it is NOT rejected with 403.
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', ALLOW_LIST)
      .send({ password: 'x' })
    expect(res.status).not.toBe(403)
  })

  it('allows Origin-less requests (curl / server-to-server)', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'x' })
    expect(res.status).not.toBe(403)
  })

  it('lets safe methods through regardless of Origin', async () => {
    const res = await request(app)
      .get('/api/auth/status')
      .set('Origin', 'https://evil.example')
    expect(res.status).toBe(200)
  })
})
