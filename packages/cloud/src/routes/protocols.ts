import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';
import { invalidateTemplateCache } from '../engine/registry';
import { isValidSingboxVersion, isValidCompatRange, isCompatSatisfied } from '../engine/compat';

const protocolCreateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  version: z.string().default('1.0.0'),
  serverTemplate: z.string().min(1),
  clientTemplate: z.string().min(1),
  params: z.string().default('[]'),
  description: z.string().max(512).optional(),
  singboxCompat: z.string().optional(),
});

const protocols = new Hono<{ Bindings: Env }>();

protocols.get('/', async (c) => {
  const version = c.req.query('singbox_version');
  if (version !== undefined && version !== null && version !== '' && !isValidSingboxVersion(version)) {
    return c.json({ error: { code: 'SBX_BAD_VERSION', message: `Invalid sing-box version: '${version}'` } }, 400);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE category = 'protocol' ORDER BY created_at DESC"
  ).all<Record<string, unknown>>();
  const all = results ?? [];
  if (!version) {
    return c.json({ protocols: all });
  }
  // 服务端兼容过滤（纵深防御第 1 层）：仅返回 singbox_compat 满足本机版本的
  // 协议；compat 为 NULL 的行视为兼容任意版本。filtered_count 供 UI 提示。
  const filtered = all.filter((row) => isCompatSatisfied(row.singbox_compat as string | null, version));
  return c.json({ protocols: filtered, filtered_count: all.length - filtered.length });
});

protocols.get('/:id', async (c) => {
  const { id } = c.req.param();
  const proto = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(id).first();
  if (!proto) {
    return c.json({ error: { code: 'PROTO_NOT_FOUND', message: `Protocol '${id}' not found` } }, 404);
  }
  return c.json({ protocol: proto });
});

protocols.post('/', adminAuth, zValidator('json', protocolCreateSchema), async (c) => {
  const body = c.req.valid('json');
  if (body.singboxCompat !== undefined && !isValidCompatRange(body.singboxCompat)) {
    return c.json({ error: { code: 'SBX_BAD_RANGE', message: `Invalid singbox_compat range: '${body.singboxCompat}'` } }, 400);
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO templates (id, category, name, version, server_template, client_template, params, description, singbox_compat)
       VALUES (?, 'protocol', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.id,
      body.name,
      body.version,
      body.serverTemplate,
      body.clientTemplate,
      body.params,
      body.description ?? null,
      body.singboxCompat ?? null,
    ).run();

    const proto = await c.env.DB.prepare(
      "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
    ).bind(body.id).first();
    invalidateTemplateCache(); // CLOUD-P4: renders must see the new protocol now
    return c.json({ protocol: proto }, 201);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: { code: 'PROTO_DUPLICATE_ID', message: `Protocol id '${body.id}' already exists` } }, 409);
    }
    throw e;
  }
});

protocols.put('/:id', adminAuth, zValidator('json', protocolCreateSchema.omit({ id: true }).partial()), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');
  if (body.singboxCompat !== undefined && !isValidCompatRange(body.singboxCompat)) {
    return c.json({ error: { code: 'SBX_BAD_RANGE', message: `Invalid singbox_compat range: '${body.singboxCompat}'` } }, 400);
  }
  const existing = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'PROTO_NOT_FOUND', message: `Protocol '${id}' not found` } }, 404);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); values.push(body.name); }
  if (body.version !== undefined) { sets.push('version = ?'); values.push(body.version); }
  if (body.serverTemplate !== undefined) { sets.push('server_template = ?'); values.push(body.serverTemplate); }
  if (body.clientTemplate !== undefined) { sets.push('client_template = ?'); values.push(body.clientTemplate); }
  if (body.params !== undefined) { sets.push('params = ?'); values.push(body.params); }
  if (body.description !== undefined) { sets.push('description = ?'); values.push(body.description); }
  if (body.singboxCompat !== undefined) { sets.push('singbox_compat = ?'); values.push(body.singboxCompat); }

  if (sets.length > 0) {
    values.push(id);
    await c.env.DB.prepare(
      `UPDATE templates SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...values).run();
    invalidateTemplateCache(); // CLOUD-P4: drop the stale shared cache immediately
  }

  const updated = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(id).first();
  return c.json({ protocol: updated });
});

protocols.delete('/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category = 'protocol'"
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'PROTO_NOT_FOUND', message: `Protocol '${id}' not found` } }, 404);
  }
  await c.env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
  invalidateTemplateCache(); // CLOUD-P4: deleted protocols must not render
  return c.json({ success: true });
});

export { protocols };
