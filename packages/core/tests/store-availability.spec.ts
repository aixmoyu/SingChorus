import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// store.ts 在 import 时根据 HOME 计算数据目录，因此先改 HOME 再动态导入。
const base = join(tmpdir(), `singchorus-test-${process.pid}-${Date.now()}`);
const DATA_DIR = join(base, '.singchorus', 'data');
const CONFIGS_DIR = join(DATA_DIR, 'configs');
const ENABLED_DIR = join(CONFIGS_DIR, 'enabled');
const DISABLED_DIR = join(CONFIGS_DIR, 'disabled');

// 动态导入后赋值
let LocalStore: any;

beforeAll(async () => {
  process.env.HOME = base;
  ({ LocalStore } = await import('../src/services/store.js'));
});

function makeEntry(name: string, overrides: Record<string, unknown> = {}) {
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

function quarantinedFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes('.corrupt-'));
}

describe('LocalStore availability self-heal (core-A1)', () => {
  it('recovers a corrupted config from the latest history snapshot on init', () => {
    const store = new LocalStore();
    store.saveConfig(makeEntry('a'));
    store.saveConfig({ ...makeEntry('a'), updated_at: '2026-01-02T00:00:00.000Z' });

    // 模拟磁盘损坏：enabled/a.json 写入非法 JSON
    writeFileSync(join(ENABLED_DIR, 'a.json'), '{corrupted!!', 'utf-8');

    // 新进程（新实例）启动自愈后应能读到该配置
    const recovered = new LocalStore().listConfigs().find((e: any) => e.name === 'a');
    expect(recovered).toBeDefined();
    expect(recovered.updated_at).toBe('2026-01-02T00:00:00.000Z');
    // 文件已被历史快照修复为合法 JSON
    expect(() => JSON.parse(readFileSync(join(ENABLED_DIR, 'a.json'), 'utf-8'))).not.toThrow();
  });

  it('quarantines a corrupted config that has no history snapshot', () => {
    mkdirSync(ENABLED_DIR, { recursive: true });
    mkdirSync(DISABLED_DIR, { recursive: true });
    writeFileSync(join(DISABLED_DIR, 'b.json'), 'not json at all', 'utf-8');

    const store = new LocalStore();
    expect(store.listConfigs().find((e: any) => e.name === 'b')).toBeUndefined();
    // 损坏文件被改名隔离保留，而不是静默消失
    expect(quarantinedFiles(DISABLED_DIR).some((f) => f.startsWith('b.json'))).toBe(true);
    expect(existsSync(join(DISABLED_DIR, 'b.json'))).toBe(false);
  });

  it('loadConfig also repairs a runtime-corrupted file', () => {
    const store = new LocalStore();
    store.saveConfig(makeEntry('c'));
    writeFileSync(join(ENABLED_DIR, 'c.json'), '{oops', 'utf-8');

    expect(new LocalStore().loadConfig('c')).not.toBeNull();
  });

  it('quarantines corrupted app_config.json and falls back to defaults', () => {
    new LocalStore(); // 触发 init 建目录
    writeFileSync(join(DATA_DIR, 'app_config.json'), '{{{', 'utf-8');

    const cfg = new LocalStore().loadAppConfig();
    expect(cfg.cloud_url).toBe('http://localhost:8787');
    expect(quarantinedFiles(DATA_DIR).some((f) => f.startsWith('app_config.json'))).toBe(true);
  });
});

describe('LocalStore 数据完整性（core-R2 / core-A1）', () => {
  it('fingerprint 跨实例稳定且为 32 位 hex', () => {
    const fp = new LocalStore().getFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(new LocalStore().getFingerprint()).toBe(fp);
  });

  it('saveAppConfig / loadAppConfig 往返且默认值兜底', () => {
    const store = new LocalStore();
    store.saveAppConfig({ ...store.loadAppConfig(), cloud_url: 'https://example.com', node_name: 'edge' });
    const cfg = new LocalStore().loadAppConfig();
    expect(cfg.cloud_url).toBe('https://example.com');
    expect(cfg.node_name).toBe('edge');
    expect(cfg.singbox_image).toBe('ghcr.io/sagernet/sing-box:latest');
  });

  it('历史快照数量封顶 20（保留最新）', () => {
    const HISTORY_DIR = join(CONFIGS_DIR, '.history');
    const dir = join(HISTORY_DIR, 'prune');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(dir, `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z.json`), JSON.stringify(makeEntry('prune')));
    }
    new LocalStore().saveConfig(makeEntry('prune'));
    const snaps = readdirSync(dir);
    expect(snaps.length).toBe(20);
    expect(snaps.some((f) => f.startsWith('2026-01-01T00-00-00'))).toBe(false); // 最旧的被清掉
    expect(snaps.some((f) => f.startsWith('2026-01-01T00-00-06'))).toBe(true);
  });

  it('清理历史遗留的 enabled/disabled 双份文件（enabled 侧健康时）', () => {
    mkdirSync(ENABLED_DIR, { recursive: true });
    mkdirSync(DISABLED_DIR, { recursive: true });
    writeFileSync(join(ENABLED_DIR, 'legacy.json'), JSON.stringify(makeEntry('legacy')));
    writeFileSync(join(DISABLED_DIR, 'legacy.json'), JSON.stringify(makeEntry('legacy', { enabled: false })));

    const entries = new LocalStore().listConfigs().filter((e: any) => e.name === 'legacy');
    expect(entries).toHaveLength(1);
    expect(existsSync(join(DISABLED_DIR, 'legacy.json'))).toBe(false);
    expect(existsSync(join(ENABLED_DIR, 'legacy.json'))).toBe(true);
  });

  it('远端配置按 fingerprint+name 哈希存储，节点间互不干扰', () => {
    const store = new LocalStore();
    const entry = makeEntry('shared');
    store.saveRemoteConfig('fp-A', entry);
    store.saveRemoteConfig('fp-B', entry);
    expect(store.listRemoteConfigs()).toHaveLength(2);
    expect(store.loadRemoteConfig('fp-A', 'shared')?.node_fingerprint).toBe('fp-A');
    store.deleteRemoteConfig('fp-A', 'shared');
    expect(store.loadRemoteConfig('fp-A', 'shared')).toBeNull();
    expect(store.loadRemoteConfig('fp-B', 'shared')).not.toBeNull();
  });

  it('listConfigs 缓存随外部进程写盘（目录签名变化）自动失效', () => {
    const store = new LocalStore();
    store.listConfigs(); // 建立缓存
    // 模拟另一进程（panel/ctl）直接写盘
    writeFileSync(join(ENABLED_DIR, 'external.json'), JSON.stringify(makeEntry('external')));
    expect(store.listConfigs().some((e: any) => e.name === 'external')).toBe(true);
  });
});

afterAll(() => {
  try { rmSync(base, { recursive: true, force: true }) } catch { /* ok */ }
});
