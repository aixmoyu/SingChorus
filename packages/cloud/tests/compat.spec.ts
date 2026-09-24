import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, jsonBody, seed } from './helpers';
import {
  DOCKER_DEFAULT_VERSION,
  SEED_CATEGORY_IDS,
  SEED_COMPAT,
  SEED_PROTOCOL_IDS,
  VERSION_BELOW_ALL_SEEDS,
  VERSION_IN_ALL_SEEDS,
  expectImageFor,
} from './seed-baseline';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache(); // 30s shared template cache must not outlive the per-test D1 reset
});

// 种子模板的 compat 范围、版本目录、镜像 tag 一律从模板 config.json 推导
// （见 seed-baseline.ts）——sing-box 版本目录会随迭代演进，测试钉机制不钉数据。

describe('版本过滤（纵深防御第 1 层）', () => {
  it('GET /api/protocols?singbox_version=<低于全部下限> → 协议全被过滤并返回 filtered_count', async () => {
    await seed();
    const body = await jsonBody(
      await api(`/api/protocols?singbox_version=${VERSION_BELOW_ALL_SEEDS}`, { headers: await adminHeaders() }),
    );
    expect(body.protocols).toHaveLength(0);
    expect(body.filtered_count).toBe(SEED_PROTOCOL_IDS.length);
  });

  it('GET /api/protocols?singbox_version=<目录内且满足全部种子> → 兼容协议原样返回', async () => {
    await seed();
    const body = await jsonBody(
      await api(`/api/protocols?singbox_version=${VERSION_IN_ALL_SEEDS}`, { headers: await adminHeaders() }),
    );
    const ids = body.protocols.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining(SEED_PROTOCOL_IDS));
    expect(body.filtered_count).toBe(0);
    expect(body.protocols).toHaveLength(SEED_PROTOCOL_IDS.length);
    // 响应行携带 compat 原文，UI 徽章用
    const vless = body.protocols.find((p: any) => p.id === 'vless-reality-vision');
    expect(vless.singbox_compat).toBe(SEED_COMPAT['vless-reality-vision']);
  });

  it('GET /api/protocols 不带版本 → 原样返回不过滤', async () => {
    await seed();
    const body = await jsonBody(await api('/api/protocols', { headers: await adminHeaders() }));
    expect(body.protocols).toHaveLength(SEED_PROTOCOL_IDS.length);
    expect(body.filtered_count).toBeUndefined();
  });

  it('GET /api/templates?category=server&singbox_version=<低于全部下限> → server-default 被过滤', async () => {
    await seed();
    const body = await jsonBody(
      await api(`/api/templates?category=server&singbox_version=${VERSION_BELOW_ALL_SEEDS}`, { headers: await adminHeaders() }),
    );
    // 钉机制：server 类种子全部被过滤掉（不钉具体条数，种子集可扩展）
    expect(body.templates.some((t: any) => SEED_CATEGORY_IDS('overall-server').includes(t.id))).toBe(false);
    expect(body.filtered_count).toBe(SEED_CATEGORY_IDS('overall-server').length);
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
      body: JSON.stringify({ protocolId: 'hysteria2', singboxVersion: VERSION_BELOW_ALL_SEEDS, params: { domain: 'x.example.com', port: 8443 } }),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error.code).toBe('SBX_VERSION_INCOMPATIBLE');
    expect(body.error.conflicts).toEqual([
      { template: 'hysteria2', category: 'protocol', singbox_compat: SEED_COMPAT.hysteria2, version: VERSION_BELOW_ALL_SEEDS },
    ]);
  });

  it('singboxVersion 兼容 → 正常渲染', async () => {
    await seed();
    const res = await api('/api/render', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ protocolId: 'vless-reality-vision', singboxVersion: VERSION_IN_ALL_SEEDS, params: { domain: 'x.example.com', port: 443 } }),
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

  it('不传 singboxVersion → 生效版本回落 docker 模板 param default，响应带回版本与镜像', async () => {
    const instances = await seededInstances();
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances, serverOverallId: 'server-default', dockerOverallId: 'docker-default' }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.singboxVersion).toBe(DOCKER_DEFAULT_VERSION);
    expect(body.singboxImage).toEqual(expect.stringContaining(expectImageFor(DOCKER_DEFAULT_VERSION)));
    expect(body.composeYaml).toContain(expectImageFor(DOCKER_DEFAULT_VERSION));
  });

  it('显式 singboxVersion 在目录内 → 镜像 pin 到该版本', async () => {
    // 目录外的显式版本由 SBX_VERSION_NOT_OFFERED 拦截（render.spec 覆盖）。
    const instances = await seededInstances();
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances, singboxVersion: VERSION_IN_ALL_SEEDS }),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.singboxVersion).toBe(VERSION_IN_ALL_SEEDS);
    expect(body.composeYaml).toContain(expectImageFor(VERSION_IN_ALL_SEEDS));
  });

  it('版本低于全部种子 compat → 400 SBX_VERSION_INCOMPATIBLE（列出全部冲突项）', async () => {
    const instances = await seededInstances();
    const res = await api('/api/render/deploy', {
      method: 'POST',
      headers: await adminHeaders(),
      body: JSON.stringify({ instances, singboxVersion: VERSION_BELOW_ALL_SEEDS }),
    });
    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.error.code).toBe('SBX_VERSION_INCOMPATIBLE');
    const templates = body.error.conflicts.map((cf: any) => cf.template);
    // 输入版本低于全部种子下限：hysteria2 / server-default / docker-default 全部冲突
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
