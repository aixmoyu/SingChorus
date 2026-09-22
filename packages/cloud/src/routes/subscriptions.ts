import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';
import { PluginRegistry, ProtocolInstanceConfig } from '../engine/registry';
import { PluginError } from '../engine/errors';
import { isValidSingboxVersion, isCompatSatisfied } from '../engine/compat';
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
let configsCache: { at: number; configs: LoadedConfig[] } | null = null;

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
 *
 * Rows carry their protocol template id (`protocol_type`) so delivery can
 * exclude outbounds whose protocol is incompatible with the subscription's
 * pinned sing-box version (设计 §13.2).
 */
interface LoadedConfig extends ProtocolInstanceConfig {
  protocolId?: string;
}

async function loadConfigsFromD1(env: Env, logger: Logger): Promise<LoadedConfig[]> {
  if (configsCache && Date.now() - configsCache.at < CONFIGS_TTL_MS) {
    return configsCache.configs as LoadedConfig[];
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT name, config, protocol_type FROM client_configs WHERE deployed = 1 AND enabled = 1 LIMIT 40`,
    ).all<{ name: string; config: string; protocol_type: string }>();
    const configs: LoadedConfig[] = [];
    for (const row of results ?? []) {
      try {
        const parsed = JSON.parse(row.config);
        if (parsed && typeof parsed === 'object') {
          configs.push({
            id: row.name || 'client',
            serverConfig: {},
            clientConfig: parsed,
            protocolId: row.protocol_type || undefined,
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
      return configsCache.configs as LoadedConfig[];
    }
    throw e;
  }
}

// Delivery endpoint: GET /s/{path}?token={token}
// 版本语义（设计 §13.1）：订阅在创建时绑定 sing-box 版本（必填），交付端
// 一律用绑定版本强制校验 overall-client 模板 compat，并排除协议模板不兼容
// 的 instance（§13.2）。消费者传参 `?version=` 已废弃——绑定即事实来源。
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
  let configs: LoadedConfig[];
  try {
    const { results: instanceRows } = await c.env.DB.prepare(
      `SELECT * FROM protocol_instances WHERE status = 'active'`
    ).all<Record<string, unknown>>();

    if (instanceRows && instanceRows.length > 0) {
      configs = instanceRows.map((row: any) => ({
        id: row.id,
        serverConfig: row.server_config ? JSON.parse(row.server_config) : {},
        clientConfig: row.client_config ? JSON.parse(row.client_config) : {},
        protocolId: row.protocol_id || undefined,
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

  // 订阅绑定的 sing-box 版本（必填列）：交付端 compat 校验的唯一依据。
  const subVersion = sub.singboxVersion;

  let clientConfig: Record<string, unknown>;
  // 被版本兼容性排除的 instance 描述（§13.2）——供响应头与日志使用。
  const skipped: string[] = [];
  try {
    await reg.loadAll();

    // 交付强制校验（设计 §13.1）：绑定版本与 overall-client 模板 compat
    // 比对，不匹配 → 400 明确报错（模板名 + 所需范围）。管理员修改订阅
    // 模板或版本后，此处是最终防线。
    if (sub.overallTemplateId) {
      const tmpl = reg.getTemplate(sub.overallTemplateId);
      const compat = tmpl?.singboxCompat ?? null;
      if (!isCompatSatisfied(compat, subVersion)) {
        return c.json({
          error: {
            code: 'SBX_VERSION_INCOMPATIBLE',
            message: `sing-box ${subVersion} is incompatible with subscription template '${sub.overallTemplateId}' (requires '${compat ?? '*'}')`,
          },
        }, 400);
      }
    }

    // instance 兼容排除（设计 §13.2）：outbound 由协议模板生成，其兼容性 =
    // 协议模板 singbox_compat vs 订阅绑定版本。不兼容的排除而非报错——
    // 一个坏配置不能挂掉整个订阅；全部被排除才 400。
    const compatible = configs.filter((cfg) => {
      if (!cfg.protocolId) return true; // 无协议来源信息（历史数据）→ 不参与判定
      const compat = reg.getTemplate(cfg.protocolId)?.singboxCompat ?? null;
      if (isCompatSatisfied(compat, subVersion)) return true;
      skipped.push(`${cfg.id} (${cfg.protocolId} requires '${compat ?? '*'}')`);
      return false;
    });
    if (compatible.length === 0 && configs.length > 0) {
      return c.json({
        error: {
          code: 'SBX_NO_COMPATIBLE_INSTANCES',
          message: `sing-box ${subVersion} is incompatible with every active instance: ${skipped.join('; ')}`,
        },
      }, 400);
    }
    if (skipped.length > 0) {
      c.get('logger').warn('subscription delivery: skipped incompatible instances', {
        path, version: subVersion, skipped: skipped.length,
      });
    }

    if (sub.overallTemplateId && compatible.length > 0) {
      // Render via overall template (works with both D1 instances and synced client configs)
      const overallParams = sub.overallParams ? JSON.parse(sub.overallParams) : {};
      clientConfig = await reg.renderClientOverall(compatible, sub.overallTemplateId, overallParams);
    } else {
      // Simple merge
      clientConfig = {
        version: '1',
        outbounds: [
          ...compatible.map((cfg) => cfg.clientConfig),
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
  // config document itself, not a wrapper envelope. The header reports how
  // many outbounds were dropped for version incompatibility (设计 §13.2).
  return c.json(clientConfig, 200, {
    ...(skipped.length > 0 ? { 'X-Sbx-Skipped-Instances': String(skipped.length) } : {}),
  });
});

// Validation schemas
// 订阅绑定版本（设计 §13.1）：必填，semver 格式（docker-tag 安全形状）。
const singboxVersionSchema = z.string().superRefine((val, ctx) => {
  if (!isValidSingboxVersion(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['singboxVersion'],
      message: `Invalid sing-box version: '${val}' (expected X.Y.Z[-suffix])`,
    });
  }
});

/**
 * 写路径预校验（设计 §13.7）：订阅绑定模板的存在性 + 版本 compat 在
 * create/update 时即校验，不让管理员创建一个注定交付 400/500 的订阅。
 * 交付端校验保留为最终防线（模板可能在订阅创建后被编辑/删除）。
 * 入参为「更新后的最终值」。overall 模板未绑定（null）→ 简单合并，无需校验。
 */
async function validateOverallCompat(
  env: Env, finalTemplateId: string | null, finalVersion: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 404; code: string; message: string }> {
  if (!finalTemplateId) return { ok: true };
  const tmpl = await env.DB.prepare(
    "SELECT singbox_compat FROM templates WHERE id = ? AND category IN ('overall-server', 'overall-client', 'overall-docker')",
  ).bind(finalTemplateId).first<{ singbox_compat: string | null }>();
  if (!tmpl) {
    return { ok: false, status: 404, code: 'TMPL_NOT_FOUND', message: `Template '${finalTemplateId}' not found` };
  }
  if (!isCompatSatisfied(tmpl.singbox_compat, finalVersion)) {
    return {
      ok: false, status: 400, code: 'SBX_VERSION_INCOMPATIBLE',
      message: `sing-box ${finalVersion} is incompatible with template '${finalTemplateId}' (requires '${tmpl.singbox_compat ?? '*'}')`,
    };
  }
  return { ok: true };
}

const createSubSchema = z.object({
  name: z.string().max(128).optional(),
  path: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/, 'Path must be lowercase alphanumeric with hyphens'),
  token: z.string().min(8).max(128).optional(),
  singboxVersion: singboxVersionSchema,
  overallTemplateId: z.string().optional(),
  overallParams: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
});

const updateSubSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  path: z.string().min(2).max(64).regex(/^[a-z0-9-]+$/, 'Path must be lowercase alphanumeric with hyphens').optional(),
  token: z.string().min(8).max(128).optional(),
  singboxVersion: singboxVersionSchema.optional(),
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

  // 预校验（§13.7）：绑定模板存在 + 版本 compat，创建时即报错
  const pre = await validateOverallCompat(c.env, body.overallTemplateId ?? null, body.singboxVersion);
  if (!pre.ok) return c.json({ error: { code: pre.code, message: pre.message } }, pre.status);

  try {
    await c.env.DB.prepare(
      `INSERT INTO subscriptions (id, name, path, singbox_version, overall_template_id, overall_params, token, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      subName,
      body.path,
      body.singboxVersion,
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

  // 预校验（§13.7）：版本或模板变更时，以「更新后的最终值」比对 compat，
  // 不让订阅更新成注定交付 400/500 的组合
  if (body.singboxVersion !== undefined || body.overallTemplateId !== undefined) {
    const finalTemplateId = body.overallTemplateId !== undefined ? body.overallTemplateId : existing.overall_template_id;
    const finalVersion = body.singboxVersion !== undefined ? body.singboxVersion : existing.singbox_version;
    const pre = await validateOverallCompat(c.env, finalTemplateId ?? null, finalVersion);
    if (!pre.ok) return c.json({ error: { code: pre.code, message: pre.message } }, pre.status);
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
  if (body.singboxVersion !== undefined) { sets.push('singbox_version = ?'); binds.push(body.singboxVersion); }
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
    // 渲染产物失效（设计 §13.1）：sub_delivery_cache 按 path 键控，版本 /
    // overall 模板 / 参数 / token 变更后，stale fallback 不得再端旧版本的
    // 渲染结果（v1 的隐性 bug：不同 version 共享同一缓存行）。
    if (body.singboxVersion !== undefined || body.overallTemplateId !== undefined ||
        body.overallParams !== undefined || body.token !== undefined || body.regenerateToken) {
      await c.env.DB.prepare('DELETE FROM sub_delivery_cache WHERE path = ?')
        .bind(existing.path).run().catch(() => {});
    }
  }

  const row = await c.env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first<SubscriptionRow>();
  return c.json({ subscription: parseSubscriptionRow(row!) });
});

subscriptions.delete('/api/subscriptions/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare(
    'SELECT id, path FROM subscriptions WHERE id = ?'
  ).bind(id).first<{ id: string; path: string }>();
  if (!existing) {
    return c.json({ error: { code: 'SUB_NOT_FOUND', message: `Subscription '${id}' not found` } }, 404);
  }
  await c.env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
  // 已删除订阅的 stale 交付缓存必须同步清掉：D1 宕机期间 serveStaleDelivery
  // 不查订阅表（查不了），缓存行不删就会继续服务一个不存在的订阅（§13.7）。
  await c.env.DB.prepare('DELETE FROM sub_delivery_cache WHERE path = ?')
    .bind(existing.path).run().catch(() => {});
  return c.json({ success: true });
});

export { subscriptions };
