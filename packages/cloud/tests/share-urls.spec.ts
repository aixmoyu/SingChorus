import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { resetSubscriptionCaches } from '../src/routes/subscriptions';
import { outboundToShareUrl } from '../src/engine/share-urls';
import { adminHeaders, api, createInstance, createNode, jsonBody, seed } from './helpers';

beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache();
  // loadConfigsFromD1 的 isolate 级 5min 缓存会把上一个用例的空结果带给
  // 下一个用例（D1 每 test 重置但模块态常驻）——必须一并清掉。
  resetSubscriptionCaches();
});

// --- 纯函数单元：sing-box outbound → 分享链接 ---

/** 前后缀断言（失败时打印完整链接，方便定位）。 */
function expectLink(url: string | null, prefix: string, suffix?: string): string {
  expect(url, `share url should exist`).toBeTruthy();
  const link = url as string;
  expect(link.startsWith(prefix), `${link} should start with ${prefix}`).toBe(true);
  if (suffix !== undefined) {
    expect(link.endsWith(suffix), `${link} should end with ${suffix}`).toBe(true);
  }
  return link;
}

describe('outboundToShareUrl (unit)', () => {
  it('vless + reality + utls → vless:// with security=reality / pbk / sid / fp / flow', () => {
    const url = expectLink(outboundToShareUrl({
      type: 'vless',
      tag: 'vless-tag',
      server: 'd.example.com',
      server_port: 443,
      uuid: '11111111-2222-3333-4444-555555555555',
      flow: 'xtls-rprx-vision',
      tls: {
        enabled: true,
        server_name: 'learn.microsoft.com',
        utls: { enabled: true, fingerprint: 'chrome' },
        reality: { enabled: true, public_key: 'PBK_VALUE', short_id: 'ABCD1234' },
      },
    }), 'vless://11111111-2222-3333-4444-555555555555@d.example.com:443?', '#vless-tag');
    const query = url.split('?')[1]!;
    expect(query).toContain('security=reality');
    expect(query).toContain('sni=learn.microsoft.com');
    expect(query).toContain('pbk=PBK_VALUE');
    expect(query).toContain('sid=ABCD1234');
    expect(query).toContain('fp=chrome');
    expect(query).toContain('flow=xtls-rprx-vision');
    expect(query).toContain('encryption=none');
  });

  it('hysteria2 with obfs → hysteria2://auth@host:port/?obfs=... (URI scheme 规范)', () => {
    const url = expectLink(outboundToShareUrl({
      type: 'hysteria2',
      tag: 'hy2-node',
      server: 'h.example.com',
      server_port: 8443,
      password: 'p@ss w&rd', // 特殊字符必须 percent-encode
      obfs: { type: 'salamander', password: 'obfs-pass' },
      tls: { enabled: true, server_name: 'h.example.com' },
    }), 'hysteria2://p%40ss%20w%26rd@h.example.com:8443/?', '#hy2-node');
    const query = url.split('?')[1]!;
    expect(query).toContain('sni=h.example.com');
    expect(query).toContain('obfs=salamander');
    expect(query).toContain('obfs-password=obfs-pass');
  });

  it('trojan → trojan://password@host:port with tls params', () => {
    const url = expectLink(outboundToShareUrl({
      type: 'trojan',
      tag: 't1',
      server: 't.example.com',
      server_port: 443,
      password: 'trojan-pass',
      tls: { enabled: true, server_name: 't.example.com' },
    }), 'trojan://trojan-pass@t.example.com:443?');
    expect(url).toContain('security=tls');
    expect(url).toContain('sni=t.example.com');
  });

  it('shadowsocks → ss://base64url(method:password) (SIP002)', () => {
    const url = expectLink(outboundToShareUrl({
      type: 'shadowsocks',
      tag: 'ss1',
      server: 's.example.com',
      server_port: 8388,
      method: 'aes-256-gcm',
      password: 'ss-pass',
    }), 'ss://', '#ss1');
    const userinfo = url.slice('ss://'.length).split('@')[0]!;
    expect(atob(userinfo.replace(/-/g, '+').replace(/_/g, '/'))).toBe('aes-256-gcm:ss-pass');
    expect(url).toContain('@s.example.com:8388');
  });

  it('vmess → vmess://base64(v2rayN JSON)', () => {
    const url = expectLink(outboundToShareUrl({
      type: 'vmess',
      tag: 'vm1',
      server: 'v.example.com',
      server_port: 443,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      tls: { enabled: true, server_name: 'v.example.com' },
      transport: { type: 'ws', path: '/wspath' },
    }), 'vmess://');
    const json = JSON.parse(atob(url.slice('vmess://'.length)));
    expect(json).toMatchObject({
      v: '2', add: 'v.example.com', port: '443',
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      net: 'ws', path: '/wspath', tls: 'tls', sni: 'v.example.com', ps: 'vm1',
    });
  });

  it('中文 tag/password → 不抛异常，vmess base64 内保留中文（UTF-8 安全）', () => {
    // 回归：btoa 只支持 Latin1，中文会抛 InvalidCharacterError，炸掉整个订阅交付
    const utf8FromB64 = (b: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
    const url = expectLink(outboundToShareUrl({
      type: 'vmess',
      tag: '日本节点-01',
      server: 'v.example.com',
      server_port: 443,
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }), 'vmess://');
    expect(JSON.parse(utf8FromB64(url.slice('vmess://'.length)))).toMatchObject({ ps: '日本节点-01' });

    const ss = expectLink(outboundToShareUrl({
      type: 'shadowsocks',
      tag: '中文密码',
      server: 's.example.com',
      server_port: 8388,
      method: 'aes-256-gcm',
      password: '密码123',
    }), 'ss://', `#${encodeURIComponent('中文密码')}`);
    const userinfo = ss.slice('ss://'.length).split('@')[0]!;
    expect(utf8FromB64(userinfo.replace(/-/g, '+').replace(/_/g, '/'))).toBe('aes-256-gcm:密码123');
  });

  it('无 TLS 的 vless → security=none 省略（纯裸协议链接）', () => {
    expect(outboundToShareUrl({
      type: 'vless', tag: 'plain', server: 'p.example.com', server_port: 80, uuid: 'u1',
    })).toBe('vless://u1@p.example.com:80?encryption=none#plain');
  });

  it('IPv6 server 加方括号', () => {
    expectLink(outboundToShareUrl({
      type: 'vless', tag: 'v6', server: '2001:db8::1', server_port: 443, uuid: 'u2',
    }), 'vless://u2@[2001:db8::1]:443');
  });

  it('不支持的协议 / 缺必要字段 → null（交付端跳过，不报错）', () => {
    expect(outboundToShareUrl({ type: 'direct', tag: 'direct' })).toBeNull();
    expect(outboundToShareUrl({ type: 'vless', server_port: 443, uuid: 'u' })).toBeNull();
    expect(outboundToShareUrl(null)).toBeNull();
  });
});

// --- 集成：url 型订阅 CRUD + 分享链接交付 ---

describe('Share-URL Subscriptions (type=url)', () => {
  it('POST type=url 创建成功：不填 singboxVersion，返回 singboxVersion=""', async () => {
    const res = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'URL Sub', path: 'url-sub', type: 'url' }),
    });
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.subscription.type).toBe('url');
    expect(body.subscription.singboxVersion).toBe('');
    expect(body.subscription.overallTemplateId).toBeNull();
  });

  it('POST type=url 携带 singboxVersion → 400（版本不适用于 url 型）', async () => {
    const res = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Bad', path: 'bad-url', type: 'url', singboxVersion: '1.12.0' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST type=singbox 缺 singboxVersion → 400（保持 §13.1 语义）', async () => {
    const res = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'NoV', path: 'no-version-2', type: 'singbox' }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT 修改 type → 400 SUB_TYPE_IMMUTABLE', async () => {
    const created = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Lock', path: 'lock-type', type: 'url' }),
    });
    const id = (await jsonBody(created)).subscription.id;
    const res = await api(`/api/subscriptions/${id}`, {
      method: 'PUT', headers: await adminHeaders(),
      body: JSON.stringify({ type: 'singbox' }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('SUB_TYPE_IMMUTABLE');
  });

  it('PUT 对 url 型更新 singboxVersion → 400 SUB_FIELD_NOT_APPLICABLE', async () => {
    const created = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'NA', path: 'na-fields', type: 'url' }),
    });
    const id = (await jsonBody(created)).subscription.id;
    const res = await api(`/api/subscriptions/${id}`, {
      method: 'PUT', headers: await adminHeaders(),
      body: JSON.stringify({ singboxVersion: '1.12.0' }),
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('SUB_FIELD_NOT_APPLICABLE');
  });

  it('url 型交付：text/plain，一行一条 vless:// / hysteria2://，无 compat 过滤', async () => {
    await seed();
    const node = await createNode();
    await createInstance('vless-reality-vision', node.id, { domain: 'v.example.com' });
    await createInstance('hysteria2', node.id, { domain: 'h.example.com' });

    const created = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Links', path: 'links-delivery', type: 'url' }),
    });
    const sub = (await jsonBody(created)).subscription;

    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    const vless = lines.find((l) => l.startsWith('vless://'))!;
    const hy2 = lines.find((l) => l.startsWith('hysteria2://'))!;
    // vless instance 渲染出 reality outbound（模板内定字段）
    expect(vless).toContain('security=reality');
    expect(vless).toContain('sni=learn.microsoft.com');
    expect(vless).toContain('flow=xtls-rprx-vision');
    expect(hy2).toContain('@h.example.com:');
  });

  it('url 型交付：token 缺失 → 401，active=0 → 403', async () => {
    const created = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Auth', path: 'url-auth', type: 'url' }),
    });
    const sub = (await jsonBody(created)).subscription;
    expect((await SELF.fetch(`http://localhost/s/${sub.path}`)).status).toBe(401);
    expect((await SELF.fetch(`http://localhost/s/${sub.path}?token=wrong`)).status).toBe(401);

    const off = await api(`/api/subscriptions/${sub.id}`, {
      method: 'PUT', headers: await adminHeaders(), body: JSON.stringify({ active: false }),
    });
    expect(off.status).toBe(200);
    expect((await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`)).status).toBe(403);
  });

  it('url 型交付：无 instance → 500 INSTANCES_MISSING；instance 全部转不出 → 500 SHARE_URL_NONE', async () => {
    const created = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'None', path: 'url-none', type: 'url' }),
    });
    const sub = (await jsonBody(created)).subscription;
    const empty = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(empty.status).toBe(500);
    expect((await empty.json() as any).error.code).toBe('INSTANCES_MISSING');

    // 客户端模板是 direct（不可转 URI）的协议 → 全部跳过 → SHARE_URL_NONE
    await api('/api/protocols', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({
        id: 'unconvertible-proto',
        name: 'Unconvertible',
        version: '1.0.0',
        serverTemplate: JSON.stringify({ type: 'direct', tag: 'srv' }),
        clientTemplate: JSON.stringify({ type: 'direct', tag: 'cli' }),
        params: JSON.stringify([{ name: 'domain', type: 'string', required: true }]),
      }),
    });
    const node = await createNode();
    await createInstance('unconvertible-proto', node.id, { domain: 'u.example.com' });
    const none = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(none.status).toBe(500);
    expect((await none.json() as any).error.code).toBe('SHARE_URL_NONE');
  });

  it('url 型交付兼容 client_configs fallback（同步上来的已部署配置也能转链接）', async () => {
    await api('/api/admin/seed', { method: 'POST', headers: await adminHeaders() });
    // 直接写一条 deployed+enabled 的 client_configs（模拟 panel 同步），交付端
    // 走 fallback 路径也必须能转出分享链接。
    const db = (env as any).DB;
    const { initializeDatabase } = await import('../src/db/schema');
    await initializeDatabase(db);
    await db.prepare(
      `INSERT INTO client_configs (fingerprint, name, config, server_config, params, protocol_type, enabled, deployed, created_at, updated_at)
       VALUES ('fp-share', 'hy2-sync', ?, '{}', '{}', 'hysteria2', 1, 1, datetime('now'), datetime('now'))`,
    ).bind(JSON.stringify({
      type: 'hysteria2', tag: 'hy2-sync', server: 'sync.example.com', server_port: 443,
      password: 'sync-pass', tls: { enabled: true, server_name: 'sync.example.com' },
    })).run();

    const created = await api('/api/subscriptions', {
      method: 'POST', headers: await adminHeaders(),
      body: JSON.stringify({ name: 'Sync', path: 'url-sync', type: 'url' }),
    });
    const sub = (await jsonBody(created)).subscription;
    const res = await SELF.fetch(`http://localhost/s/${sub.path}?token=${sub.token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hysteria2://sync-pass@sync.example.com:443/?sni=sync.example.com#hy2-sync');
  });
});
