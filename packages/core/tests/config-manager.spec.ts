import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { initTestHome, type TestHome } from './helpers.js';
import type { LocalStore } from '../src/services/store.js';
import type { ConfigManager } from '../src/services/config-manager.js';
import type { ConfigEntry } from '../src/schemas/config.js';

// store.ts 在 import 时根据 HOME 计算数据目录，因此先改 HOME 再动态导入。
let home: TestHome;
let LocalStoreCtor: any;
let ConfigManagerCtor: any;
let computeContentHashFn: any;
let extractConfigPortFn: any;
let store: LocalStore;
let cm: ConfigManager;

beforeAll(async () => {
  home = await initTestHome();
  ({ LocalStore: LocalStoreCtor } = await import('../src/services/store.js'));
  ({ ConfigManager: ConfigManagerCtor } = await import('../src/services/config-manager.js'));
  ({ computeContentHash: computeContentHashFn } = await import('../src/services/hash.js'));
  ({ extractConfigPort: extractConfigPortFn } = await import('../src/services/config-manager.js'));
  store = new LocalStoreCtor();
  cm = new ConfigManagerCtor(store);
});

afterAll(() => home.cleanup());

const server = (port: number, extra: Record<string, unknown> = {}) => ({ type: 'hysteria2', listen: '::', listen_port: port, ...extra });
const errWith = (code: string) => expect.objectContaining({ code });

describe('ConfigManager.add', () => {
  it('创建 enabled 且未同步的条目，content_hash 覆盖内容', () => {
    const e = cm.add('add-1', 'default', 'hysteria2', server(8443), {}, {});
    expect(e.enabled).toBe(true);
    expect(e.synced).toBe(false);
    expect(e.deployed).toBe(false);
    expect(e.content_hash).toBe(computeContentHashFn(server(8443), {}, {}));
  });

  it('拒绝重名（CFG_DUPLICATE）和空名（CFG_NAME_REQUIRED）', () => {
    expect(() => cm.add('add-1', 'default', 'hysteria2', server(8444), {}, {})).toThrowError(errWith('CFG_DUPLICATE'));
    expect(() => cm.add('', 'default', 'hysteria2', server(8445), {}, {})).toThrowError(errWith('CFG_NAME_REQUIRED'));
  });

  it('端口冲突（server listen_port 与 client server_port 均检测），无效端口不误报', () => {
    cm.add('pc-a', 'default', 'hysteria2', server(9001), {}, {});
    expect(() => cm.add('pc-b', 'default', 'hysteria2', server(9001), {}, {}))
      .toThrowError(errWith('CFG_PORT_CONFLICT'));
    expect(() => cm.add('pc-b', 'default', 'hysteria2', server(9001), {}, {})).toThrowError(/port 9001/);
    // client_config.server_port 同样参与冲突检测
    expect(() => cm.add('pc-c', 'default', 'hysteria2', {}, { type: 'hysteria2', server_port: 9001 }, {}))
      .toThrowError(errWith('CFG_PORT_CONFLICT'));
    // 无有效端口（越界/缺失）→ 不做冲突检查
    expect(() => cm.add('pc-d', 'default', 'hysteria2', server(0), {}, {})).not.toThrow();
    expect(() => cm.add('pc-e', 'default', 'hysteria2', {}, { server_port: 70000 }, {})).not.toThrow();
  });
});

