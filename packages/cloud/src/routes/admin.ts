import { Hono } from 'hono';
import { adminAuth } from '../auth/middleware';
import { templateSeeds, seedProtocolConfigs, seedOverallConfigs } from '../templates/registry';
import { validateProtocolConfig, validateOverallConfig } from '../engine/config-validator';

const admin = new Hono<{ Bindings: Env }>();

admin.use('*', adminAuth);

interface SeedEntry {
  table: string;
  id: string;
  status: string;
}

admin.post('/seed', async (c) => {
  const results: SeedEntry[] = [];

  // Validate config files before seeding
  for (const [id, cfg] of Object.entries(seedProtocolConfigs)) {
    const vr = validateProtocolConfig(cfg);
    if (!vr.valid) {
      return c.json({
        error: {
          code: 'CONFIG_VALIDATION_FAILED',
          message: `Protocol config validation failed: ${id}`,
          issues: vr.issues,
        },
      }, 400);
    }
  }

  for (const [id, cfg] of Object.entries(seedOverallConfigs)) {
    const vr = validateOverallConfig(cfg);
    if (!vr.valid) {
      return c.json({
        error: {
          code: 'CONFIG_VALIDATION_FAILED',
          message: `Overall config validation failed: ${id}`,
          issues: vr.issues,
        },
      }, 400);
    }
  }

  // Unified templates: single table, category distinguishes type
  // IDs match seedIfEmpty() in db/seed.ts for consistency
  const templates = templateSeeds;

  for (const t of templates) {
    const existing = await c.env.DB.prepare('SELECT id FROM templates WHERE id = ?').bind(t.id).first();
    if (existing) {
      await c.env.DB.prepare(
        `UPDATE templates SET category = ?, name = ?, version = ?, server_template = ?, client_template = ?,
         template_content = ?, config = ?, entry_script = ?, params = ?, description = ?, singbox_compat = ?,
         updated_at = datetime('now')
         WHERE id = ?`
      ).bind(
        t.category, t.name, t.version, t.server_template, t.client_template,
        t.template_content, t.config, t.entry_script, t.params, t.description,
        t.singbox_compat ?? null, t.id,
      ).run();
      results.push({ table: 'templates', id: t.id, status: 'updated' });
    } else {
      await c.env.DB.prepare(
        `INSERT INTO templates (id, category, name, version, server_template, client_template, template_content, config, entry_script, params, description, singbox_compat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        t.id, t.category, t.name, t.version,
        t.server_template, t.client_template,
        t.template_content, t.config, t.entry_script,
        t.params, t.description,
        t.singbox_compat ?? null,
      ).run();
      results.push({ table: 'templates', id: t.id, status: 'created' });
    }
  }

  return c.json({ seeded: results });
});

export { admin };
