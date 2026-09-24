import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, jsonBody, seed } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache(); // 30s shared template cache must not outlive the per-test D1 reset
});

// 种子模板的 compat 基线（docs/design/singbox-version-management.md §3.2，基于 sing-box 1.14.1）：
// 全部 5 个种子统一为 >=1.14.0 <1.16.0（hysteria2 · vless-reality-vision ·
// server-default · client-default · docker-default）。
// docker-default 的 singbox_version param default = "1.14.1"，enum = ["1.14.1"]；
// 镜像 tag 带 v 前缀（ghcr 实际 tag 为 v1.14.x），param 值为无 v 前缀的 semver。

describe('版本过滤（纵深防御第 1 层）', () => {
  it('GET /api/protocols?singbox_version=1.12.0 → 过滤掉 >=1.14.0 的协议并返回 filtered_count', async () => {
    await seed();
    const body = await jsonBody(
      await api('/api/protocols?singbox_version=1.12.0', { headers: await adminHeaders() }),
    );
    expect(body.protocols).toHaveLength(0);
    expect(body.filtered_count).toBe(2);
  });

  it('GET /api/protocols?singbox_version=1.14.1 → 兼容协议原样返回', async () => {
    await seed();
    const body = await jsonBody(
      await api('/api/protocols?singbox_version=1.14.1', { headers: await adminHeaders() }),
    );
    const ids = body.protocols.map((p: any) => p.id);
    expect(ids).toContain('vless-reality-vision');
    expect(ids).toContain('hysteria2');
    expect(body.filtered_count).toBe(0);
    // 响应行携带 compat 原文，UI 徽章用
    const vless = body.protocols.find((p: any) => p.id === 'vless-reality-vision');
    expect(vless.singbox_compat).toBe('>=1.14.0 <1.16.0');
  });

  it('GET /api/protocols 不带版本 → 原样返回不过滤', async () => {
    await seed();
    const body = await jsonBody(await api('/api/protocols', { headers: await adminHeaders() }));
    expect(body.protocols).toHaveLength(2);
    expect(body.filtered_count).toBeUndefined();
  });

  it('GET /api/templates?category=server&singbox_version=1.12.0 → server-default 被过滤', async () => {
    await seed();
    const body = await jsonBody(
      await api('/api/templates?category=server&singbox_version=1.12.0', { headers: await adminHeaders() }),
    );
    expect(body.templates).toHaveLength(0);
    expect(body.filtered_count).toBe(1);
  });

  it('非法版本格式 → 400 SBX_BAD_VERSION（protocols 与 templates 一致）', async () => {
    await seed();
    for (const path of ['/api/protocols?singbox_version=1.12', '/api/templates?category=server&singbox_version=1.12+build']) {
      const res = await api(path, { headers: await adminHeaders() });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error.code).toBe('SBX_BAD_VERSION');
    }
  });
});

describe('模板写路径 singboxCompat 校验（SBX_BAD_RANGE）', () => {
  it('POST /api/templates singboxCompat 非法 → 400 SBX_BAD_RANGE', async () => {
    const res = await api('/api/templates', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({
        id: 'bad-range',
        category: 'server',
        name: 'Bad Range',
        templateContent: '{}',
        singboxCompat: 'not-a-range>',
      }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('SBX_BAD_RANGE');
  });

  it('POST /api/protocols singboxCompat 非法 → 400 SBX_BAD_RANGE；合法 → 持久化', async () => {
    const base = {
      id: 'compat-proto',
      name: 'Compat Proto',
      serverTemplate: JSON.stringify({ type: 'vless', tag: '{{ params.tag }}' }),
      clientTemplate: JSON.stringify({ type: 'vless', server: '{{ params.domain }}' }),
      params: JSON.stringify([{ name: 'tag', type: 'string', default: 't' }]),
    };
    const bad = await api('/api/protocols', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ ...base, singboxCompat: 'latest' }),
    });
    expect(bad.status).toBe(400);
    expect((await jsonBody(bad)).error.code).toBe('SBX_BAD_RANGE');

    const good = await jsonBody(
      await api('/api/protocols', {
        method: 'POST',
        headers: await adminHeaders(),
        body: JSON.stringify({ ...base, singboxCompat: '>=1.14.0 <1.16.0' }),
      }),
    );
    expect(good.protocol.singbox_compat).toBe('>=1.14.0 <1.16.0');
  });
});

