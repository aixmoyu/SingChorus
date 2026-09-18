import { Hono } from 'hono';
import { adminAuth } from '../auth/middleware';

/**
 * Tag uniqueness check. Tags are sing-box inbound/outbound identifiers —
 * every config across every node must have a globally unique tag so merged
 * configs never contain duplicate identifiers.
 *
 * Checks two D1 index lookups:
 *  1. protocol_instances.tag (mirrored from params.tag on every write)
 *  2. client_configs.tag — partial UNIQUE index, which also enforces
 *     uniqueness at write time
 */
const tags = new Hono<{ Bindings: Env }>();

tags.get('/check', adminAuth, async (c) => {
  const tag = c.req.query('tag');
  if (!tag) {
    return c.json({ error: { code: 'TAG_REQUIRED', message: 'tag query param is required' } }, 400);
  }

  // 1. protocol_instances — indexed lookup on the tag column.
  const instanceRow = await c.env.DB.prepare(
    'SELECT id FROM protocol_instances WHERE tag = ?',
  ).bind(tag).first<{ id: string }>();
  if (instanceRow) {
    return c.json({ tag, available: false, source: 'protocol_instances' });
  }

  // 2. Panel-synced client configs — indexed lookup (partial UNIQUE index
  //    makes this claim authoritative at write time too).
  const owner = await c.env.DB.prepare(
    'SELECT fingerprint, name FROM client_configs WHERE tag = ?',
  ).bind(tag).first<{ fingerprint: string; name: string }>();
  if (owner) {
    return c.json({ tag, available: false, source: 'client_configs' });
  }

  return c.json({ tag, available: true });
});

export { tags };
