import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';
import { PluginRegistry, ProtocolInstanceConfig } from '../engine/registry';
import { PluginError } from '../engine/errors';
import { parseSubscriptionRow, type SubscriptionRow } from '../engine/types';
import { hashToken } from '../auth/jwt';
import { fireAndForget } from '../services/fire-and-forget';
import type { Logger } from '../logger';

const subscriptions = new Hono<{ Bindings: Env }>();

/**
 * Isolate-level cache for the client-configs fallback. Subscription
 * consumers poll this endpoint regularly; without a cache every poll costs
 * one D1 query (cheap but not free on the subrequest budget). A 300s TTL
 * caps it at ~288 queries/day worst-case per live isolate (CLOUD-P3) —
 * aligned with the 5-minute panel full-sync cadence, so configs are already
 * expected to change at that granularity. Hot polls within the TTL are
 * served from memory at zero cost; on D1 failure a stale cache is served
 * rather than erroring.
 */
const CONFIGS_TTL_MS = 300_000;
let configsCache: { at: number; configs: ProtocolInstanceConfig[] } | null = null;

/** Test-only: drop the isolate cache (D1 storage resets per test but module
 * state persists in the single test worker). */
export function resetSubscriptionCaches(): void {
  configsCache = null;
  subCacheWriteAt.clear();
}

/**
 * CLOUD-A2: D1-backed delivery cache (table `sub_delivery_cache`).
 * Subscription delivery hard-depends on D1 (subscription row lookup,
 * instance read, template load) — without this cache a D1 outage takes the
 * delivery plane down with the admin plane. On D1 failure the cached config
 * is served stale instead, keeping end-user clients provisioning.
 *
 * Security posture: only the SHA-256 token hash is stored (not the token),
 * so a rotated token is rejected; a subscription disabled while D1 was
 * healthy has its cache entry invalidated on the 403 path. Staleness is
 * bounded by the 24h lazy purge on write.
 */
const SUB_CACHE_TTL_DAYS = 1;
/**
 * Delivery results are written at most once per 5min per path per isolate —
 * identical rationale to CONFIGS_TTL_MS: keeps write volume (and row
 * churn) negligible for polling consumers.
 */
const SUB_CACHE_WRITE_INTERVAL_MS = 300_000;
const subCacheWriteAt = new Map<string, number>();

/** Best-effort cache write; failures are logged and swallowed — caching must
 * never break a successful delivery. Also lazily purges entries older than
 * the 24h staleness bound. */
