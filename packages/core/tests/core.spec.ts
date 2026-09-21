import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { initTestHome, makeEntry, type TestHome } from './helpers.js';
import type { ChorusCore } from '../src/core.js';
import type { ConfigEntry } from '../src/schemas/config.js';

/**
 * ChorusCore 编排层 ST：真实 LocalStore/ConfigManager + mock 的 CloudClient /
 * DockerManager（readonly 属性在运行时直接替换）。看护 syncAllToCloud 的
 * 推送/中止/删除/拉取对账语义与 deploy 编排 —— 这是持续迭代中最容易漂移的部分。
 */
let home: TestHome;
let ChorusCoreCtor: any;
let core: any;
let cloud: Record<string, any>;
let docker: Record<string, any>;

beforeAll(async () => {
  home = await initTestHome();
  ({ ChorusCore: ChorusCoreCtor } = await import('../src/core.js'));
  core = new ChorusCoreCtor();
  cloud = {
    generateConfig: vi.fn(),
    registerNode: vi.fn().mockResolvedValue(undefined),
    listNodes: vi.fn().mockResolvedValue([]),
    getClients: vi.fn().mockResolvedValue([]),
    uploadNodeClient: vi.fn(async () => ({})),
    deleteNodeClient: vi.fn().mockResolvedValue(undefined),
    getNodeClients: vi.fn().mockResolvedValue([]),
    renderDeploy: vi.fn(),
  };
  docker = {
    deployRendered: vi.fn().mockResolvedValue(undefined),
    stopCompose: vi.fn().mockResolvedValue(undefined),
  };
  core.cloud = cloud;
  core.docker = docker;
});

afterAll(() => home.cleanup());

/** 把所有未同步条目推上云端，并让 getClients 返回与本地一致的快照 —— 之后每个
 *  用例从「零推送」稳态出发，只断言自己引入的增量，避免用例间状态污染。 */
async function steadyState(): Promise<Record<string, any>[]> {
  await core.syncAllToCloud();
  const snapshot = cloudListSnapshot();
  cloud.getClients.mockResolvedValue(snapshot);
  return snapshot;
}

function cloudListSnapshot(extra: Record<string, unknown>[] = []): Record<string, any>[] {
  const fp = core.getFingerprint();
  return [
    ...core.configs.listAll().map((e: ConfigEntry) => ({
      name: e.name,
      fingerprint: fp,
      content_hash: e.content_hash,
      enabled: e.enabled,
      deployed: Boolean(e.deployed),
    })),
    ...extra,
  ];
}

