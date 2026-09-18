import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { resetRegistryCache } from '../src/engine/registry';
import { adminHeaders, api, createInstance, createNode, createSimpleProtocol, jsonBody } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
  resetRegistryCache(); // 30s shared template cache must not outlive the per-test D1 reset
});

async function checkTag(tag: string): Promise<{ status: number; body: any }> {
  const res = await api(`/api/tags/check?tag=${encodeURIComponent(tag)}`, {
    headers: await adminHeaders(),
  });
  return { status: res.status, body: await jsonBody(res) };
}

describe('GET /api/tags/check', () => {
  it('requires auth', async () => {
    const res = await api('/api/tags/check?tag=some-tag');
    expect(res.status).toBe(401);
  });

  it('returns 400 TAG_REQUIRED without the tag query param', async () => {
    const res = await api('/api/tags/check', { headers: await adminHeaders() });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error.code).toBe('TAG_REQUIRED');
  });

  it('returns available:true for an unknown tag', async () => {
    const { status, body } = await checkTag('fresh-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.tag).toBe('fresh-tag');
  });

  it('detects tags claimed by a protocol instance via the indexed tag column', async () => {
    await createSimpleProtocol('tag-proto');
    const node = await createNode();
    await createInstance('tag-proto', node.id, { domain: 'x.test', tag: 'claimed-tag' });

    const { status, body } = await checkTag('claimed-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.source).toBe('protocol_instances');
  });

  it('detects tags claimed by synced client configs', async () => {
    const res = await api('/api/clients/fp-tag/conf-a', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ config: { tag: 'kv-tag' }, protocol_type: 'vless' }),
    });
    expect(res.status).toBe(201);

    const { status, body } = await checkTag('kv-tag');
    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.source).toBe('client_configs');
  });

  it('reports availability again after the claiming client config is deleted', async () => {
    await api('/api/clients/fp-tag/conf-b', {
      method: 'PUT',
      headers: await adminHeaders(),
      body: JSON.stringify({ config: { tag: 'releasable-tag' }, protocol_type: 'vless' }),
    });
    expect((await checkTag('releasable-tag')).body.available).toBe(false);

    await api('/api/clients/fp-tag/conf-b', {
      method: 'DELETE',
      headers: await adminHeaders(),
    });
    expect((await checkTag('releasable-tag')).body.available).toBe(true);
  });
});
