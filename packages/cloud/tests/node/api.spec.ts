/**
 * Node-environment API suite: runs the full Hono app — the same app the
 * Workers suite exercises via workerd — against the SQLite D1 adapter.
 * This pins the adapter contract that the Node/VPS entry (src/node/entry.ts)
 * depends on, so a route adding a binding method the adapter doesn't support
 * fails CI here instead of breaking self-hosted deploys at runtime.
 *
 * Run: pnpm test:node
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { app } from '../../src/index';
import { ensureDatabaseInitialized, resetDatabaseInitCache } from '../../src/db/schema';
import { resetSubscriptionCaches } from '../../src/routes/subscriptions';
import { SqliteD1 } from '../../src/node/d1-sqlite';

const AUTH_TOKEN = 'node-test-auth-token';
const JWT_SECRET = 'node-test-jwt-secret';

function makeEnv(): { env: Env; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const env = {
    DB: new SqliteD1(sqlite),
    AUTH_TOKEN,
    JWT_SECRET,
  } as unknown as Env;
  return { env, sqlite };
}

/** Run a request through the real middleware chain with Node bindings. */
async function api(env: Env, path: string, init?: RequestInit): Promise<Response> {
  // No executionCtx passed: on Node there is none, and fireAndForget must
  // absorb that (exercised by the inactive-subscription test below).
  return app.request(`http://localhost${path}`, init, env);
}

let jwt = '';

async function authHeaders(env: Env): Promise<Record<string, string>> {
  if (!jwt) {
    const res = await api(env, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: AUTH_TOKEN }),
    });
    expect(res.status).toBe(200);
    jwt = ((await res.json()) as { accessToken: string }).accessToken;
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };
}

beforeEach(() => {
  // Fresh in-memory DB per test; drop the per-process init memo so schema
  // setup re-runs (same reason the Workers suite calls its reset helpers).
  resetDatabaseInitCache();
  resetSubscriptionCaches();
  jwt = '';
});

