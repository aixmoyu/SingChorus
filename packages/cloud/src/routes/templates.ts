import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { adminAuth } from '../auth/middleware';
import { invalidateTemplateCache } from '../engine/registry';
import { isValidSingboxVersion, isValidCompatRange, isCompatSatisfied } from '../engine/compat';

// Overall templates use categories: overall-server, overall-client, overall-docker.
// The API also accepts short names (server/client/docker) and maps them.
const SHORT_TO_FULL: Record<string, string> = {
  server: 'overall-server',
  client: 'overall-client',
  docker: 'overall-docker',
  'overall-server': 'overall-server',
  'overall-client': 'overall-client',
  'overall-docker': 'overall-docker',
};

// Validate that a templateContent/config/entryScript string is valid JSON when present.
function validateJsonField(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    JSON.parse(value);
    return null;
  } catch {
    return `Field '${field}' must be valid JSON`;
  }
}

const templateCreateSchema = z.object({
  id: z.string().min(1).max(64),
  category: z.enum(['server', 'client', 'docker', 'overall-server', 'overall-client', 'overall-docker']),
  name: z.string().min(1).max(128),
  version: z.string().default('1.0.0'),
  templateContent: z.string().min(1),
  config: z.string().optional(),
  entryScript: z.string().optional(),
  description: z.string().max(512).optional(),
  singboxCompat: z.string().optional(),
});

const templates = new Hono<{ Bindings: Env }>();

templates.get('/', async (c) => {
  const categoryRaw = c.req.query('category');
  const version = c.req.query('singbox_version');
  if (version !== undefined && version !== null && version !== '' && !isValidSingboxVersion(version)) {
    return c.json({ error: { code: 'SBX_BAD_VERSION', message: `Invalid sing-box version: '${version}'` } }, 400);
  }
  let query = "SELECT * FROM templates WHERE category IN ('overall-server', 'overall-client', 'overall-docker')";
  const bind: unknown[] = [];
  if (categoryRaw) {
    const mapped = SHORT_TO_FULL[categoryRaw];
    if (mapped) {
      query += ' AND category = ?';
      bind.push(mapped);
    }
  }
  query += " ORDER BY created_at DESC";
  const { results } = await c.env.DB.prepare(query).bind(...bind).all<Record<string, unknown>>();
  const all = results ?? [];
  if (!version) {
    return c.json({ templates: all });
  }
  // 服务端兼容过滤（纵深防御第 1 层）：Deploy 页的 server 模板下拉由此只
  // 剩兼容模板；compat 为 NULL 的行视为兼容任意版本。filtered_count 供 UI 提示。
  const filtered = all.filter((row) => isCompatSatisfied(row.singbox_compat as string | null, version));
  return c.json({ templates: filtered, filtered_count: all.length - filtered.length });
});

// GET /api/singbox-versions — 版本目录（设计 §13.3）：聚合所有 overall-docker
// 模板 singbox_version param 的 enum，去重后按 semver 降序。panel 的 Settings
// 版本下拉与订阅创建版本下拉共用此端点，不再各自从 docker 模板挖 enum。
// 独立导出为顶层路由（挂载在 /api/singbox-versions，见 index.ts）。
export const singboxVersions = new Hono<{ Bindings: Env }>();

singboxVersions.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT params FROM templates WHERE category = 'overall-docker'"
  ).all<{ params: string }>();
  const versions = new Set<string>();
  for (const row of results ?? []) {
    try {
      const params = JSON.parse(row.params || '[]');
      if (!Array.isArray(params)) continue;
      for (const p of params) {
        if (p?.name === 'singbox_version' && Array.isArray(p.enum)) {
          for (const v of p.enum) {
            if (typeof v === 'string' && isValidSingboxVersion(v)) versions.add(v);
          }
        }
      }
    } catch { /* malformed params — skip */ }
  }
  const sorted = Array.from(versions).sort((a, b) => {
    const pa = a.split('-')[0].split('.').map(Number);
    const pb = b.split('-')[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (pb[i] || 0) - (pa[i] || 0);
      if (d !== 0) return d;
    }
    return a.localeCompare(b);
  });
  return c.json({ versions: sorted });
});

templates.get('/:id', async (c) => {
  const { id } = c.req.param();
  const tmpl = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category IN ('overall-server', 'overall-client', 'overall-docker')"
  ).bind(id).first();
  if (!tmpl) {
    return c.json({ error: { code: 'TMPL_NOT_FOUND', message: `Template '${id}' not found` } }, 404);
  }
  return c.json({ template: tmpl });
});

