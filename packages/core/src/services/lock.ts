import { openSync, closeSync, writeSync, renameSync, unlinkSync, statSync } from 'fs';

/**
 * Cross-process advisory file lock (core-R2 / core-R4).
 *
 * panel 与 ctl 是两个独立进程，同时写 ~/.singchorus/data 或同时驱动
 * docker compose 会出现 last-writer-wins 与工件交错。这里用「独占创建
 * 锁文件 + 陈旧锁回收」实现进程间互斥：
 *  - `openSync(path, 'wx')` 只有唯一赢家，跨平台原子；
 *  - 持锁进程崩溃不会永久卡死：锁文件 mtime 超过 staleMs 后可被抢占；
 *  - 等待方用同步 sleep 轮询（store 的同步 API 场景），或立刻失败
 *    （docker 生命周期操作的 409 语义）。
 */

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;

export class LockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Resource is locked by another process: ${lockPath}`);
    this.name = 'LockTimeoutError';
  }
}

/** Synchronous sleep that works on the Node.js main thread. */
function sleepSync(ms: number) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait unavailable (e.g. main-thread restriction) — fall back to a spin.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
  }
}

function tryAcquire(lockPath: string, staleMs: number): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    try { writeSync(fd, `${process.pid}\n`); } catch { /* diagnostics only */ }
    closeSync(fd);
    return true;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        // Steal a stale lock (holder crashed or hung). Rename-then-recreate
        // keeps the window tiny; a racing stealer simply loses the create.
        renameSync(lockPath, `${lockPath}.stale.${process.pid}`);
        try { unlinkSync(`${lockPath}.stale.${process.pid}`) } catch { /* ok */ }
        return tryAcquire(lockPath, staleMs);
      }
    } catch { /* lock vanished between stat and steal — retry */ }
    return false;
  }
}

export function releaseLock(lockPath: string) {
  try { unlinkSync(lockPath) } catch { /* already gone */ }
}

/**
 * Run `fn` while holding the lock, waiting up to timeoutMs for a concurrent
 * holder. Throws LockTimeoutError if the lock stays busy (timeoutMs: 0 makes
 * this a single attempt — use for fail-fast semantics).
 */
export function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): T {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquire(lockPath, staleMs)) break;
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath);
    sleepSync(RETRY_INTERVAL_MS);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}
