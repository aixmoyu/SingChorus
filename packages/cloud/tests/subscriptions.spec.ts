import { SELF, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, jsonBody, seed } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache();
});

// P1: Helper to obtain JWT via /api/auth/login
let cachedJwt: string | null = null;

async function getJwt(): Promise<string> {
  if (cachedJwt) return cachedJwt;
  const authToken = (env as any).AUTH_TOKEN || 'dev-admin-token-change-in-production';
  const res = await SELF.fetch('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: authToken }),
  });
  const body = await res.json() as any;
  cachedJwt = body.accessToken;
  return cachedJwt!;
}

const AUTH = async () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${await getJwt()}`,
});

async function createSub(
  name: string, path: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch('http://localhost/api/subscriptions', {
    method: 'POST', headers: await AUTH(),
    // 默认绑定 1.14.1（种子模板 compat 范围 >=1.14.0 <1.16.0 的中值）
    body: JSON.stringify({ name, path, singboxVersion: '1.14.1', ...extra }),
  });
  return { status: res.status, body: await res.json() as any };
}

describe('Subscription Management', () => {
  it('POST /api/subscriptions creates a subscription', async () => {
    const { status, body } = await createSub('Test Sub', 'test-sub');
    expect(status).toBe(201);
    expect(body.subscription.name).toBe('Test Sub');
    expect(body.subscription.path).toBe('test-sub');
    expect(body.subscription.token).toBeDefined();
    expect(body.subscription.active).toBe(true);
  });

  it('POST rejects duplicate path', async () => {
    await createSub('Original', 'dup-path');
    const { status, body } = await createSub('Duplicate', 'dup-path');
    expect(status).toBe(409);
    expect(body.error.code).toBe('SUB_PATH_DUPLICATE');
  });

  it('GET /api/subscriptions lists subscriptions', async () => {
    const res = await SELF.fetch('http://localhost/api/subscriptions', { headers: await AUTH() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.subscriptions)).toBe(true);
  });

  it('GET /api/subscriptions/:id returns single subscription', async () => {
    const { body: created } = await createSub('Get Me', 'get-sub');
    const subId = created.subscription.id;

    const res = await SELF.fetch(`http://localhost/api/subscriptions/${subId}`, { headers: await AUTH() });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subscription.id).toBe(subId);
    expect(body.subscription.name).toBe('Get Me');
  });

  it('GET /api/subscriptions/:id returns 404 for unknown', async () => {
    const res = await SELF.fetch('http://localhost/api/subscriptions/nonexistent', { headers: await AUTH() });
    expect(res.status).toBe(404);
  });

  it('PUT /api/subscriptions/:id updates name and path', async () => {
    const { body: created } = await createSub('Original', 'orig-path');
    const subId = created.subscription.id;

    const res = await SELF.fetch(`http://localhost/api/subscriptions/${subId}`, {
      method: 'PUT', headers: await AUTH(),
      body: JSON.stringify({ name: 'Updated Sub', path: 'updated-sub' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subscription.name).toBe('Updated Sub');
    expect(body.subscription.path).toBe('updated-sub');
  });

  it('PUT with regenerateToken returns new token', async () => {
    const { body: created } = await createSub('Token Test', 'token-sub');
    const oldToken = created.subscription.token;

    const res = await SELF.fetch(`http://localhost/api/subscriptions/${created.subscription.id}`, {
      method: 'PUT', headers: await AUTH(),
      body: JSON.stringify({ regenerateToken: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.subscription.token).not.toBe(oldToken);
  });

  it('DELETE /api/subscriptions/:id removes subscription', async () => {
    const { body: created } = await createSub('Delete Me', 'delete-me');
    const subId = created.subscription.id;

    const delRes = await SELF.fetch(`http://localhost/api/subscriptions/${subId}`, {
      method: 'DELETE', headers: await AUTH(),
    });
    expect(delRes.status).toBe(200);

    const getRes = await SELF.fetch(`http://localhost/api/subscriptions/${subId}`, { headers: await AUTH() });
    expect(getRes.status).toBe(404);
  });

  it('rejects subscription operations without auth', async () => {
    const res = await SELF.fetch('http://localhost/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Auth', path: 'no-auth', singboxVersion: '1.14.1' }),
    });
    expect(res.status).toBe(401);
  });

  // --- v2（设计 §13.1）：订阅必绑版本 ---
  it('POST without singboxVersion → 400（版本必填）', async () => {
    const res = await SELF.fetch('http://localhost/api/subscriptions', {
      method: 'POST', headers: await AUTH(),
      body: JSON.stringify({ name: 'No Version', path: 'no-version' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST with malformed singboxVersion → 400', async () => {
    const { status } = await createSub('Bad Version', 'bad-version', { singboxVersion: 'latest' });
    expect(status).toBe(400);
  });

  it('PUT singboxVersion updates the binding; malformed → 400', async () => {
    const { body: created } = await createSub('Versioned', 'versioned-sub');
    const ok = await SELF.fetch(`http://localhost/api/subscriptions/${created.subscription.id}`, {
      method: 'PUT', headers: await AUTH(),
      body: JSON.stringify({ singboxVersion: '1.15.0' }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).subscription.singboxVersion).toBe('1.15.0');

    const bad = await SELF.fetch(`http://localhost/api/subscriptions/${created.subscription.id}`, {
      method: 'PUT', headers: await AUTH(),
      body: JSON.stringify({ singboxVersion: '1.12' }),
    });
    expect(bad.status).toBe(400);
  });
});

function subBody(raw: { status: number; body: any }): any {
  return raw.body.subscription;
}

describe('Subscription Delivery', () => {
  // With no active protocol instances anywhere, delivery has nothing to merge
  // and fails with INSTANCES_MISSING (client-configs fallback is empty too).
  it('returns 500 INSTANCES_MISSING when no active instances exist', async () => {
    const sub = subBody(await createSub('Empty', 'empty-sub'));
    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error.code).toBe('INSTANCES_MISSING');
  });

  // Core delivery contract: the response body IS the sing-box client config
  // itself (simple merge), never a `{ subscription: ... }` wrapper envelope —
  // consumers (sing-box) parse the raw config document.
  it('delivers the raw merged client config without a wrapper envelope', async () => {
    // Provision an active protocol instance so delivery has content.
    await SELF.fetch('http://localhost/api/protocols', {
      method: 'POST', headers: await AUTH(),
      body: JSON.stringify({
        id: 'delivery-proto',
        name: 'Delivery Proto',
        version: '1.0.0',
        serverTemplate: JSON.stringify({ type: 'vless', tag: 'delivery' }),
        clientTemplate: JSON.stringify({ type: 'vless', server: '{{ params.domain }}', tag: 'delivery' }),
        params: JSON.stringify([{ name: 'domain', type: 'string', required: true }]),
      }),
    });
    await SELF.fetch('http://localhost/api/nodes', {
      method: 'POST', headers: await AUTH(),
      body: JSON.stringify({ name: 'delivery-node' }),
    });
    const nodes = await SELF.fetch('http://localhost/api/nodes', { headers: await AUTH() });
    const nodeId = ((await nodes.json() as any).nodes[0] as any).id;
    const inst = await SELF.fetch('http://localhost/api/protocol-instances', {
      method: 'POST', headers: await AUTH(),
      body: JSON.stringify({ protocolId: 'delivery-proto', nodeId, params: { domain: 'd.example.com' } }),
    });
    expect(inst.status).toBe(201);

    const sub = subBody(await createSub('Contract', 'contract-sub'));
    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(res.status).toBe(200);
    const config = await res.json() as any;

    // Raw config document — no wrapper.
    expect(config.subscription).toBeUndefined();
    expect(config.version).toBe('1');
    expect(Array.isArray(config.outbounds)).toBe(true);
    const proxy = config.outbounds.find((o: any) => o.type === 'vless');
    expect(proxy.server).toBe('d.example.com');
    // Only the generated proxy outbounds + the direct fallback.
    expect(config.outbounds).toHaveLength(2);
    expect(config.outbounds[1]).toEqual({ type: 'direct', tag: 'direct' });
  });

  it('rejects reserved delivery paths (api/admin/health)', async () => {
    const { status, body } = await createSub('Reserved', 'health');
    expect(status).toBe(400);
    expect(body.error.code).toBe('SUB_PATH_RESERVED');
  });

  it('rejects paths that violate the slug format', async () => {
    const { status } = await createSub('Bad Path', 'Bad_Path');
    expect(status).toBe(400);
  });

  it('PUT to an already-taken path returns 409', async () => {
    await createSub('First', 'taken-path');
    const { body: second } = await createSub('Second', 'other-path');
    const res = await SELF.fetch(`http://localhost/api/subscriptions/${second.subscription.id}`, {
      method: 'PUT', headers: await AUTH(),
      body: JSON.stringify({ path: 'taken-path' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error.code).toBe('SUB_PATH_DUPLICATE');
  });

  it('returns 401 without token', async () => {
    const res = await SELF.fetch('http://localhost/s/some-path');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong token', async () => {
    const sub = subBody(await createSub('Wrong Token', 'wrong-token'));
    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=wrong-token`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for unknown path', async () => {
    const res = await SELF.fetch('http://localhost/s/nonexistent?token=foo');
    expect(res.status).toBe(404);
  });

  it('returns 403 for inactive subscription', async () => {
    const sub = subBody(await createSub('Inactive', 'inactive-sub', { active: false }));

    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(res.status).toBe(403);
  });
});

// --- v2（设计 §13）：订阅绑定版本的交付行为 ---
describe('Subscription Version Binding (delivery)', () => {
  /** 建节点 + 指定 compat 的协议 + instance，返回 instance 信息。 */
  async function provisionInstance(compat?: string): Promise<{ nodeId: string }> {
    const proto: Record<string, unknown> = {
      id: `proto-${compat ?? 'any'}`,
      name: 'Proto',
      version: '1.0.0',
      serverTemplate: JSON.stringify({ type: 'vless', tag: 'p' }),
      clientTemplate: JSON.stringify({ type: 'vless', server: '{{ params.domain }}', tag: 'p' }),
      params: JSON.stringify([{ name: 'domain', type: 'string', required: true }]),
    };
    if (compat !== undefined) proto.singboxCompat = compat;
    const pr = await SELF.fetch('http://localhost/api/protocols', {
      method: 'POST', headers: await AUTH(), body: JSON.stringify(proto),
    });
    expect(pr.status).toBe(201);

    await SELF.fetch('http://localhost/api/nodes', {
      method: 'POST', headers: await AUTH(),
      body: JSON.stringify({ name: `node-${compat ?? 'any'}` }),
    });
    const nodes = await SELF.fetch('http://localhost/api/nodes', { headers: await AUTH() });
    const nodeId = ((await nodes.json() as any).nodes[0] as any).id;
    const inst = await SELF.fetch('http://localhost/api/protocol-instances', {
      method: 'POST', headers: await AUTH(),
      body: JSON.stringify({ protocolId: proto.id, nodeId, params: { domain: 'd.example.com' } }),
    });
    expect(inst.status).toBe(201);
    return { nodeId };
  }

  it('绑定版本与 overall-client 模板冲突 → 400 SBX_VERSION_INCOMPATIBLE', async () => {
    await seed();
    await provisionInstance();
    const sub = subBody(await createSub('Incompat', 'incompat-delivery', {
      singboxVersion: '1.12.0', // 种子 client-default 要求 >=1.14.0
      overallTemplateId: 'client-default',
    }));
    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe('SBX_VERSION_INCOMPATIBLE');
  });

  it('协议不兼容的 instance 被排除（X-Sbx-Skipped-Instances），兼容的正常交付', async () => {
    await seed();
    // 旧协议（compat >=1.14.0）+ 新协议（无 compat = 任意版本）
    await provisionInstance('>=1.14.0');
    await provisionInstance(undefined);
    const sub = subBody(await createSub('Skip', 'skip-delivery', { singboxVersion: '1.12.0' }));
    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Sbx-Skipped-Instances')).toBe('1');
    const config = await res.json() as any;
    const outbounds = config.outbounds.filter((o: any) => o.type === 'vless');
    expect(outbounds).toHaveLength(1);
    expect(outbounds[0].server).toBe('d.example.com');
  });

  it('全部 instance 不兼容 → 400 SBX_NO_COMPATIBLE_INSTANCES', async () => {
    await seed();
    await provisionInstance('>=1.14.0');
    const sub = subBody(await createSub('All Skipped', 'all-skipped', { singboxVersion: '1.12.0' }));
    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error.code).toBe('SBX_NO_COMPATIBLE_INSTANCES');
  });

  it('消费者传 ?version= 不再影响交付（绑定即事实来源）', async () => {
    await seed();
    await provisionInstance(undefined);
    const sub = subBody(await createSub('Bound', 'bound-delivery'));
    // ?version=1.11.0 是 v1 的 opt-in 参数，v2 已废弃：交付不应因此报错
    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}&version=1.11.0`);
    expect(res.status).toBe(200);
  });

  it('GET /api/singbox-versions 聚合 docker 模板 enum 并降序返回', async () => {
    await seed();
    const res = await api('/api/singbox-versions', { headers: await adminHeaders() });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.versions).toEqual(['1.15.0', '1.14.1']);
  });
});