describe('ChorusCore 基础编排', () => {
  it('空部署集合 → deploy 拒绝（CFG_NONE_ENABLED）', async () => {
    await expect(core.deploy()).rejects.toMatchObject({ code: 'CFG_NONE_ENABLED' });
  });

  it('createConfig 落盘；重名拒绝；node 缺省 default', () => {
    const e = core.createConfig({ name: 'cc-1', type: 'hysteria2', server_config: { type: 'hysteria2', listen_port: 9500 } });
    expect(e.node).toBe('default');
    expect(e.enabled).toBe(true);
    expect(() => core.createConfig({ name: 'cc-1', type: 'hysteria2', server_config: { listen_port: 9501 } }))
      .toThrowError(expect.objectContaining({ code: 'CFG_DUPLICATE' }));
  });

  it('generateAndAdd：云端渲染 → upsert（可覆盖同名）→ enabled=false 时禁用', async () => {
    cloud.generateConfig.mockResolvedValue({
      server_config: { type: 'vless', listen_port: 9600 },
      client_config: { type: 'vless', server_port: 9600 },
    });
    const e1 = await core.generateAndAdd('gen-1', 'edge', 'vless', { uuid: 'u1' });
    // tag 留空 → core 注入 <node-name>-<protocol>-<random>
    expect(cloud.generateConfig).toHaveBeenCalledWith('vless', expect.objectContaining({ uuid: 'u1', tag: expect.stringMatching(/^node-[a-z0-9]{8}-vless-[a-z0-9]{6}$/) }));
    expect(e1.enabled).toBe(true);
    expect(e1.server_config.listen_port).toBe(9600);
    // 重新生成同名配置 → 覆盖而不是报错
    const e2 = await core.generateAndAdd('gen-1', 'edge', 'vless', { uuid: 'u2' });
    expect(e2.params).toEqual({ uuid: 'u2' });
    const e3 = await core.generateAndAdd('gen-2', 'edge', 'vless', { uuid: 'u3' }, false);
    expect(e3.enabled).toBe(false);
  });

  it('generateConfig：用户显式 tag 原样透传；留空才注入节点前缀', async () => {
    cloud.generateConfig.mockResolvedValue({ server_config: {}, client_config: {} });
    // 显式 tag → 不改写
    await core.generateConfig('hysteria2', { tag: 'my-tag', domain: 'a.com' });
    expect(cloud.generateConfig).toHaveBeenLastCalledWith('hysteria2', { tag: 'my-tag', domain: 'a.com' });
    // 空串等价于未填 → 注入，且协议短名走映射（hysteria2 → hy2）
    await core.generateConfig('hysteria2', { domain: 'a.com', tag: '' });
    const called = cloud.generateConfig.mock.lastCall![1] as Record<string, unknown>;
    expect(called.tag).toMatch(/^node-[a-z0-9]{8}-hy2-[a-z0-9]{6}$/);
    // 后缀每次随机
    await core.generateConfig('hysteria2', { domain: 'a.com' });
    const again = cloud.generateConfig.mock.lastCall![1] as Record<string, unknown>;
    expect(again.tag).not.toBe(called.tag);
    // 节点名 slugify：空格/大写归一
    core.updateAppConfig({ node_name: 'Tokyo 01' });
    await core.generateConfig('vless-reality-vision', {});
    const slugged = cloud.generateConfig.mock.lastCall![1] as Record<string, unknown>;
    expect(slugged.tag).toMatch(/^tokyo-01-vless-[a-z0-9]{6}$/);
    core.updateAppConfig({ node_name: '' });
  });

  it('getIdentity：无 node_name 时回退 node-<fp8>；isInitialized 需要 token+node_name', () => {
    const id = core.getIdentity();
    expect(id.fingerprint).toBe(core.getFingerprint());
    expect(id.name).toBe(`node-${core.getFingerprint().slice(0, 8)}`);
    expect(core.isInitialized()).toBe(false);
    core.updateAppConfig({ cloud_token: 'tok', node_name: 'edge-0' });
    expect(core.isInitialized()).toBe(true);
    expect(core.getIdentity().name).toBe('edge-0');
  });

  it('metrics 反映条目统计', () => {
    const m = core.metrics();
    expect(m).toContain(`total_configs: ${core.configs.listAll().length}`);
    expect(m).toContain(`enabled_configs: ${core.configs.listAll().filter((e: ConfigEntry) => e.enabled).length}`);
    expect(m).toMatch(/unsynced_configs: \d+/);
  });
});

