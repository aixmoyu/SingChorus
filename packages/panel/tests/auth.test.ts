import request from 'supertest'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Application } from 'express'
import { ADMIN_PASSWORD, NEW_PASSWORD, makeTempHome, loadApp, setupAdmin, extractCookie } from './helpers.js'

describe('auth: setup / lockout / token_version', () => {
  let app: Application
  let cookieA: string
  let cookieB: string

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    app = await loadApp()
  })

  it('rejects weak passwords with the error envelope (before setup)', async () => {
    const res = await request(app).post('/api/auth/setup').send({ password: 'short' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_password')
  })

  it('sets up admin and reports authenticated state', async () => {
    cookieA = await setupAdmin(app)
    const res = await request(app).get('/api/auth/status').set('Cookie', cookieA)
    expect(res.status).toBe(200)
    expect(res.body.first_run).toBe(false)
    expect(res.body.authenticated).toBe(true)
  })

  it('locks out after 5 failed logins, even with the correct password', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/api/auth/login').send({ password: 'wrong-password' })
      expect(res.status).toBe(401)
      expect(res.body.error.code).toBe('wrong_password')
    }
    const locked = await request(app).post('/api/auth/login').send({ password: ADMIN_PASSWORD })
    expect(locked.status).toBe(429)
    expect(locked.body.error.code).toBe('too_many_attempts')
  })

  it('invalidates old tokens after a password change (token_version)', async () => {
    const wrong = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookieA)
      .send({ old_password: 'nope', new_password: NEW_PASSWORD })
    expect(wrong.status).toBe(401)

    const changed = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookieA)
      .send({ old_password: ADMIN_PASSWORD, new_password: NEW_PASSWORD })
    expect(changed.status).toBe(200)
    cookieB = extractCookie(changed)

    // The old session cookie must no longer authenticate (ver mismatch).
    const oldAuth = await request(app).get('/api/auth/status').set('Cookie', cookieA)
    expect(oldAuth.body.authenticated).toBe(false)

    const newAuth = await request(app).get('/api/auth/status').set('Cookie', cookieB)
    expect(newAuth.body.authenticated).toBe(true)
  })
})
