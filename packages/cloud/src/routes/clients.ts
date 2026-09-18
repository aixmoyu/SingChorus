import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';

const upsertSchema = z.object({
  config: z.record(z.unknown()),
  protocol_type: z.string().min(1),
  content_hash: z.string().optional(),
  enabled: z.boolean().optional(),
  deployed: z.boolean().optional(),
});

/**
 * Client configs synced from panels live in D1 — one row per
 * `fingerprint + name`. A list is one indexed query and a full pull is one
 * query regardless of record count.
 *
 * Upper bound on rows returned per list/pull request — guards the response
 * body only, far above any real deployment size.
 */
const MAX_ROWS = 500;

interface ClientConfigRow {
  fingerprint: string;
  name: string;
  config: string;
  protocol_type: string;
  content_hash: string;
  enabled: number;
  deployed: number;
  port: number | null;
  tag: string;
  created_at: string;
  updated_at: string;
}

const clients = new Hono<{ Bindings: Env }>();

/** Extract the effective listen/connect port from a sing-box config (0/absent → null). */
function extractPort(config: Record<string, unknown>): number | null {
  const raw = config?.server_port ?? config?.listen_port;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** Extract the sing-box tag from a client config (empty when absent). */
function extractTag(config: Record<string, unknown> | undefined): string {
  const tag = config?.tag;
  return typeof tag === 'string' ? tag.trim() : '';
}

/** Full record shape returned by single-client and node-pull endpoints. */
function toFullRecord(row: ClientConfigRow): Record<string, unknown> {
  return {
    name: row.name,
    fingerprint: row.fingerprint,
    config: JSON.parse(row.config),
    protocol_type: row.protocol_type,
    content_hash: row.content_hash,
    enabled: Boolean(row.enabled),
    deployed: Boolean(row.deployed),
    status: 'active',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// List all clients across every node (metadata-only: 1 indexed query, no bodies).
clients.get('/', adminAuth, async (c) => {
  const fingerprint = c.req.query('fingerprint');
  try {
    const { results } = fingerprint
      ? await c.env.DB.prepare(
          `SELECT fingerprint, name, protocol_type, content_hash, enabled, deployed, created_at, updated_at
           FROM client_configs WHERE fingerprint = ? ORDER BY updated_at DESC LIMIT ?`,
        ).bind(fingerprint, MAX_ROWS).all<ClientConfigRow>()
      : await c.env.DB.prepare(
          `SELECT fingerprint, name, protocol_type, content_hash, enabled, deployed, created_at, updated_at
           FROM client_configs ORDER BY updated_at DESC LIMIT ?`,
        ).bind(MAX_ROWS).all<ClientConfigRow>();

    const clientList = (results ?? []).map((row) => ({
      name: row.name,
      fingerprint: row.fingerprint,
      protocol_type: row.protocol_type,
      content_hash: row.content_hash,
      enabled: Boolean(row.enabled),
      deployed: Boolean(row.deployed),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
    return c.json({ clients: clientList });
  } catch (e) {
    c.get('logger').error('clients list: D1 query failed', { err: e });
    return c.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Client storage temporarily unavailable' } }, 503);
  }
});

// List clients owned by one node (full records: pull needs the config body).
clients.get('/:fingerprint', adminAuth, async (c) => {
  const { fingerprint } = c.req.param();
  if (fingerprint.includes(':')) {
    return c.json({ error: { code: 'BAD_FINGERPRINT', message: 'Invalid fingerprint' } }, 400);
  }
  try {
    // Distinguish "node unknown" from "node has no configs".
    const known = await c.env.DB.prepare(
      'SELECT 1 AS ok FROM nodes WHERE fingerprint = ?',
    ).bind(fingerprint).first();
    const { results } = await c.env.DB.prepare(
      `SELECT fingerprint, name, config, protocol_type, content_hash, enabled, deployed, port, tag, created_at, updated_at
       FROM client_configs WHERE fingerprint = ? ORDER BY updated_at DESC LIMIT ?`,
    ).bind(fingerprint, MAX_ROWS).all<ClientConfigRow>();

    if ((!results || results.length === 0) && !known) {
      return c.json({ error: { code: 'CLIENT_NOT_FOUND', message: `Node '${fingerprint}' not found` } }, 404);
    }
    return c.json({ clients: (results ?? []).map(toFullRecord) });
  } catch (e) {
    c.get('logger').error('clients list by node: D1 query failed', { err: e });
    return c.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'Client storage temporarily unavailable' } }, 503);
  }
});

// Get a single client by fingerprint + name.
clients.get('/:fingerprint/:name', adminAuth, async (c) => {
  const { fingerprint, name } = c.req.param();
  const row = await c.env.DB.prepare(
    `SELECT fingerprint, name, config, protocol_type, content_hash, enabled, deployed, port, tag, created_at, updated_at
     FROM client_configs WHERE fingerprint = ? AND name = ?`,
  ).bind(fingerprint, name).first<ClientConfigRow>();
  if (!row) {
    return c.json({ error: { code: 'CLIENT_NOT_FOUND', message: `Client '${name}' not found` } }, 404);
  }
  return c.json({ client: toFullRecord(row) });
});

// Upsert a client owned by the given node.
clients.put('/:fingerprint/:name', adminAuth, zValidator('json', upsertSchema), async (c) => {
  const { fingerprint, name } = c.req.param();
  const { config, protocol_type, content_hash, enabled, deployed } = c.req.valid('json');

  const now = new Date().toISOString();
  const tag = extractTag(config);
  const port = extractPort(config);

  try {
    // Same-machine port conflict guard: reject when another config of this
    // node already listens on the same port (only when content is new/changed).
    if (port !== null) {
      const conflict = await c.env.DB.prepare(
        'SELECT name FROM client_configs WHERE fingerprint = ? AND port = ? AND name != ?',
      ).bind(fingerprint, port, name).first<{ name: string }>();
      if (conflict) {
        return c.json({
          error: {
            code: 'PORT_CONFLICT',
            message: `Port ${port} is already used by config '${conflict.name}' on this node`,
          },
        }, 409);
      }
    }

    // Tag uniqueness is enforced by the partial UNIQUE index; pre-check to
    // return a precise 409 instead of surfacing a constraint error.
    if (tag) {
      const tagOwner = await c.env.DB.prepare(
        'SELECT fingerprint, name FROM client_configs WHERE tag = ? AND NOT (fingerprint = ? AND name = ?)',
      ).bind(tag, fingerprint, name).first<{ fingerprint: string; name: string }>();
      if (tagOwner) {
        return c.json({
          error: {
            code: 'TAG_CONFLICT',
            message: `Tag '${tag}' is already used by config '${tagOwner.name}' on node '${tagOwner.fingerprint}'`,
          },
        }, 409);
      }
    }

    const prev = await c.env.DB.prepare(
      'SELECT created_at FROM client_configs WHERE fingerprint = ? AND name = ?',
    ).bind(fingerprint, name).first<{ created_at: string }>();

    const record = {
      name,
      fingerprint,
      config,
      protocol_type,
      content_hash: content_hash || '',
      enabled: enabled ?? true,
      deployed: deployed ?? false,
      status: 'active',
      created_at: prev?.created_at ?? now,
      updated_at: now,
    };

    if (prev) {
      await c.env.DB.prepare(
        `UPDATE client_configs
         SET config = ?, protocol_type = ?, content_hash = ?, enabled = ?, deployed = ?, port = ?, tag = ?, updated_at = ?
         WHERE fingerprint = ? AND name = ?`,
      ).bind(
        JSON.stringify(config), protocol_type, record.content_hash,
        record.enabled ? 1 : 0, record.deployed ? 1 : 0, port, tag, now,
        fingerprint, name,
      ).run();
      return c.json({ client: record }, 200);
    }

    await c.env.DB.prepare(
      `INSERT INTO client_configs
         (fingerprint, name, config, protocol_type, content_hash, enabled, deployed, port, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      fingerprint, name, JSON.stringify(config), protocol_type, record.content_hash,
      record.enabled ? 1 : 0, record.deployed ? 1 : 0, port, tag, now, now,
    ).run();
    return c.json({ client: record }, 201);
  } catch (e: any) {
    // Backstop for the tag UNIQUE index (a concurrent writer may have claimed
    // the tag between the pre-check and this write).
    if (String(e?.message ?? '').includes('UNIQUE constraint failed')) {
      return c.json({
        error: { code: 'TAG_CONFLICT', message: `Tag '${tag}' is already used by another config` },
      }, 409);
    }
    throw e;
  }
});

clients.delete('/:fingerprint/:name', adminAuth, async (c) => {
  const { fingerprint, name } = c.req.param();
  // The tag claim is the row's `tag` column — deleting the row releases it.
  const result = await c.env.DB.prepare(
    'DELETE FROM client_configs WHERE fingerprint = ? AND name = ?',
  ).bind(fingerprint, name).run();
  if (!result.meta.changes) {
    return c.json({ error: { code: 'CLIENT_NOT_FOUND', message: `Client '${name}' not found` } }, 404);
  }
  return c.json({ success: true });
});

export { clients };