describe('ChorusCore.syncAllToCloud（双向对账）', () => {
  it('推送未同步的本机配置并标记 synced；云端一致后下一轮跳过', async () => {
    await steadyState();
    const baseline = cloud.uploadNodeClient.mock.calls.length;
    core.createConfig({ name: 'sync-1', type: 'hysteria2', server_config: { type: 'hysteria2', listen_port: 9700 } });

    const res = await core.syncAllToCloud();
    expect(cloud.registerNode).toHaveBeenCalled();
    expect(cloud.uploadNodeClient.mock.calls.length).toBe(baseline + 1);
    const arg = cloud.uploadNodeClient.mock.calls[baseline][0];
    expect(arg).toMatchObject({ name: 'sync-1', fingerprint: core.getFingerprint(), enabled: true, deployed: false });
    expect(arg.config).toEqual({}); // 上传的是 client_config（本条目仅配置了 server_config）
    expect(arg.protocol_type).toBe('hysteria2');
    expect(res.synced).toBe(1);
    expect(core.configs.get('sync-1').synced).toBe(true);

    // 下一轮：本地 synced 且云端一致 → 不再上传
    cloud.getClients.mockResolvedValue(cloudListSnapshot());
    const res2 = await core.syncAllToCloud();
    expect(res2.synced).toBe(0);
    expect(cloud.uploadNodeClient.mock.calls.length).toBe(baseline + 1);
  });

  it('getClients 失败 → 本轮中止（拒绝上传/删除），避免把「云端不可用」误判为「云端为空」', async () => {
    await steadyState();
    core.createConfig({ name: 'abort-1', type: 'hysteria2', server_config: { type: 'hysteria2', listen_port: 9701 } });
    cloud.getClients.mockRejectedValueOnce(new Error('503'));
    const upBefore = cloud.uploadNodeClient.mock.calls.length;
    const delBefore = cloud.deleteNodeClient.mock.calls.length;
    await expect(core.syncAllToCloud()).rejects.toThrow('cloud client list unavailable');
    expect(cloud.uploadNodeClient.mock.calls.length).toBe(upBefore);
    expect(cloud.deleteNodeClient.mock.calls.length).toBe(delBefore);
  });

  it('云端有、本地没有的旧条目 → 对账删除（订阅端停止分发）；他人节点的条目不参与对账', async () => {
    await steadyState();
    const fp = core.getFingerprint();
    cloud.getClients.mockResolvedValue(cloudListSnapshot([
      { name: 'ghost', fingerprint: fp, content_hash: 'x' },
      { name: 'others', fingerprint: 'fp-someone-else', content_hash: 'x' },
    ]));
    const res = await core.syncAllToCloud();
    expect(cloud.deleteNodeClient).toHaveBeenCalledWith(fp, 'ghost');
    expect(res.deleted).toBe(1);
    expect(res.synced).toBe(0);
  });

  it('拉取其他节点配置到只读缓存，并清理云端已删除的本地副本', async () => {
    await steadyState();
    cloud.listNodes.mockResolvedValue([{ fingerprint: 'fp-other', name: 'other' }]);
    cloud.getNodeClients.mockResolvedValue([
      { name: 'r-1', config: { type: 'vless' }, protocol_type: 'vless', content_hash: 'h', enabled: true, created_at: 'c', updated_at: 'u' },
    ]);
    core.store.saveRemoteConfig('fp-other', makeEntry('stale-r'));

    const res = await core.syncAllToCloud();
    expect(res.pulled).toBe(1);
    const remote = core.listRemoteConfigs().filter((e: ConfigEntry) => e.node_fingerprint === 'fp-other');
    expect(remote.map((e: ConfigEntry) => e.name).sort()).toEqual(['r-1']);
    expect(remote[0].client_config).toEqual({ type: 'vless' });

    // 下一轮远端为空 → 本地缓存里的 r-1/stale-r 均被清理
    cloud.getNodeClients.mockResolvedValue([]);
    await core.syncAllToCloud();
    expect(core.listRemoteConfigs().filter((e: ConfigEntry) => e.node_fingerprint === 'fp-other')).toEqual([]);
    cloud.listNodes.mockResolvedValue([]);
  });

  it('心跳失败不阻塞配置推送（best-effort）', async () => {
    await steadyState();
    cloud.registerNode.mockRejectedValueOnce(new Error('boom'));
    core.createConfig({ name: 'hb-1', type: 'hysteria2', server_config: { type: 'hysteria2', listen_port: 9702 } });
    const res = await core.syncAllToCloud();
    expect(res.synced).toBe(1);
    expect(core.configs.get('hb-1').synced).toBe(true);
  });

  it('单个配置上传失败计入 skipped，不拖垮整轮', async () => {
    await steadyState();
    cloud.uploadNodeClient.mockImplementation(async (arg: any) => {
      if (arg.name === 'skip-1') throw new Error('upload boom');
      return {};
    });
    core.createConfig({ name: 'skip-1', type: 'hysteria2', server_config: { type: 'hysteria2', listen_port: 9703 } });
    const res = await core.syncAllToCloud();
    expect(res.skipped).toBe(1);
    expect(res.synced).toBe(0);
    expect(core.configs.get('skip-1').synced).toBe(false);
    cloud.uploadNodeClient.mockImplementation(async () => ({}));
  });

  it('拉取预算（25s）内挂起的远端节点不会阻塞整轮（core-P3）', async () => {
    await steadyState();
    vi.useFakeTimers();
    cloud.listNodes.mockResolvedValue([{ fingerprint: 'fp-hang' }]);
    cloud.getNodeClients.mockImplementation(() => new Promise(() => { /* 永不返回 */ }));
    const pending = core.syncAllToCloud();
    const assertion = expect(pending).resolves.toMatchObject({ pulled: 0, synced: 0 });
    await vi.advanceTimersByTimeAsync(26_000);
    await assertion;
    vi.useRealTimers();
    cloud.listNodes.mockResolvedValue([]);
    cloud.getNodeClients.mockResolvedValue([]);
  });
});

