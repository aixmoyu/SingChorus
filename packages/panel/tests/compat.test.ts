import request from 'supertest'
import http from 'node:http'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createRequire } from 'node:module'
import type { Application } from 'express'
import { makeTempHome, loadApp, setupAdmin } from './helpers.js'

const require = createRequire(import.meta.url)

describe('compat: component version ranges', () => {
  let compat: typeof import('../server/compat.js')

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    // server 模块必须在 HOME 隔离后动态导入（core-provider 模块级 LocalStore）
    compat = await import('../server/compat.js')
  })

  it('当前 core 版本落在声明范围内（范围未随 core bump 更新时此测试变红）', async () => {
    const { CORE_VERSION } = await import('@chorus/core')
    expect(compat.checkCoreVersion(CORE_VERSION).ok).toBe(true)
  })

  it('checkCoreVersion：范围边界与非法输入', () => {
    expect(compat.checkCoreVersion('0.1.0')).toMatchObject({ ok: true })
    expect(compat.checkCoreVersion('0.1.9')).toMatchObject({ ok: true })
    expect(compat.checkCoreVersion('0.2.0').ok).toBe(false)
    expect(compat.checkCoreVersion('0.0.9').ok).toBe(false)
    expect(compat.checkCoreVersion('not-a-version').ok).toBe(false)
    expect(compat.checkCoreVersion('0.1.0').range).toBe(compat.SUPPORTED_CORE_RANGE)
  })

  it('isStrictCompat：仅 CHORUS_PANEL_STRICT_COMPAT=1 开启', () => {
    const prev = process.env.CHORUS_PANEL_STRICT_COMPAT
    try {
      delete process.env.CHORUS_PANEL_STRICT_COMPAT
      expect(compat.isStrictCompat()).toBe(false)
      process.env.CHORUS_PANEL_STRICT_COMPAT = '0'
      expect(compat.isStrictCompat()).toBe(false)
      process.env.CHORUS_PANEL_STRICT_COMPAT = '1'
      expect(compat.isStrictCompat()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.CHORUS_PANEL_STRICT_COMPAT
      else process.env.CHORUS_PANEL_STRICT_COMPAT = prev
    }
  })

  it('fetchCloudVersion：探测 /health 版本并按 cloud_url 失效缓存', async () => {
    const probe = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ status: 'ok', service: 'chorus-cloud', version: '0.1.0' }))
    })
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port

    const { updateConfig } = await import('../server/config.js')
    updateConfig({ core_url: `http://127.0.0.1:${port}` })
    compat.invalidateCloudVersion()

    expect(await compat.fetchCloudVersion()).toBe('0.1.0')
    expect(compat.checkCloudVersion('0.1.0')).toMatchObject({ ok: true, version: '0.1.0' })
    expect(compat.checkCloudVersion('0.2.0').ok).toBe(false)

    // 改 URL 后缓存失效 → 下一次探测新目标（这里改为不可达端口）
    updateConfig({ core_url: 'http://127.0.0.1:1' })
    compat.invalidateCloudVersion()
    expect(await compat.fetchCloudVersion()).toBe(null)

    probe.close()
  })

  it('fetchCloudVersion：cloud 返回缺 version 字段时按 unknown 处理', async () => {
    const probe = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ status: 'ok', service: 'chorus-cloud' }))
    })
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port

    const { updateConfig } = await import('../server/config.js')
    updateConfig({ core_url: `http://127.0.0.1:${port}` })
    compat.invalidateCloudVersion()

    expect(await compat.fetchCloudVersion()).toBe(null)
    probe.close()
  })

  it('fetchCloudVersion：cloud 未配置（core_url 为空）时返回 null 且不发起请求', async () => {
    const { updateConfig } = await import('../server/config.js')
    updateConfig({ core_url: '' })
    compat.invalidateCloudVersion()

    // "未配置" ≠ "不可达"：不应向默认回落地址（localhost:8787）发探测请求
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      expect(await compat.fetchCloudVersion()).toBe(null)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('info: /api/info 兼容性报告', () => {
  let app: Application
  let cookie: string

  beforeAll(async () => {
    process.env.HOME = await makeTempHome()
    app = await loadApp()
    cookie = await setupAdmin(app)
  })

  it('暴露三个组件版本与 compat 对象（钉死 panel_version 硬编码 bug）', async () => {
    const res = await request(app).get('/api/info').set('Cookie', cookie)
    expect(res.status).toBe(200)
    const panelPkgVersion = (require('../package.json') as { version: string }).version
    expect(res.body.panel_version).toBe(panelPkgVersion)
    expect(typeof res.body.core_version).toBe('string')
    expect(res.body.core_version.length).toBeGreaterThan(0)
    expect(res.body.compat.core).toMatchObject({ ok: true })
    expect(res.body.compat.strict).toBe(false)
  })

  it('cloud 不可达时 cloud_version=null 且 compat.cloud.ok=null（unknown 不告警）', async () => {
    const { updateConfig } = await import('../server/config.js')
    updateConfig({ core_url: 'http://127.0.0.1:1' })
    const { invalidateCloudVersion } = await import('../server/compat.js')
    invalidateCloudVersion()

    const res = await request(app).get('/api/info').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.cloud_version).toBe(null)
    expect(res.body.compat.cloud).toEqual({ version: null, ok: null, range: expect.any(String) })
  })
})
