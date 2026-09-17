import request from 'supertest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Application } from 'express'

export const ADMIN_PASSWORD = 'Sup3r$ecret9'
export const NEW_PASSWORD = 'N3w$ecret9'

/**
 * Isolate $HOME *before* the server modules load — config.ts and core's
 * LocalStore both derive their storage paths from it at import time.
 */
export async function makeTempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'panel-test-'))
}

/** Import the app after $HOME has been isolated (no port binding happens). */
export async function loadApp(): Promise<Application> {
  const { createApp } = await import('../server/app.js')
  return createApp()
}

/** Run the first-run setup and return the session cookie ("name=value"). */
export async function setupAdmin(app: Application, password: string = ADMIN_PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/setup').send({ password })
  if (res.status !== 200) {
    throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return extractCookie(res)
}

export function extractCookie(res: request.Response): string {
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (!raw) throw new Error('no set-cookie header in response')
  return raw.split(';')[0]
}
