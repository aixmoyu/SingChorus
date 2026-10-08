import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeDatabase, resetDatabaseInitCache } from '../src/db/schema';

/**
 * Legacy-database upgrade path (panel-502 regression, 2026-09-24): a D1
 * created by a pre-singbox-version deploy (commit 8fba08a) has a
 * `subscriptions` table WITHOUT `singbox_version`. `CREATE TABLE IF NOT
 * EXISTS` no-ops on it, so the eager DDL must add the column via
 * ALTER_TABLES — otherwise every subscription INSERT dies with "no such
 * column" → cloud 500 → core retries → panel 502, while the list endpoint
 * (SELECT *) keeps working and hides the breakage.
 */
describe('legacy schema upgrade', () => {
  afterEach(() => {
    // Don't leak the memoized init (bound to this test's D1 state) to other specs.
    resetDatabaseInitCache();
  });

  it('adds subscriptions.singbox_version to a pre-v2.1 database', async () => {
    const db = (env as any).DB as D1Database;

    for (const t of ['subscriptions', 'templates', 'nodes']) {
      await db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    }
    await db.prepare(`CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      overall_template_id TEXT DEFAULT NULL,
      overall_params TEXT NOT NULL DEFAULT '{}',
      token TEXT NOT NULL UNIQUE,
      active TEXT NOT NULL DEFAULT '1',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`).run();

    resetDatabaseInitCache();
    await initializeDatabase(db);

    // The exact INSERT the subscription-create route performs must succeed.
    await db.prepare(
      `INSERT INTO subscriptions (id, name, path, singbox_version, token)
       VALUES ('t1', 'n', 'p', '1.12.0', 'tok-0123456789abcdef')`,
    ).run();
    const row = await db.prepare(
      'SELECT singbox_version FROM subscriptions WHERE id = ?',
    ).bind('t1').first<{ singbox_version: string }>();
    expect(row?.singbox_version).toBe('1.12.0');
  });

  it('adds client_configs.server_config/params to a pre-rebind-recovery database', async () => {
    const db = (env as any).DB as D1Database;

    // Legacy shape from the KV→D1 migration (7b1ef0e): no server_config/params
    // (both were added later by 66c45c2 rebind recovery).
    await db.prepare('DROP TABLE IF EXISTS client_configs').run();
    await db.prepare(`CREATE TABLE client_configs (
      fingerprint TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      protocol_type TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      deployed INTEGER NOT NULL DEFAULT 0,
      port INTEGER,
      tag TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (fingerprint, name)
    )`).run();

    resetDatabaseInitCache();
    await initializeDatabase(db);

    // The exact upsert INSERT the PUT /api/clients route performs must succeed.
    await db.prepare(
      `INSERT INTO client_configs (fingerprint, name, config, server_config, params, protocol_type, content_hash, enabled, deployed, port, tag, created_at, updated_at)
       VALUES ('fp1', 'n1', '{}', '{}', '{}', 'singbox', 'h', 1, 0, NULL, 'tag1', datetime('now'), datetime('now'))`,
    ).run();
    const row = await db.prepare(
      'SELECT server_config, params FROM client_configs WHERE fingerprint = ?',
    ).bind('fp1').first<{ server_config: string; params: string }>();
    expect(JSON.parse(row!.server_config)).toEqual({});
    expect(JSON.parse(row!.params)).toEqual({});
  });
});