templates.post('/', adminAuth, zValidator('json', templateCreateSchema), async (c) => {
  const body = c.req.valid('json');
  const category = SHORT_TO_FULL[body.category];

  const jsonErr = validateJsonField('templateContent', body.templateContent) ?? validateJsonField('config', body.config);
  if (jsonErr) {
    return c.json({ error: { code: 'TMPL_INVALID_JSON', message: jsonErr } }, 400);
  }
  if (body.singboxCompat !== undefined && !isValidCompatRange(body.singboxCompat)) {
    return c.json({ error: { code: 'SBX_BAD_RANGE', message: `Invalid singbox_compat range: '${body.singboxCompat}'` } }, 400);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO templates (id, category, name, version, template_content, config, entry_script, params, description, singbox_compat)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`
    ).bind(
      body.id,
      category,
      body.name,
      body.version,
      body.templateContent,
      body.config ?? null,
      body.entryScript ?? null,
      body.description ?? null,
      body.singboxCompat ?? null,
    ).run();

    const tmpl = await c.env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(body.id).first();
    invalidateTemplateCache(); // CLOUD-P4: renders must see the new template now
    return c.json({ template: tmpl }, 201);
  } catch (e: any) {
    if (e?.message?.includes('UNIQUE constraint failed')) {
      return c.json({ error: { code: 'TMPL_DUPLICATE_ID', message: `Template id '${body.id}' already exists` } }, 409);
    }
    throw e;
  }
});

templates.put('/:id', adminAuth, zValidator('json', templateCreateSchema.omit({ id: true, category: true }).partial()), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');
  if (body.singboxCompat !== undefined && !isValidCompatRange(body.singboxCompat)) {
    return c.json({ error: { code: 'SBX_BAD_RANGE', message: `Invalid singbox_compat range: '${body.singboxCompat}'` } }, 400);
  }
  const existing = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category IN ('overall-server', 'overall-client', 'overall-docker')"
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'TMPL_NOT_FOUND', message: `Template '${id}' not found` } }, 404);
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); values.push(body.name); }
  if (body.version !== undefined) { sets.push('version = ?'); values.push(body.version); }
  if (body.templateContent !== undefined) {
    const err = validateJsonField('templateContent', body.templateContent);
    if (err) return c.json({ error: { code: 'TMPL_INVALID_JSON', message: err } }, 400);
    sets.push('template_content = ?'); values.push(body.templateContent);
  }
  if (body.config !== undefined) {
    const err = validateJsonField('config', body.config);
    if (err) return c.json({ error: { code: 'TMPL_INVALID_JSON', message: err } }, 400);
    sets.push('config = ?'); values.push(body.config);
  }
  if (body.entryScript !== undefined) { sets.push('entry_script = ?'); values.push(body.entryScript); }
  if (body.description !== undefined) { sets.push('description = ?'); values.push(body.description); }
  if (body.singboxCompat !== undefined) { sets.push('singbox_compat = ?'); values.push(body.singboxCompat); }

  if (sets.length > 0) {
    values.push(id);
    await c.env.DB.prepare(
      `UPDATE templates SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...values).run();
    invalidateTemplateCache(); // CLOUD-P4: drop the stale shared cache immediately
  }

  const updated = await c.env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
  return c.json({ template: updated });
});

templates.delete('/:id', adminAuth, async (c) => {
  const { id } = c.req.param();
  const existing = await c.env.DB.prepare(
    "SELECT * FROM templates WHERE id = ? AND category IN ('overall-server', 'overall-client', 'overall-docker')"
  ).bind(id).first();
  if (!existing) {
    return c.json({ error: { code: 'TMPL_NOT_FOUND', message: `Template '${id}' not found` } }, 404);
  }
  // 引用检查（设计 §13.7）：被订阅绑定的模板删除后交付端渲染 500 且 FK 约束
  // 只会抛原始错误——先查引用给出明确的 409。
  const refs = await c.env.DB.prepare(
    'SELECT path FROM subscriptions WHERE overall_template_id = ? LIMIT 5'
  ).bind(id).all<{ path: string }>();
  if (refs.results && refs.results.length > 0) {
    return c.json({
      error: {
        code: 'TMPL_IN_USE',
        message: `Template '${id}' is bound by subscription(s) /s/${refs.results.map((r) => r.path).join(', /s/')} — unbind it first`,
      },
    }, 409);
  }
  await c.env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
  invalidateTemplateCache(); // CLOUD-P4: deleted templates must not render
  return c.json({ success: true });
});

export { templates };
