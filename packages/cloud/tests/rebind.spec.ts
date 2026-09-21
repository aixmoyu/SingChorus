import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseInitCache } from '../src/db/schema';
import { adminHeaders, api, jsonBody } from './helpers';

// D1 storage is reset per test while module state persists in the single
// worker — drop the init memo so every test re-runs the schema setup.
beforeEach(() => {
  resetDatabaseInitCache();
});

async function register(fingerprint: string, name: string) {
  const res = await api('/api/nodes/register', {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify({ fingerprint, name }),
  });
  return res.status;
}

async function rebind(from: string, to: string) {
  const res = await api('/api/nodes/rebind', {
    method: 'POST',
    headers: await adminHeaders(),
    body: JSON.stringify({ from, to }),
  });
  return { status: res.status, body: await jsonBody(res) };
}

async function putClient(fingerprint: string, name: string, config: Record<string, unknown>) {
  const res = await api(`/api/clients/${fingerprint}/${name}`, {
    method: 'PUT',
    headers: await adminHeaders(),
    body: JSON.stringify({ config, protocol_type: 'vless' }),
  });
  expect(res.status).toBe(201);
}

describe('Nodes rebind — reinstall recovery', () => {
  it('moves client_configs and the node row to the target fingerprint (no target row yet)', async () => {
    await register('fp-old-node', 'old');
    await putClient('fp-old-node', 'cfg-1', { tag: 'rb-1' });

    const { status, body } = await rebind('fp-old-node', 'fp-new-node');
    expect(status).toBe(200);
    expect(body.moved_configs).toBe(1);

    // Configs are now owned by the new fingerprint (full pull works).
    const pulled = await api('/api/clients/fp-new-node', { headers: await adminHeaders() });
    expect(pulled.status).toBe(200);
    const clients = (await jsonBody(pulled)).clients;
    expect(clients.map((c: Record<string, unknown>) => c.name)).toEqual(['cfg-1']);

    // Old identity is gone entirely: no node row, no configs.
    const oldPull = await api('/api/clients/fp-old-node', { headers: await adminHeaders() });
    expect(oldPull.status).toBe(404);
  });

  it('target row already exists (reinstalled node heartbeated first) → keep it, drop the source row', async () => {
    await register('fp-old-node', 'old');
    await register('fp-new-node', 'new');
    await putClient('fp-old-node', 'cfg-1', { tag: 'rb-2' });

    const { status } = await rebind('fp-old-node', 'fp-new-node');
    expect(status).toBe(200);

    const nodesRes = await api('/api/nodes', { headers: await adminHeaders() });
    const fps = ((await jsonBody(nodesRes)).nodes as Array<Record<string, unknown>>)
      .map((n) => n.fingerprint);
    expect(fps).toContain('fp-new-node');
    expect(fps).not.toContain('fp-old-node');
  });

  it('404 for unknown source; 409 when the target already owns configs; 400 when from === to', async () => {
    expect((await rebind('fp-ghost-node', 'fp-other-node')).status).toBe(404);

    await register('fp-src-node', 'src');
    await putClient('fp-dst-node', 'taken', { tag: 'rb-3' });
    const conflict = await rebind('fp-src-node', 'fp-dst-node');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('TARGET_FINGERPRINT_IN_USE');

    await register('fp-same-node', 'same');
    const same = await rebind('fp-same-node', 'fp-same-node');
    expect(same.status).toBe(400);
    expect(same.body.error.code).toBe('BAD_FINGERPRINT');
  });
});