describe('POST /api/render 版本强制校验（纵深防御第 2 层）', () => {
  it('singboxVersion 与协议 compat 冲突 → 400 SBX_VERSION_INCOMPATIBLE（附冲突详情）', async () => {
    await seed();
    const res = await api('/api/render', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'hysteria2', singboxVersion: '1.12.0', params: { domain: 'x.example.com', port: 8443 } }),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error.code).toBe('SBX_VERSION_INCOMPATIBLE');
    expect(body.error.conflicts).toEqual([
      { template: 'hysteria2', category: 'protocol', singbox_compat: '>=1.14.0 <1.16.0', version: '1.12.0' },
    ]);
  });

  it('singboxVersion 兼容 → 正常渲染', async () => {
    await seed();
    const res = await api('/api/render', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'vless-reality-vision', singboxVersion: '1.14.1', params: { domain: 'x.example.com', port: 443 } }),
    });
    expect(res.status).toBe(200);
  });

  it('singboxVersion 格式非法 → 400 SBX_BAD_VERSION', async () => {
    await seed();
    const res = await api('/api/render', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'hysteria2', singboxVersion: 'latest' }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('SBX_BAD_VERSION');
  });
});

describe('POST /api/render/deploy 版本注入与校验', () => {
  const makeInstances = (list: any[]) =>
    list.map((row: any) => ({
      id: row.id,
      protocolId: row.protocol_id,
      serverConfig: JSON.parse(row.server_config),
      clientConfig: JSON.parse(row.client_config),
    }));

  async function seededInstances() {
    await seed();
    const node = await (await import('./helpers')).createNode();
    const inst = await (await import('./helpers')).createInstance('hysteria2', node.id, {
      domain: 'deploy.example.com', port: 8443,
    });
    return makeInstances([inst]);
  }

  it('不传 singboxVersion → 生效版本回落 docker 模板 param default（1.14.1），响应带回版本与镜像', async () => {
    const instances = await seededInstances();
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances, serverOverallId: 'server-default', dockerOverallId: 'docker-default' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.singboxVersion).toBe('1.14.1');
    expect(body.singboxImage).toBe('ghcr.io/sagernet/sing-box:v1.14.1');
    expect(body.composeYaml).toContain('ghcr.io/sagernet/sing-box:v1.14.1');
  });

  it('显式 singboxVersion 在 enum 内 → 镜像 pin 到该版本', async () => {
    // 版本目录收缩后 enum 只有 1.14.1（= param default）；显式传入 enum 外
    // 的版本由 SBX_VERSION_NOT_OFFERED 拦截（render.spec 覆盖）。
    const instances = await seededInstances();
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances, singboxVersion: '1.14.1' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.singboxVersion).toBe('1.14.1');
    expect(body.composeYaml).toContain('ghcr.io/sagernet/sing-box:v1.14.1');
  });

  it('版本与全部种子模板冲突 → 400 SBX_VERSION_INCOMPATIBLE（列出全部冲突项）', async () => {
    const instances = await seededInstances();
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances, singboxVersion: '1.12.0' }),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error.code).toBe('SBX_VERSION_INCOMPATIBLE');
    const templates = body.error.conflicts.map((cf: any) => cf.template);
    // 1.12.0 低于全部种子的 >=1.14.0 下限：hysteria2 / server-default / docker-default 全部冲突
    expect(templates).toEqual(expect.arrayContaining(['hysteria2', 'server-default', 'docker-default']));
  });

  it('singboxVersion 格式非法 → 400 SBX_BAD_VERSION', async () => {
    const instances = await seededInstances();
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances, singboxVersion: '1.12' }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('SBX_BAD_VERSION');
  });
});