async function writeDeliveryCache(
  env: Env, logger: Logger, path: string, token: string, active: boolean, config: unknown,
): Promise<void> {
  const last = subCacheWriteAt.get(path) ?? 0;
  if (Date.now() - last < SUB_CACHE_WRITE_INTERVAL_MS) return;
  subCacheWriteAt.set(path, Date.now());
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sub_delivery_cache (path, token_hash, active, config, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
           token_hash = excluded.token_hash,
           active = excluded.active,
           config = excluded.config,
           updated_at = excluded.updated_at`,
      ).bind(path, await hashToken(token), active ? 1 : 0, JSON.stringify(config)),
      env.DB.prepare(
        `DELETE FROM sub_delivery_cache WHERE updated_at < datetime('now', '-${SUB_CACHE_TTL_DAYS} day')`,
      ),
    ]);
  } catch (e) {
    logger.warn('subscription delivery: cache write failed', { err: e });
  }
}

/** Serve the cached delivery during a D1 outage, or null when there is no
 * usable cache (no entry / token mismatch / subscription was disabled). */
async function serveStaleDelivery(
  c: Context<{ Bindings: Env }>, path: string, token: string,
): Promise<Response | null> {
  try {
    const row = await c.env.DB.prepare(
      'SELECT token_hash, active, config FROM sub_delivery_cache WHERE path = ?',
    ).bind(path).first<{ token_hash: string; active: number; config: string }>();
    if (!row || !row.config || !row.active) return null;
    if (!row.token_hash || row.token_hash !== await hashToken(token)) return null;
    return c.json(JSON.parse(row.config), 200, { 'X-Subscription-Cache': 'stale' });
  } catch (e) {
    c.get('logger').warn('subscription delivery: stale cache fallback failed', { err: e });
    return null;
  }
}

/**
 * Only deployed+enabled configs belong in a user subscription: nodes that the
 * owner actually runs. Undeployed/disabled configs are still synced (for
 * management/visibility) but excluded here. One indexed query.
 */
async function loadConfigsFromD1(env: Env, logger: Logger): Promise<ProtocolInstanceConfig[]> {
  if (configsCache && Date.now() - configsCache.at < CONFIGS_TTL_MS) {
    return configsCache.configs;
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT name, config FROM client_configs WHERE deployed = 1 AND enabled = 1 LIMIT 40`,
    ).all<{ name: string; config: string }>();
    const configs: ProtocolInstanceConfig[] = [];
    for (const row of results ?? []) {
      try {
        const parsed = JSON.parse(row.config);
        if (parsed && typeof parsed === 'object') {
          configs.push({
            id: row.name || 'client',
            serverConfig: {},
            clientConfig: parsed,
          });
        }
      } catch { /* malformed row — skip */ }
    }
    configsCache = { at: Date.now(), configs };
    return configs;
  } catch (e) {
    // D1 unavailable — serve the stale cache if we have one; the config
    // content rarely changes and a brief staleness beats an outage for
    // polling consumers.
    if (configsCache) {
      logger.warn('subscription delivery: client-configs fallback failed, serving stale cache', { err: e });
      return configsCache.configs;
    }
    throw e;
  }
}