describe('ConfigManager.update', () => {
  it('内容变更 → synced 失效、deployed 撤销、hash 更新', () => {
    cm.add('upd-1', 'default', 'hysteria2', server(9100), {}, {});
    cm.markSynced('upd-1');
    cm.markDeployed(['upd-1']);
    const updated = cm.update('upd-1', { server_config: server(9101) });
    expect(updated.synced).toBe(false);
    expect(updated.deployed).toBe(false);
    expect(updated.content_hash).not.toBe(computeContentHashFn(server(9100), {}, {}));
  });

  it('仅变更非内容字段（node）→ 不失效同步状态', () => {
    cm.add('upd-2', 'default', 'hysteria2', server(9102), {}, {});
    cm.markSynced('upd-2');
    const updated = cm.update('upd-2', { node: 'edge-1' });
    expect(updated.synced).toBe(true);
    expect(updated.node).toBe('edge-1');
  });

  it('传入相同内容（仅键序不同）→ 不失效同步状态（hash 键序无关）', () => {
    cm.add('upd-3', 'default', 'hysteria2', server(9103), {}, {});
    cm.markSynced('upd-3');
    const reordered = { listen: '::', type: 'hysteria2', listen_port: 9103 };
    const updated = cm.update('upd-3', { server_config: reordered });
    expect(updated.synced).toBe(true);
    expect(updated.deployed).toBe(false); // 从未部署，保持 false
  });

  it('嵌套字段（users[].password）变更也必须改变 hash（订阅漂移回归）', () => {
    cm.add('upd-4', 'default', 'hysteria2', server(9104, { users: [{ name: 'u', password: 'old' }] }), {}, {});
    cm.markSynced('upd-4');
    const before = cm.get('upd-4').content_hash;
    const updated = cm.update('upd-4', {
      server_config: server(9104, { users: [{ name: 'u', password: 'new' }] }),
    });
    expect(updated.content_hash).not.toBe(before);
    expect(updated.synced).toBe(false);
  });

  it('更新引入端口冲突 → CFG_PORT_CONFLICT', () => {
    cm.add('upd-5', 'default', 'hysteria2', server(9200), {}, {});
    cm.add('upd-6', 'default', 'hysteria2', server(9201), {}, {});
    expect(() => cm.update('upd-6', { server_config: server(9200) }))
      .toThrowError(errWith('CFG_PORT_CONFLICT'));
  });

  it('更新不存在的条目 → CFG_NOT_FOUND；name 不可被覆盖', () => {
    expect(() => cm.update('nope', { node: 'x' })).toThrowError(errWith('CFG_NOT_FOUND'));
    cm.add('upd-7', 'default', 'hysteria2', server(9202), {}, {});
    const updated = cm.update('upd-7', { name: 'evil' } as Partial<ConfigEntry>);
    expect(updated.name).toBe('upd-7');
  });

  it('创建后 tag 不可修改（CFG_TAG_IMMUTABLE）：params.tag / client_config.tag 均冻结', () => {
    cm.add('tag-1', 'default', 'hysteria2', server(9203), { tag: 'fixed-tag' }, { tag: 'fixed-tag', domain: 'a.test' });
    // 改 params.tag → 拒绝
    expect(() => cm.update('tag-1', { params: { tag: 'renamed', domain: 'b.test' } }))
      .toThrowError(errWith('CFG_TAG_IMMUTABLE'));
    // 改 client_config.tag → 拒绝
    expect(() => cm.update('tag-1', { client_config: { tag: 'renamed' } }))
      .toThrowError(errWith('CFG_TAG_IMMUTABLE'));
    // 删除 tag → 同样视为改名，拒绝
    expect(() => cm.update('tag-1', { params: { domain: 'b.test' } }))
      .toThrowError(errWith('CFG_TAG_IMMUTABLE'));
    // tag 保持不变 → 正常更新内容
    const updated = cm.update('tag-1', {
      params: { tag: 'fixed-tag', domain: 'b.test' },
      client_config: { tag: 'fixed-tag' },
    });
    expect(updated.params).toEqual({ tag: 'fixed-tag', domain: 'b.test' });
  });
});

describe('ConfigManager.enable / disable', () => {
  it('enable 重置 synced；disable 撤销 deployed 并重置 synced', () => {
    cm.add('en-1', 'default', 'hysteria2', server(9300), {}, {});
    cm.markSynced('en-1');
    cm.disable('en-1');
    let e = cm.get('en-1');
    expect(e.enabled).toBe(false);
    expect(e.deployed).toBe(false);
    expect(e.synced).toBe(false);
    cm.enable('en-1');
    e = cm.get('en-1');
    expect(e.enabled).toBe(true);
    expect(e.synced).toBe(false);
  });

  it('enable/disable 在 enabled/disabled 目录间原子迁移，不残留双份', () => {
    cm.add('mig-1', 'default', 'hysteria2', server(9301), {}, {});
    expect(existsSync(join(home.enabledDir, 'mig-1.json'))).toBe(true);
    cm.disable('mig-1');
    expect(existsSync(join(home.enabledDir, 'mig-1.json'))).toBe(false);
    expect(existsSync(join(home.disabledDir, 'mig-1.json'))).toBe(true);
    cm.enable('mig-1');
    expect(existsSync(join(home.enabledDir, 'mig-1.json'))).toBe(true);
    expect(existsSync(join(home.disabledDir, 'mig-1.json'))).toBe(false);
  });

  it('操作不存在的条目 → CFG_NOT_FOUND', () => {
    expect(() => cm.enable('missing')).toThrowError(errWith('CFG_NOT_FOUND'));
    expect(() => cm.disable('missing')).toThrowError(errWith('CFG_NOT_FOUND'));
  });
});

describe('ConfigManager.markDeployed', () => {
  it('名单内 deployed=true，其余全部翻转为 false（集合语义）', () => {
    cm.add('dep-1', 'default', 'hysteria2', server(9400), {}, {});
    cm.add('dep-2', 'default', 'hysteria2', server(9401), {}, {});
    cm.add('dep-3', 'default', 'hysteria2', server(9402), {}, {});
    cm.markDeployed(['dep-1', 'dep-2']);
    expect(cm.get('dep-1').deployed).toBe(true);
    expect(cm.get('dep-2').deployed).toBe(true);
    expect(cm.get('dep-3').deployed).toBe(false);
    cm.markDeployed(['dep-3']);
    expect(cm.get('dep-1').deployed).toBe(false);
    expect(cm.get('dep-3').deployed).toBe(true);
    // 状态变化使 synced 失效，等待上报云端供订阅过滤
    expect(cm.get('dep-3').synced).toBe(false);
  });

  it('重复标记同一名单不产生额外变更', () => {
    cm.markDeployed(['dep-3']);
    expect(cm.get('dep-3').deployed).toBe(true);
    expect(cm.get('dep-3').synced).toBe(false);
  });
});

