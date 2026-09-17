import { describe, expect, it } from 'vitest'
import { normalizeGenerateResponse, normalizeTemplate } from '@/stores/template'

/**
 * DEP-PANEL-002 — 云端契约兼容矩阵锁定。
 *
 * normalizeTemplate / normalizeGenerateResponse 是 panel 对 chorus-cloud
 * 命名漂移（camelCase ↔ snake_case、category ↔ role、overall-* 前缀）的
 * 归一层。这里锁定每个兼容分支：云端若收敛命名，须与 panel 同步更新。
 */

describe('normalizeTemplate — category/role 双命名', () => {
  it('cloud `category` 字段（统一模板表）映射到 panel role', () => {
    expect(normalizeTemplate({ category: 'protocol' }).role).toBe('protocol')
    expect(normalizeTemplate({ category: 'server' }).role).toBe('server')
    expect(normalizeTemplate({ category: 'client' }).role).toBe('client')
    expect(normalizeTemplate({ category: 'docker' }).role).toBe('docker')
  })

  it('legacy `role` 字段仍被接受（category 缺失时回退）', () => {
    expect(normalizeTemplate({ role: 'docker' }).role).toBe('docker')
  })

  it('overall-* 前缀收敛到 server/client/docker role', () => {
    expect(normalizeTemplate({ category: 'overall-server' }).role).toBe('server')
    expect(normalizeTemplate({ category: 'overall-client' }).role).toBe('client')
    expect(normalizeTemplate({ category: 'overall-docker' }).role).toBe('docker')
  })

  it('未知 category 回退 protocol role', () => {
    expect(normalizeTemplate({ category: 'whatever' }).role).toBe('protocol')
  })
})

describe('normalizeTemplate — schema 模板键双命名', () => {
  it('snake_case schema（panel 期望形态）原样归一', () => {
    const t = normalizeTemplate({
      id: 'p1',
      name: 'P1',
      category: 'protocol',
      params: [{ name: 'domain', type: 'string', required: true }],
      schema: {
        server_template: { type: 'vless' },
        client_template: { type: 'vless', server: '{{ params.domain }}' },
      },
    })
    expect(t.schema.params).toHaveLength(1)
    expect(t.schema.server_template).toEqual({ type: 'vless' })
    expect(t.schema.client_template).toEqual({ type: 'vless', server: '{{ params.domain }}' })
  })

  it('camelCase serverTemplate/clientTemplate（cloud TS 源形态）归一到 snake_case', () => {
    const t = normalizeTemplate({
      id: 'p2',
      name: 'P2',
      category: 'protocol',
      schema: {
        serverTemplate: { type: 'hy2' },
        clientTemplate: { type: 'hy2' },
      },
    })
    expect(t.schema.server_template).toEqual({ type: 'hy2' })
    expect(t.schema.client_template).toEqual({ type: 'hy2' })
  })

  it('params 以 JSON 字符串形态返回时自动解析（legacy 存量数据）', () => {
    const t = normalizeTemplate({
      id: 'p3',
      name: 'P3',
      category: 'protocol',
      params: JSON.stringify([{ name: 'port', type: 'number', required: false }]),
    })
    expect(t.schema.params).toEqual([{ name: 'port', type: 'number', required: false }])
  })

  it('schema.params 与顶层 params 同时存在时顶层优先', () => {
    const top = [{ name: 'a', type: 'string', required: false }]
    const t = normalizeTemplate({
      id: 'p4',
      name: 'P4',
      category: 'protocol',
      params: top,
      schema: { params: [{ name: 'b', type: 'string', required: false }] },
    })
    expect(t.schema.params).toEqual(top)
  })

  it('type 缺失时回退 id', () => {
    const t = normalizeTemplate({ id: 'fallback-id', name: 'P5', category: 'protocol' })
    expect(t.type).toBe('fallback-id')
  })
})

describe('normalizeGenerateResponse — 渲染响应双命名', () => {
  it('camelCase serverConfig/clientConfig（cloud 现行契约）归一到 snake_case', () => {
    const r = normalizeGenerateResponse({
      serverConfig: { type: 'vless', inbounds: [] },
      clientConfig: { type: 'vless', server: 'example.com' },
    })
    expect(r.server_config).toEqual({ type: 'vless', inbounds: [] })
    expect(r.client_config).toEqual({ type: 'vless', server: 'example.com' })
  })

  it('snake_case server_config/client_config（legacy）同样被接受', () => {
    const r = normalizeGenerateResponse({
      server_config: { type: 'hy2' },
      client_config: { type: 'hy2' },
    })
    expect(r.server_config).toEqual({ type: 'hy2' })
    expect(r.client_config).toEqual({ type: 'hy2' })
  })

  it('两种命名都缺失时回退空对象（不抛错）', () => {
    const r = normalizeGenerateResponse({})
    expect(r.server_config).toEqual({})
    expect(r.client_config).toEqual({})
  })
})
