import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ConfigEntry } from '../src/schemas/config.js';

export interface TestHome {
  base: string;
  dataDir: string;
  configsDir: string;
  enabledDir: string;
  disabledDir: string;
  historyDir: string;
  cleanup: () => void;
}

/**
 * store.ts 在 import 时根据 HOME 计算数据目录，因此依赖 LocalStore 的测试
 * 必须先改 HOME 再动态导入（beforeAll 中调用，随后 await import(...)）。
 * vitest 默认按文件隔离，每个 spec 文件独立设置 HOME 即互不干扰。
 */
export async function initTestHome(): Promise<TestHome> {
  const base = join(
    tmpdir(),
    `singchorus-core-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  process.env.HOME = base;
  const dataDir = join(base, '.singchorus', 'data');
  const configsDir = join(dataDir, 'configs');
  return {
    base,
    dataDir,
    configsDir,
    enabledDir: join(configsDir, 'enabled'),
    disabledDir: join(configsDir, 'disabled'),
    historyDir: join(configsDir, '.history'),
    cleanup: () => { try { rmSync(base, { recursive: true, force: true }) } catch { /* ok */ } },
  };
}

export function makeEntry(name: string, overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    name,
    node: 'default',
    type: 'simple',
    enabled: true,
    deployed: false,
    synced: false,
    content_hash: 'h-' + name,
    server_config: {},
    client_config: {},
    params: {},
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