describe('ChorusCore.deploy / stopDeploy', () => {
  it('deploy：云端渲染 → docker 落地 → 标记 enabled 集合 deployed', async () => {
    core.createConfig({ name: 'deploy-1', type: 'hysteria2', server_config: { type: 'hysteria2', listen_port: 9800 } });
    core.createConfig({ name: 'deploy-2', type: 'vless', server_config: { type: 'vless', listen_port: 9801 } });
    core.configs.disable('deploy-2');

    cloud.renderDeploy.mockResolvedValue({
      serverConfig: { type: 'hysteria2', listen_port: 9800 },
      composeYaml: 'services: {}',
      entrySh: '#!/bin/sh',
    });
    await core.deploy();

    expect(cloud.renderDeploy).toHaveBeenCalledTimes(1);
    const instances = cloud.renderDeploy.mock.calls[0][0]; // renderDeploy 直接接收实例数组
    expect(instances.map((i: any) => i.id)).toContain('deploy-1');
    expect(instances.map((i: any) => i.id)).not.toContain('deploy-2');
    expect(docker.deployRendered).toHaveBeenCalledWith(
      { type: 'hysteria2', listen_port: 9800 },
      'services: {}',
      '#!/bin/sh',
    );
    expect(core.configs.get('deploy-1').deployed).toBe(true);
    expect(core.configs.get('deploy-2').deployed).toBe(false);
  });

  it('stopDeploy：全部退出部署集合', async () => {
    await core.stopDeploy();
    expect(docker.stopCompose).toHaveBeenCalledTimes(1);
    expect(core.configs.get('deploy-1').deployed).toBe(false);
  });

  it('云端渲染失败 → deploy 失败且不标记 deployed（fail loud，不静默用旧配置）', async () => {
    docker.deployRendered.mockClear();
    cloud.renderDeploy.mockRejectedValueOnce(new Error('render failed'));
    await expect(core.deploy()).rejects.toThrow('render failed');
    expect(docker.deployRendered).not.toHaveBeenCalled();
    // 渲染失败不影响既有 deployed 状态
    expect(core.configs.get('deploy-2').deployed).toBe(false);
  });
});

describe('ChorusCore 同步状态查询', () => {
  it('本地未同步 → getSyncStatus 短路 pending_upload，不发起网络请求', async () => {
    core.createConfig({ name: 'st-1', type: 'hysteria2', server_config: { type: 'hysteria2', listen_port: 9900 } });
    cloud.getNodeClients.mockClear();
    await expect(core.getSyncStatus('st-1')).resolves.toBe('pending_upload');
    expect(cloud.getNodeClients).not.toHaveBeenCalled();
  });

  it('getAllSyncStatuses 依据云端列表对账各条目状态', async () => {
    const e = core.configs.get('st-1');
    cloud.getNodeClients.mockResolvedValueOnce([
      { name: 'st-1', content_hash: e.content_hash, enabled: true, deployed: false },
    ]);
    const statuses = await core.getAllSyncStatuses();
    expect(statuses['st-1']).toBe('synced');
    expect(statuses['deploy-2']).toBe('pending_upload'); // 云端列表无此条目
    cloud.getNodeClients.mockResolvedValue([]);
  });
});

