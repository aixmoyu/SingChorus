import type { ChorusCore } from '../core.js';
import { noopLogger, type Logger } from '../logger.js';

/**
 * Automatic sync orchestrator.
 *
 * The panel server calls `trigger()` after every local mutation (create /
 * update / enable / disable / delete). The first trigger runs immediately;
 * failures are retried in the background with exponential backoff so a
 * temporarily-unreachable cloud never loses a local change.
 *
 * core-D3 contract (binding for every driver of this class):
 *   - `tick()` must be invoked at intervals of ≥30s (panel: SYNC_TICK_MS in
 *     core-provider.ts). Every tick costs at least one KV list operation on
 *     the cloud; the Workers free tier allows ~1,000 list ops/day, so a
 *     faster tick can exhaust the daily quota (see pullIntervalMs below).
 *   - Config mutations must NOT wait for the tick — call trigger() instead.
 */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000];

export class SyncService {
  private running = false;
  private pending = false;
  private lastSyncAt = 0;
  private failCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Per-config push failures from the most recent round (empty = all green).
   *  Lets the panel UI explain a stuck 'pending' badge (CONS-PANEL-002). */
  private lastFailures: Array<{ name: string; message: string }> = [];
  /** Once disposed the instance must never self-revive via retry timers or
   *  pending re-runs — the panel rebuilds a fresh SyncService instead. */
  private disposed = false;

  constructor(private core: ChorusCore, private log: Logger = noopLogger) {}

  get status(): { syncing: boolean; lastSyncAt: number; pendingChanges: boolean; failCount: number; lastFailures: Array<{ name: string; message: string }> } {
    return {
      syncing: this.running || this.pending,
      lastSyncAt: this.lastSyncAt,
      pendingChanges: this.pending || this.core.configs.listUnsynced().length > 0,
      failCount: this.failCount,
      lastFailures: this.lastFailures,
    };
  }

  /**
   * Request a sync. Returns a promise that resolves once the triggered run
   * (not later retries) settles. Concurrent triggers coalesce into one run.
   */
  trigger(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      // A run is in flight; it will pick up the pending flag on completion.
      this.pending = true;
      return Promise.resolve();
    }
    // 直接起跑时不置 pending：否则本次 run 的 finally 会把 pending 误判为
    // 「运行期间落地的新变更」而再补跑一轮（core-R5 冗余同步）。
    return this.run();
  }

  /** Periodic tick — call every SYNC_INTERVAL_MS. Re-syncs when there are
   *  unsynced configs (retry) or on a long-enough interval (pull others). */
  async tick(): Promise<void> {
    if (this.disposed) return;
    const hasUnsynced = this.core.configs.listUnsynced().length > 0;
    if (!hasUnsynced && this.running) return;
    if (!hasUnsynced && Date.now() - this.lastSyncAt < this.pullIntervalMs) return;
    if (this.running) return;
    await this.run();
  }

  /**
   * Periodic full-sync interval (pull others' configs, retry stuck items).
   * Must stay generous: every tick consumes at least one KV list operation on
   * the cloud, and the Workers free tier only allows ~1,000 KV list ops per
   * day. Config changes do NOT wait for this timer — mutations trigger an
   * immediate sync via trigger().
   */
  private pullIntervalMs = 600_000;

  private async run(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const result = await this.core.syncAllToCloud();
      // Partial-result tolerance: legacy hosts/stubs may omit `failures`.
      const failures = result.failures ?? [];
      this.lastFailures = failures;
      this.failCount = 0;
      this.lastSyncAt = Date.now();
      this.log.info(failures.length > 0 ? 'sync completed with failures' : 'sync completed', {
        synced: result.synced,
        skipped: result.skipped,
        pulled: result.pulled,
        deleted: result.deleted,
        failed: failures.length,
        durationMs: Date.now() - startedAt,
      });
      // 成功即作废未到期的退避重试定时器（core-R5）：否则手动 trigger()
      // 成功后，退避定时器仍会再触发一轮完整同步，白白消耗云端 KV 额度。
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    } catch (err) {
      this.failCount++;
      const detail = err instanceof Error ? err.message : String(err);
      this.log.warn('sync failed, retrying with backoff', { failCount: this.failCount, error: detail });
      this.scheduleRetry();
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        // A mutation landed while we were syncing — run again.
        void this.run();
      }
    }
  }

  private scheduleRetry() {
    if (this.timer || this.disposed) return;
    const delay = BACKOFF_MS[Math.min(this.failCount - 1, BACKOFF_MS.length - 1)];
    this.log.info('sync retry scheduled', { delayMs: delay, failCount: this.failCount });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
    // Don't hold the event loop open just for a retry.
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as unknown as { unref(): void }).unref();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
