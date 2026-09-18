import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../src/db/schema';

import m0001 from '../migrations/0001_init.sql?raw';

/**
 * CLOUD-C3 guard: migrations/ (wrangler d1 migrations apply) and the runtime
 * ensure-create path in db/schema.ts are two parallel sources of truth. On a
 * fresh database each produces the schema on its own — if they drift, new and
 * old databases diverge and queries behave differently depending on the
 * database's history. This test snapshots both shapes and requires them to be
 * structurally identical (column set + constraints + indexes; column order is
 * normalized away because ALTER TABLE ADD COLUMN appends).
 */

const MIGRATIONS = [m0001];

// FK-dependency order so drops never fail on enforcement differences.
const DROP_ORDER = [
  'protocol_instances',
  'subscriptions',
  'audit_logs',
  'tokens',
  'users',
  'templates',
  'nodes',
  'client_configs',
  'sub_delivery_cache',
];

function normSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Split a CREATE TABLE body into normalized, order-independent column/constraint defs. */
function columnDefs(createSql: string): string[] {
  const open = createSql.indexOf('(');
  const close = createSql.lastIndexOf(')');
  const body = createSql.slice(open + 1, close);
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(normSql).sort();
}

interface SchemaSnapshot {
  tables: Record<string, string[]>;
  indexes: Record<string, string>;
}

async function snapshot(db: D1Database): Promise<SchemaSnapshot> {
  const { results } = await db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
  ).all<{ type: string; name: string; sql: string }>();
  const tables: Record<string, string[]> = {};
  const indexes: Record<string, string> = {};
  for (const row of results ?? []) {
    if (row.type === 'table') tables[row.name] = columnDefs(row.sql);
    else if (row.type === 'index') indexes[row.name] = normSql(row.sql);
  }
  return { tables, indexes };
}

async function applyMigrations(db: D1Database): Promise<void> {
  for (const file of MIGRATIONS) {
    const statements = file
      .replace(/^\s*--.*$/gm, '') // strip line comments
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        await db.prepare(stmt).run();
      } catch {
        // Idempotent statements (CREATE TABLE IF NOT EXISTS) may no-op-fail
        // on re-apply; the snapshot below is what actually asserts shape.
      }
    }
  }
}

describe('schema fingerprint (CLOUD-C3)', () => {
  it('runtime ensure-create schema matches the migrations chain', async () => {
    const db = (env as any).DB as D1Database;

    // Shape A: database built purely by the migrations chain.
    await applyMigrations(db);
    const migrated = await snapshot(db);

    // Reset, then build Shape B purely by the runtime ensure-create path.
    for (const table of DROP_ORDER) {
      await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }
    await initializeDatabase(db);
    const runtime = await snapshot(db);

    expect(Object.keys(runtime.tables).sort()).toEqual(Object.keys(migrated.tables).sort());
    expect(runtime.tables).toEqual(migrated.tables);
    expect(runtime.indexes).toEqual(migrated.indexes);
  });
});