describe('ConfigManager.markSynced', () => {
  it('置 synced=true 并按当前内容重算 hash（篡改的 hash 被纠正）', () => {
    cm.add('ms-1', 'default', 'hysteria2', server(9500), {}, {});
    cm.update('ms-1', { synced: true, content_hash: 'tampered' } as Partial<ConfigEntry>);
    cm.markSynced('ms-1');
    const e = cm.get('ms-1');
    expect(e.synced).toBe(true);
    expect(e.content_hash).toBe(computeContentHashFn(server(9500), {}, {}));
  });
});

describe('ConfigManager.delete / list', () => {
  it('delete 移除条目；再删 → CFG_NOT_FOUND', () => {
    cm.add('del-1', 'default', 'hysteria2', server(9600), {}, {});
    cm.delete('del-1');
    expect(() => cm.get('del-1')).toThrowError(errWith('CFG_NOT_FOUND'));
    expect(() => cm.delete('del-1')).toThrowError(errWith('CFG_NOT_FOUND'));
  });

  it('listEnabled / listUnsynced 过滤正确', () => {
    cm.add('lt-1', 'default', 'hysteria2', server(9601), {}, {});
    cm.add('lt-2', 'default', 'hysteria2', server(9602), {}, {});
    cm.disable('lt-2');
    const names = (arr: ConfigEntry[]) => arr.map((e) => e.name);
    expect(names(cm.listEnabled())).toContain('lt-1');
    expect(names(cm.listEnabled())).not.toContain('lt-2');
    expect(names(cm.listUnsynced())).toContain('lt-1');
  });
});

describe('computeSyncStatus（推送判定核心）', () => {
  const entry = (over: Partial<ConfigEntry> = {}): ConfigEntry => ({
    name: 's', node: 'n', type: 't', enabled: true, synced: true, deployed: false,
    content_hash: 'h1', server_config: {}, client_config: {}, params: {},
    created_at: '', updated_at: '', ...over,
  });

  it('云端无此条目 → pending_upload', () => {
    expect(cm.computeSyncStatus(entry(), null)).toBe('pending_upload');
  });

  it('hash + enabled + deployed 全部一致 → synced', () => {
    expect(cm.computeSyncStatus(entry(), { content_hash: 'h1', enabled: true, deployed: false })).toBe('synced');
  });

  it('hash / enabled / deployed 任一不一致 → pending_update', () => {
    expect(cm.computeSyncStatus(entry(), { content_hash: 'h2', enabled: true, deployed: false })).toBe('pending_update');
    expect(cm.computeSyncStatus(entry(), { content_hash: 'h1', enabled: false, deployed: false })).toBe('pending_update');
    expect(cm.computeSyncStatus(entry({ deployed: true }), { content_hash: 'h1', enabled: true, deployed: false })).toBe('pending_update');
  });

  it('云端缺失字段时按宽松默认处理（enabled 缺省视为 true）', () => {
    expect(cm.computeSyncStatus(entry(), { content_hash: 'h1', deployed: false })).toBe('synced');
  });
});

describe('extractConfigPort', () => {
  it('优先 server listen_port，回退 client server_port，非法值返回 null', () => {
    expect(extractConfigPortFn({ server_config: { listen_port: 443 }, client_config: { server_port: 999 } })).toBe(443);
    expect(extractConfigPortFn({ client_config: { server_port: 999 } })).toBe(999);
    expect(extractConfigPortFn({ server_config: { listen_port: 0 } })).toBeNull();
    expect(extractConfigPortFn({ server_config: { listen_port: 70000 } })).toBeNull();
    expect(extractConfigPortFn({})).toBeNull();
  });
});

describe('computeContentHash', () => {
  it('键序无关（含嵌套层级）', () => {
    const a = computeContentHashFn(
      { type: 'hy2', tls: { enabled: true, cert: '/c' } },
      { type: 'hy2', server: '1.1.1.1' },
      { password: 'p' },
    );
    const b = computeContentHashFn(
      { tls: { cert: '/c', enabled: true }, type: 'hy2' },
      { server: '1.1.1.1', type: 'hy2' },
      { password: 'p' },
    );
    expect(a).toBe(b);
  });

  it('任一部分内容变化（含嵌套/数组元素）→ hash 变化', () => {
    const base = computeContentHashFn({ p: 1, users: [{ password: 'a' }] }, { q: 2 }, { r: 3 });
    expect(base).not.toBe(computeContentHashFn({ p: 2, users: [{ password: 'a' }] }, { q: 2 }, { r: 3 }));
    expect(base).not.toBe(computeContentHashFn({ p: 1, users: [{ password: 'b' }] }, { q: 2 }, { r: 3 }));
    expect(base).not.toBe(computeContentHashFn({ p: 1, users: [] }, { q: 2 }, { r: 3 }));
    expect(base).not.toBe(computeContentHashFn({ p: 1, users: [{ password: 'a' }] }, { q: 2 }, {}));
  });
});