describe('ChorusCore 远端配置管理', () => {
  it('deleteRemoteConfig：先删云端再删本地缓存；云端失败则本地保留', async () => {
    core.store.saveRemoteConfig('fp-x', makeEntry('dr-1'));
    await core.deleteRemoteConfig('fp-x', 'dr-1');
    expect(cloud.deleteNodeClient).toHaveBeenCalledWith('fp-x', 'dr-1');
    expect(core.store.loadRemoteConfig('fp-x', 'dr-1')).toBeNull();

    core.store.saveRemoteConfig('fp-x', makeEntry('dr-2'));
    cloud.deleteNodeClient.mockRejectedValueOnce(new Error('cloud 500'));
    await expect(core.deleteRemoteConfig('fp-x', 'dr-2')).rejects.toThrow('cloud 500');
    // 云端删除失败 → 本地缓存保留（下次重试）
    expect(core.store.loadRemoteConfig('fp-x', 'dr-2')).not.toBeNull();
  });
});

describe('ChorusCore 重装恢复（指纹 + 云端配置回拉）', () => {
  it('importFingerprint：合法指纹落盘生效；非法指纹拒绝（INVALID_FINGERPRINT）', () => {
    const original = core.getFingerprint();
    const fp = core.importFingerprint('recovered-fp-0123456789');
    expect(fp).toBe('recovered-fp-0123456789');
    expect(core.getFingerprint()).toBe('recovered-fp-0123456789');
    // 前后空白被 trim
    expect(core.importFingerprint('  abcd1234  ')).toBe('abcd1234');
    expect(() => core.importFingerprint('short')).toThrowError(expect.objectContaining({ code: 'INVALID_FINGERPRINT' }));
    expect(() => core.importFingerprint('bad fp!')).toThrowError(expect.objectContaining({ code: 'INVALID_FINGERPRINT' }));
    // 恢复原指纹，避免污染后续用例
    core.importFingerprint(original);
  });

  it('CHORUS_FINGERPRINT 环境变量覆盖并持久化（重装后一次性声明身份）', () => {
    const original = core.getFingerprint();
    process.env.CHORUS_FINGERPRINT = 'env-fp-0123456789';
    try {
      expect(core.getFingerprint()).toBe('env-fp-0123456789');
    } finally {
      delete process.env.CHORUS_FINGERPRINT;
    }
    // env 撤销后沿用已持久化的值，不回退随机生成
    expect(core.getFingerprint()).toBe('env-fp-0123456789');
    core.importFingerprint(original);
  });

  it('restoreFromCloud：云端配置拉回本地并标记 synced；本地同名条目优先保留', async () => {
    cloud.getNodeClients.mockResolvedValue([
      {
        name: 'rest-1', config: { type: 'vless', server_port: 9001 },
        server_config: { type: 'vless', listen_port: 9001 }, params: { uuid: 'u' },
        protocol_type: 'vless', content_hash: 'h1', enabled: true, deployed: true,
      },
      { name: 'rest-2', config: { type: 'hy2' }, protocol_type: 'hysteria2', content_hash: 'h2', enabled: false },
    ]);
    core.createConfig({ name: 'rest-2', type: 'hysteria2', server_config: { type: 'hysteria2', listen_port: 9111 } });

    const res = await core.restoreFromCloud();
    expect(res.restored).toEqual(['rest-1']);
    expect(res.skipped).toEqual(['rest-2']);

    const restored = core.configs.get('rest-1');
    expect(restored.synced).toBe(true);
    expect(restored.deployed).toBe(false); // 重装后服务未运行，需重新部署
    expect(restored.server_config).toEqual({ type: 'vless', listen_port: 9001 });
    expect(restored.params).toEqual({ uuid: 'u' });
    expect(core.configs.get('rest-2').server_config.listen_port).toBe(9111);

    core.configs.delete('rest-1');
    core.configs.delete('rest-2');
    cloud.getNodeClients.mockResolvedValue([]);
  });

  it('本地为空且云端仍有本节点配置 → 跳过删除对账（防重装窗口误清云端）', async () => {
    const fp = core.getFingerprint();
    for (const e of core.configs.listAll()) core.configs.delete(e.name);
    cloud.deleteNodeClient.mockClear();
    cloud.getClients.mockResolvedValue([
      { name: 'cloud-1', fingerprint: fp, content_hash: 'x', enabled: true, deployed: false },
    ]);

    const res = await core.syncAllToCloud();
    expect(cloud.deleteNodeClient).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);

    cloud.getClients.mockResolvedValue([]);
  });
});