// Delivery endpoint: GET /s/{path}?token={token}
subscriptions.get('/s/:path', async (c) => {
  const { path } = c.req.param();
  const token = c.req.query('token');

  if (!token) {
    return c.json({ error: { code: 'AUTH_MISSING_TOKEN', message: 'Subscription token required' } }, 401);
  }

  let subRow: SubscriptionRow | null;
  try {
    subRow = await c.env.DB.prepare(
      'SELECT * FROM subscriptions WHERE path = ?'
    ).bind(path).first<SubscriptionRow | null>();
  } catch (e) {
    // CLOUD-A2: D1 outage — serve the last delivered config from the
    // sub_delivery_cache table instead of going down. Rate limiting is
    // skipped here (no sub id available); acceptable for an emergency stale path.
    c.get('logger').error('subscription delivery: subscription row lookup failed', { err: e });
    return (await serveStaleDelivery(c, path, token))
      ?? c.json({ error: { code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable' } }, 503);
  }

  if (!subRow) {
    return c.json({ error: { code: 'SUB_NOT_FOUND', message: `Subscription '${path}' not found` } }, 404);
  }

  const sub = parseSubscriptionRow(subRow);

  if (token !== sub.token) {
    return c.json({ error: { code: 'AUTH_INVALID_TOKEN', message: 'Invalid subscription token' } }, 401);
  }

  if (!sub.active) {
    // Invalidate any cached delivery so the stale path can't serve a config
    // for a subscription that was just disabled (best-effort).
    // Works on both runtimes: waitUntil on Workers, detached promise on Node.
    fireAndForget(c, c.env.DB.prepare('DELETE FROM sub_delivery_cache WHERE path = ?')
      .bind(path).run().catch(() => {}));
    return c.json({ error: { code: 'SUB_INACTIVE', message: 'Subscription is disabled' } }, 403);
  }

  let rateLimited = false;
  try {
    const result = await c.env.SUBSCRIPTION_RATE_LIMITER?.limit({ key: sub.id });
    if (result) rateLimited = !result.success;
  } catch {
    // rate limiter not configured — proceed
  }
  if (rateLimited) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, 429);
  }

  // Try D1 protocol_instances first, fall back to synced client configs (panel push)
  let configs: ProtocolInstanceConfig[];
  try {
    const { results: instanceRows } = await c.env.DB.prepare(
      `SELECT * FROM protocol_instances WHERE status = 'active'`
    ).all<Record<string, unknown>>();

    if (instanceRows && instanceRows.length > 0) {
      configs = instanceRows.map((row: any) => ({
        id: row.id,
        serverConfig: row.server_config ? JSON.parse(row.server_config) : {},
        clientConfig: row.client_config ? JSON.parse(row.client_config) : {},
      }));
    } else {
      // Fallback: read D1 client configs (synced from local panels), cached
      // at isolate level to conserve the request budget.
      try {
        configs = await loadConfigsFromD1(c.env, c.get('logger'));
      } catch (e) {
        c.get('logger').error('subscription delivery: client-configs fallback failed', { err: e });
        return c.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Config storage temporarily unavailable' } }, 503);
      }
      if (configs.length === 0) {
        return c.json({ error: { code: 'INSTANCES_MISSING', message: 'No active protocol instances found' } }, 500);
      }
    }
  } catch (e) {
    // CLOUD-A2: D1 died mid-delivery (row lookup succeeded) — stale cache.
    c.get('logger').error('subscription delivery: instance lookup failed', { err: e });
    return (await serveStaleDelivery(c, path, token))
      ?? c.json({ error: { code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable' } }, 503);
  }

  const reg = new PluginRegistry(c.env.DB);

  let clientConfig: Record<string, unknown>;
  try {
    await reg.loadAll();

    if (sub.overallTemplateId && configs.length > 0) {
      // Render via overall template (works with both D1 instances and synced client configs)
      const overallParams = sub.overallParams ? JSON.parse(sub.overallParams) : {};
      clientConfig = await reg.renderClientOverall(configs, sub.overallTemplateId, overallParams);
    } else {
      // Simple merge
      clientConfig = {
        version: '1',
        outbounds: [
          ...configs.map((c) => c.clientConfig),
          { type: 'direct', tag: 'direct' },
        ],
      };
    }
  } catch (e) {
    if (e instanceof PluginError) {
      return c.json({ error: { code: 'OVERALL_RENDER_FAILED', message: e.message } }, 500);
    }
    // CLOUD-A2: D1 failure while loading templates — stale cache.
    c.get('logger').error('subscription delivery: render failed', { err: e });
    return (await serveStaleDelivery(c, path, token))
      ?? c.json({ error: { code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable' } }, 503);
  }

  // CLOUD-A2: persist the delivery so a later D1 outage can stale-serve it.
  // Throttled internally (≤1 write / 5min / path / isolate).
  await writeDeliveryCache(c.env, c.get('logger'), path, token, sub.active, clientConfig);

  // Deliver the raw client config — consumers (sing-box etc.) expect the
  // config document itself, not a wrapper envelope.
  return c.json(clientConfig);
});

// Validation schemas
const createSubSchema = z.object({
  name: z.string().max(128).optional(),
  path: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/, 'Path must be lowercase alphanumeric with hyphens'),
  token: z.string().min(8).max(128).optional(),
  overallTemplateId: z.string().optional(),
  overallParams: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
});

const updateSubSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  path: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/, 'Path must be lowercase alphanumeric with hyphens').optional(),
  token: z.string().min(8).max(128).optional(),
  overallTemplateId: z.string().nullable().optional(),
  overallParams: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
  regenerateToken: z.boolean().optional(),
});

// CRUD routes (admin-only)

subscriptions.get('/api/subscriptions', adminAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM subscriptions ORDER BY created_at DESC'
  ).all<SubscriptionRow>();
  const items = (results ?? []).map(parseSubscriptionRow);
  return c.json({ subscriptions: items });
});

subscriptions.get('/api/subscriptions/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const row = await c.env.DB.prepare(
    'SELECT * FROM subscriptions WHERE id = ?'
  ).bind(id).first<SubscriptionRow | null>();
  if (!row) {
    return c.json({ error: { code: 'SUB_NOT_FOUND', message: `Subscription '${id}' not found` } }, 404);
  }
  return c.json({ subscription: parseSubscriptionRow(row) });
});

