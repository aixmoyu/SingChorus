import request from 'supertest'
import { describe, it, expect, beforeAll } from 'vitest'
import type { Application } from 'express'
import { ADMIN_PASSWORD, NEW_PASSWORD, makeTempHome, loadApp, extractCookie } from './helpers.js'

/**
 * Complements auth.test.ts (setup/lockout/token_version) with the full
 * login/logout lifecycle: first-run gate, missing/wrong password, duplicate
 * setup, password-change policy codes, unauthenticated access, cookie flags
 * and logout cookie clearing.
 *
 * Test order matters: the rate limiter state is module-level, and setup
 * changes config state, so tests run from first-run through teardown.
 */
describe('auth: login/logout lifecycle and cookie contract', () => {
  let app: Application

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    app = await loadApp()
  })

  it('rejects login during first run with a precise code', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: ADMIN_PASSWORD })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('first_run')
  })

  it('sets up admin and issues a dev-appropriate session cookie', async () => {
    const res = await request(app).post('/api/auth/setup').send({ password: ADMIN_PASSWORD })
    expect(res.status).toBe(200)

    const raw = extractCookie(res)
    expect(raw).toMatch(/^chorus_panel_token=/)
    const setCookie = String(res.headers['set-cookie'][0])
    expect(setCookie).toMatch(/HttpOnly/i)
    // NODE_ENV is "test" → dev branch: SameSite=Lax and no Secure flag.
    expect(setCookie).toMatch(/SameSite=Lax/i)
    expect(setCookie).not.toMatch(/Secure/i)
  })

  it('logs in with the correct password', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: ADMIN_PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(extractCookie(res)).toMatch(/^chorus_panel_token=/)
  })

  it('rejects login without a password', async () => {
    const res = await request(app).post('/api/auth/login').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('missing_password')
  })

  it('rejects a wrong password without locking out yet', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'nope' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('wrong_password')
  })

  it('refuses a second setup', async () => {
    const res = await request(app).post('/api/auth/setup').send({ password: ADMIN_PASSWORD })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('already_setup')
  })

  it('rejects unauthenticated access to every protected mount', async () => {
    for (const method of ['get', 'post'] as const) {
      for (const url of ['/api/core/configs', '/api/settings', '/api/info', '/api/init']) {
        const res = await request(app)[method](url)
        expect(res.status, `${method.toUpperCase()} ${url}`).toBe(401)
        expect(res.body.error.code).toBe('unauthorized')
      }
    }
  })

  it('surfaces password policy codes from change-password', async () => {
    const cookie = await login(app, ADMIN_PASSWORD)

    const wrongOld = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ old_password: 'not-it', new_password: NEW_PASSWORD })
    expect(wrongOld.status).toBe(401)
    expect(wrongOld.body.error.code).toBe('wrong_password')

    const tooShort = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ old_password: ADMIN_PASSWORD, new_password: 'short' })
    expect(tooShort.status).toBe(400)
    expect(tooShort.body.error.code).toBe('PASSWORD_TOO_SHORT')

    const tooWeak = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ old_password: ADMIN_PASSWORD, new_password: 'onlylowercase' })
    expect(tooWeak.status).toBe(400)
    expect(tooWeak.body.error.code).toBe('PASSWORD_TOO_WEAK')

    const missing = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ old_password: ADMIN_PASSWORD })
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('missing_fields')
  })

  it('changes the password and re-issues a valid session', async () => {
    const cookie = await login(app, ADMIN_PASSWORD)
    const changed = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ old_password: ADMIN_PASSWORD, new_password: NEW_PASSWORD })
    expect(changed.status).toBe(200)
    const fresh = extractCookie(changed)
    const status = await request(app).get('/api/auth/status').set('Cookie', fresh)
    expect(status.body.authenticated).toBe(true)
  })

  it('logs out by clearing the session cookie', async () => {
    const cookie = await login(app, NEW_PASSWORD)

    const anon = await request(app).post('/api/auth/logout')
    expect(anon.status).toBe(401)

    // Stateless JWT: logout instructs the browser to drop the cookie; it does
    // not revoke the token server-side (that is what token_version is for).
    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie)
    expect(out.status).toBe(200)
    const cleared = String(out.headers['set-cookie'][0])
    expect(cleared).toMatch(/chorus_panel_token=/)
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  })

  it('reports first_run=false and initialized=false after setup-only', async () => {
    const cookie = await login(app, NEW_PASSWORD)
    const res = await request(app).get('/api/auth/status').set('Cookie', cookie)
    expect(res.body).toMatchObject({ first_run: false, initialized: false })
  })
})

async function login(app: Application, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ password })
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return extractCookie(res)
}