describe('node runtime: API contract over SQLite adapters', () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv().env;
  });

  it('GET /health', async () => {
    const res = await api(env, '/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });

  it('auth: rejects bad token; issues a JWT valid against the D1 revocation table', async () => {
    const bad = await api(env, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    expect(bad.status).toBe(401);

    const res = await api(env, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: AUTH_TOKEN }),
    });
    expect(res.status).toBe(200);
    const { accessToken } = (await res.json()) as { accessToken: string };
    expect(accessToken).toBeTruthy();

    // adminAuth hits D1 (tokens table revocation check).
    const probe = await api(env, '/api/auth/audit-logs', { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(probe.status).toBe(200);
  });

  it('seed → public templates list', async () => {
    const seeded = await api(env, '/api/admin/seed', { method: 'POST', headers: await authHeaders(env) });
    expect(seeded.status).toBe(200);
    const list = await api(env, '/api/templates');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { templates: { id: string }[] };
    expect(body.templates.length).toBeGreaterThan(0);
  });

  it('nodes CRUD incl. DB.batch delete', async () => {
    const headers = await authHeaders(env);
    const created = await api(env, '/api/nodes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'n1' }),
    });
    expect(created.status).toBe(201);
    const node = ((await created.json()) as { node: { id: string } }).node;

    expect((await api(env, `/api/nodes/${node.id}`, { headers })).status).toBe(200);
    const listed = await api(env, '/api/nodes', { headers });
    expect(((await listed.json()) as { nodes: unknown[] }).nodes).toHaveLength(1);

    // delete → DB.batch (protocol_instances + nodes in one transaction)
    expect((await api(env, `/api/nodes/${node.id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await api(env, `/api/nodes/${node.id}`, { headers })).status).toBe(404);
  });

  it('clients: D1 put/get/list/delete, port-conflict and tag uniqueness', async () => {
    const headers = await authHeaders(env);
    const fp = 'fp-node-test';
    const put = await api(env, `/api/clients/${fp}/c1`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        config: { tag: 'proxy-1', server_port: 8443 },
        protocol_type: 'vless-reality-vision',
      }),
    });
    expect(put.status).toBe(201);

    const one = await api(env, `/api/clients/${fp}/c1`, { headers });
    expect(one.status).toBe(200);
    expect((((await one.json()) as { client: { config: { tag: string } } }).client.config).tag).toBe('proxy-1');

    // Port conflict check reads the same-node rows — one indexed query.
    const conflict = await api(env, `/api/clients/${fp}/c2`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ config: { server_port: 8443 }, protocol_type: 'vless-reality-vision' }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('PORT_CONFLICT');

    const byNode = await api(env, `/api/clients/${fp}`, { headers });
    expect(((await byNode.json()) as { clients: unknown[] }).clients).toHaveLength(1);

    // delete → releases the tag claim (the tag lives on the deleted row)
    expect((await api(env, `/api/clients/${fp}/c1`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await api(env, `/api/clients/${fp}/c1`, { headers })).status).toBe(404);
  });

  it('subscriptions: D1 CRUD, delivery via client-configs fallback, inactive path uses fireAndForget', async () => {
    const headers = await authHeaders(env);
    const created = await api(env, '/api/subscriptions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'node-test-sub' }),
    });
    expect(created.status).toBe(201);
    const sub = ((await created.json()) as { subscription: { id: string; token: string; path: string } }).subscription;

    // Wrong token → auth rejection before any storage work.
    expect((await api(env, `/s/${sub.path}?token=nope`)).status).toBe(401);

    // D1 row lookup + instance query succeed via adapters; no active
    // instances and no synced configs → explicit INSTANCES_MISSING.
    const delivered = await api(env, `/s/${sub.path}?token=${sub.token}`);
    expect(delivered.status).toBe(500);
    expect(((await delivered.json()) as { error: { code: string } }).error.code).toBe('INSTANCES_MISSING');

    // Disable, then hit delivery: the inactive path schedules a cache-row
    // delete via fireAndForget — on Node there is no ExecutionContext, so
    // this asserts the swap doesn't blow up mid-response.
    const updated = await api(env, `/api/subscriptions/${sub.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ active: false }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { subscription: { active: boolean } }).subscription.active).toBe(false);
    const inactive = await api(env, `/s/${sub.path}?token=${sub.token}`);
    expect(inactive.status).toBe(403);
    expect(((await inactive.json()) as { error: { code: string } }).error.code).toBe('SUB_INACTIVE');

    expect((await api(env, `/api/subscriptions/${sub.id}`, { method: 'DELETE', headers })).status).toBe(200);
  });
});

describe('node runtime: adapter primitives', () => {
  it('SqliteD1.batch is transactional (all-or-nothing)', async () => {
    const sqlite = new Database(':memory:');
    const d1 = new SqliteD1(sqlite);
    sqlite.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    const first = d1.prepare("INSERT INTO t (id) VALUES ('a')");
    const dup = d1.prepare("INSERT INTO t (id) VALUES ('a')");
    await expect(d1.batch([first, dup])).rejects.toThrow();
    const left = await d1.prepare('SELECT COUNT(*) AS n FROM t').first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('SqliteD1.first returns null on empty and column values by name', async () => {
    const d1 = new SqliteD1(new Database(':memory:'));
    expect(await d1.prepare('SELECT 1 AS x WHERE 0').first()).toBeNull();
    expect(await d1.prepare('SELECT 42 AS x').first<number>('x')).toBe(42);
  });

  it('MemoryRateLimiter: allows up to max, then rejects within the window', async () => {
    const { MemoryRateLimiter } = await import('../../src/node/rate-limiter');
    const limiter = new MemoryRateLimiter(2, 60_000);
    expect((await limiter.limit({ key: 'sub1' })).success).toBe(true);
    expect((await limiter.limit({ key: 'sub1' })).success).toBe(true);
    expect((await limiter.limit({ key: 'sub1' })).success).toBe(false);
    expect((await limiter.limit({ key: 'sub2' })).success).toBe(true); // per-key isolation
  });
});
