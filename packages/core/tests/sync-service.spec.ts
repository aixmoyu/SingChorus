import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncService } from '../src/services/sync-service.js';

/** Minimal ChorusCore stub — SyncService only touches configs.listUnsynced
 *  and syncAllToCloud. */
function makeCore() {
  return {
    configs: { listUnsynced: vi.fn(() => []) },
    syncAllToCloud: vi.fn(),
  } as any;
}

/** Success result matching syncAllToCloud's contract (incl. push failures). */
const SYNC_RESULT = { synced: 0, skipped: 0, pulled: 0, deleted: 0, failures: [] };

describe('SyncService (core-R5 / 退避·单飞·定时器清理)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('trigger 成功后不安排任何退避定时器', async () => {
    const core = makeCore();
    core.syncAllToCloud.mockResolvedValue({ synced: 0 });
    const svc = new SyncService(core);

    await svc.trigger();
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(1);
    expect(svc.status.failCount).toBe(0);

    // 成功路径已清定时器：时间前进不应再触发任何同步轮
    await vi.advanceTimersByTimeAsync(900_000 + 1);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(1);
  });

  it('失败后按退避表调度重试，重试成功后 failCount 归零', async () => {
    const core = makeCore();
    core.syncAllToCloud
      .mockRejectedValueOnce(new Error('cloud unreachable'))
      .mockResolvedValue({ synced: 0 });
    const svc = new SyncService(core);

    await svc.trigger();
    expect(svc.status.failCount).toBe(1);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(1);

    // BACKOFF_MS[0] = 5s：提前不应触发
    await vi.advanceTimersByTimeAsync(4_999);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(2);
    expect(svc.status.failCount).toBe(0);
  });

  it('退避等待期间手动 trigger 成功 → 清掉到期定时器，不再冗余跑一轮（core-R5）', async () => {
    const core = makeCore();
    core.syncAllToCloud
      .mockRejectedValueOnce(new Error('cloud unreachable'))
      .mockResolvedValue({ synced: 0 });
    const svc = new SyncService(core);

    await svc.trigger(); // 失败，安排 5s 退避
    await svc.trigger(); // 手动触发，成功，应清退避定时器
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(900_000 + 1);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(2);
  });

  it('运行中的 trigger 合并（单飞），结束后补跑一轮处理 pending 变更', async () => {
    const core = makeCore();
    let release!: () => void;
    core.syncAllToCloud.mockImplementation(() => new Promise((res) => { release = () => res(SYNC_RESULT); }));
    const svc = new SyncService(core);

    const first = svc.trigger();
    // 第二次 trigger 落在运行窗口内：合并，不产生并发 run
    await svc.trigger();
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(1);

    release();
    await first;
    // finally 分支：pending 变更补跑一轮
    await vi.waitFor(() => expect(core.syncAllToCloud).toHaveBeenCalledTimes(2));
  });

  it('tick 在 pullInterval 窗口内且无未同步变更时不触发同步', async () => {
    const core = makeCore();
    core.syncAllToCloud.mockResolvedValue({ synced: 0 });
    const svc = new SyncService(core);

    await svc.tick(); // 首次 tick：lastSyncAt=0，超过 pullInterval → 跑一轮
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(1);

    await svc.tick(); // 600s 窗口内且无 unsynced → 跳过
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(1);
  });

  it('tick 窗口期内发现 unsynced 变更仍立即同步（变更不等定时器）', async () => {
    const core = makeCore();
    core.configs.listUnsynced.mockReturnValue([{ name: 'a' }]);
    core.syncAllToCloud.mockResolvedValue({ synced: 1 });
    const svc = new SyncService(core);

    await svc.tick();
    await svc.tick();
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(2);
  });

  it('连续失败时退避逐级递增并封顶 900s（BACKOFF_MS）', async () => {
    const core = makeCore();
    core.syncAllToCloud.mockRejectedValue(new Error('cloud unreachable'));
    const svc = new SyncService(core);

    await svc.trigger();                          // fail#1 → 5s
    await vi.advanceTimersByTimeAsync(5_000);     // fail#2 → 15s
    await vi.advanceTimersByTimeAsync(15_000);    // fail#3 → 60s
    await vi.advanceTimersByTimeAsync(60_000);    // fail#4 → 300s
    await vi.advanceTimersByTimeAsync(300_000);   // fail#5 → 900s（封顶）
    expect(svc.status.failCount).toBe(5);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(899_999);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(6);
  });

  it('dispose 清掉未到期的退避定时器（进程退出不拖尾）', async () => {
    const core = makeCore();
    core.syncAllToCloud.mockRejectedValue(new Error('x'));
    const svc = new SyncService(core);
    await svc.trigger();
    svc.dispose();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(core.syncAllToCloud).toHaveBeenCalledTimes(1);
  });

  it('status 运行中 syncing=true；结束后恢复 false', async () => {
    const core = makeCore();
    let release!: () => void;
    core.syncAllToCloud.mockImplementation(() => new Promise((res) => { release = () => res(SYNC_RESULT); }));
    const svc = new SyncService(core);

    const p = svc.trigger();
    expect(svc.status.syncing).toBe(true);
    release();
    await p;
    expect(svc.status.syncing).toBe(false);
    expect(svc.status.lastSyncAt).toBeGreaterThan(0);
  });

  it('status.pendingChanges 跟随 unsynced 列表', async () => {
    const core = makeCore();
    core.configs.listUnsynced.mockReturnValue([{ name: 'dirty' }]);
    const svc = new SyncService(core);
    expect(svc.status.pendingChanges).toBe(true);
    core.configs.listUnsynced.mockReturnValue([]);
    expect(svc.status.pendingChanges).toBe(false);
  });
});