subscriptions.post('/api/subscriptions', adminAuth, zValidator('json', createSubSchema), async (c) => {
  const body = c.req.valid('json');
  const id = crypto.randomUUID();
  const subName = body.name || body.path;
  const token = body.token || (crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''));
  const activeVal = body.active !== false ? '1' : '0';

  const reserved = ['api', 'admin', 'health'];
  if (reserved.includes(body.path)) {
    return c.json({ error: { code: 'SUB_PATH_RESERVED', message: `Path '${body.path}' is reserved` } }, 400);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO subscriptions (id, name, path, overall_template_id, overall_params, token, active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      subName,
      body.path,
      body.overallTemplateId ?? null,
      JSON.stringify(body.overallParams ?? {}),
      token,
      activeVal,
    ).run();

    const row = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first<SubscriptionRow>();
    return c.json({ subscription: parseSubscriptionRow(row!) }, 201);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE constraint failed')) {
      if (e.message.includes('path')) {
        return c.json({ error: { code: 'SUB_PATH_DUPLICATE', message: `Path '${body.path}' is already taken` } }, 409);
      }
      return c.json({ error: { code: 'SUB_DUPLICATE', message: 'Subscription already exists' } }, 409);
    }
    throw e;
  }
});

subscriptions.put('/api/subscriptions/:id', adminAuth, zValidator('json', updateSubSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');

  const existing = await c.env.DB.prepare(
    'SELECT * FROM subscriptions WHERE id = ?'
  ).bind(id).first<SubscriptionRow | null>();
  if (!existing) {
    return c.json({ error: { code: 'SUB_NOT_FOUND', message: `Subscription '${id}' not found` } }, 404);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (body.name !== undefined) { sets.push('name = ?'); binds.push(body.name); }
  if (body.path !== undefined) {
    const reserved = ['api', 'admin', 'health'];
    if (reserved.includes(body.path)) {
      return c.json({ error: { code: 'SUB_PATH_RESERVED', message: `Path '${body.path}' is reserved` } }, 400);
    }
    sets.push('path = ?');
    binds.push(body.path);
  }
  if (body.overallTemplateId !== undefined) { sets.push('overall_template_id = ?'); binds.push(body.overallTemplateId); }
  if (body.overallParams !== undefined) { sets.push('overall_params = ?'); binds.push(JSON.stringify(body.overallParams)); }
  if (body.token !== undefined) { sets.push('token = ?'); binds.push(body.token); }
  if (body.active !== undefined) { sets.push('active = ?'); binds.push(body.active ? '1' : '0'); }
  if (body.regenerateToken) {
    const newToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    sets.push('token = ?');
    binds.push(newToken);
  }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    binds.push(id);
    try {
      await c.env.DB.prepare(
        `UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`
      ).bind(...binds).run();
    } catch (e: any) {
      if (e?.message?.includes('UNIQUE constraint failed')) {
        return c.json({ error: { code: 'SUB_PATH_DUPLICATE', message: 'Path already taken' } }, 409);
      }
      throw e;
    }
  }

  const row = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first<SubscriptionRow>();
  return c.json({ subscription: parseSubscriptionRow(row!) });
});

subscriptions.delete('/api/subscriptions/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare(
    'SELECT id FROM subscriptions WHERE id = ?'
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'SUB_NOT_FOUND', message: `Subscription '${id}' not found` } }, 404);
  }
  await c.env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
  return c.json({ success: true });
});

export { subscriptions };
