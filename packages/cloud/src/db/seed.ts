import type { D1Database } from '@cloudflare/workers-types';
import { templateSeeds } from '../templates/registry';

/**
 * Upsert the built-in templates (matched by id) so a deployed cloud never
 * serves stale seed templates. Custom templates (any id not in the seed
 * list) are left untouched. The INSERT arm also picks up seed ids added
 * in newer deploys — an existing database would otherwise never learn
 * about them (UPDATE alone affects 0 rows).
 */
export async function refreshSeedTemplates(db: D1Database): Promise<void> {
  for (const t of templateSeeds) {
    await db.prepare(
      `INSERT INTO templates (id, category, name, version, server_template, client_template,
         template_content, config, entry_script, params, description, singbox_compat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         category = excluded.category,
         name = excluded.name,
         version = excluded.version,
         server_template = excluded.server_template,
         client_template = excluded.client_template,
         template_content = excluded.template_content,
         config = excluded.config,
         entry_script = excluded.entry_script,
         params = excluded.params,
         description = excluded.description,
         singbox_compat = excluded.singbox_compat,
         updated_at = datetime('now')`,
    ).bind(
      t.id, t.category, t.name, t.version,
      t.server_template, t.client_template,
      t.template_content, t.config, t.entry_script,
      t.params, t.description, t.singbox_compat,
    ).run();
  }
}

/**
 * Keep seed templates in sync with the code. `seedIfEmpty` handles fresh
 * databases; on existing databases it refreshes the built-in seeds.
 */
export async function seedIfEmpty(db: D1Database): Promise<void> {
  const existing = await db.prepare('SELECT COUNT(*) as count FROM templates').first();
  const count = (existing as any)?.count ?? 0;
  if (count > 0) {
    // Database already has templates — still refresh the built-in seeds so
    // a code deploy updates them (custom templates are never touched).
    await refreshSeedTemplates(db);
    return;
  }

  for (const t of templateSeeds) {
    await db.prepare(
      `INSERT INTO templates (id, category, name, version, server_template, client_template, template_content, config, entry_script, params, description, singbox_compat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      t.id, t.category, t.name, t.version,
      t.server_template, t.client_template,
      t.template_content, t.config, t.entry_script,
      t.params, t.description, t.singbox_compat,
    ).run();
  }

  console.log(`Seeded database: ${templateSeeds.length} templates`);
}
