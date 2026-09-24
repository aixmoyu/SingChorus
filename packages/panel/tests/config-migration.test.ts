import request from 'supertest'
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Application } from 'express'
import { makeTempHome, loadApp, setupAdmin } from './helpers.js'

describe('config migration: legacy "unset" sentinel', () => {
  let app: Application
  let home: string
  let cookie: string
  let DEFAULT_CLOUD_URL: string

  beforeAll(async () => {
    home = await makeTempHome()
    process.env.HOME = home
    // server 模块（含 core-provider 的模块级 LocalStore）必须在 HOME 隔离后
    // 动态导入 —— 与 loadApp 同理，否则会绑定到真实用户目录。
    ;({ DEFAULT_CLOUD_URL } = await import('../server/core-provider.js'))
    // Pre-seed a config carrying the historical sentinel value.
    const dir = path.join(home, '.singchorus', 'panel')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ core_url: 'http://127.0.0.1:8080' }),
      'utf-8',
    )
    app = await loadApp()
    cookie = await setupAdmin(app)
  })

  it('collapses the sentinel to "" on first read and persists it', async () => {
    const res = await request(app).get('/api/settings').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.core_url).toBe('')
    expect(res.body.effective_cloud_url).toBe(DEFAULT_CLOUD_URL)

    const raw = JSON.parse(
      await readFile(path.join(home, '.singchorus', 'panel', 'config.json'), 'utf-8'),
    )
    expect(raw.core_url).toBe('')
  })
})
