import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, utimesSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withFileLockSync, releaseLock, LockTimeoutError } from '../src/services/lock.js';

function newLockPath(): string {
  const dir = join(tmpdir(), `lock-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `test-${Math.random().toString(36).slice(2)}.lock`);
}

beforeEach(() => {
  try { rmSync(join(tmpdir(), `lock-test-${process.pid}`), { recursive: true, force: true }) } catch { /* ok */ }
});

describe('withFileLockSync（core-R2 / core-R4）', () => {
  it('持锁执行 fn 并在结束后释放（后续可再次获取）', () => {
    const p = newLockPath();
    const result = withFileLockSync(p, () => 42);
    expect(result).toBe(42);
    expect(existsSync(p)).toBe(false);
    expect(() => withFileLockSync(p, () => 'again')).not.toThrow();
  });

  it('锁被占用时等待至超时 → LockTimeoutError；释放后可获取', () => {
    const p = newLockPath();
    writeFileSync(p, '999\n'); // 模拟他人持锁
    expect(() => withFileLockSync(p, () => 1, { timeoutMs: 60 }))
      .toThrowError(LockTimeoutError);
    releaseLock(p);
    expect(() => withFileLockSync(p, () => 1, { timeoutMs: 0 })).not.toThrow();
  });

  it('timeoutMs: 0 → 单次尝试立即失败（fail-fast 语义）', () => {
    const p = newLockPath();
    writeFileSync(p, '999\n');
    const t0 = Date.now();
    expect(() => withFileLockSync(p, () => 1, { timeoutMs: 0 })).toThrowError(LockTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('陈旧锁（mtime 超过 staleMs）被自动回收，不再永久卡死', () => {
    const p = newLockPath();
    writeFileSync(p, 'crashed-holder\n');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(p, stale, stale);
    // 默认 staleMs 10s → 可抢占
    expect(() => withFileLockSync(p, () => 'stolen', { timeoutMs: 1000 })).not.toThrow();
    expect(existsSync(p)).toBe(false);
  });

  it('fn 抛错时锁也会释放（finally 语义）', () => {
    const p = newLockPath();
    expect(() => withFileLockSync(p, () => { throw new Error('boom'); })).toThrowError('boom');
    expect(() => withFileLockSync(p, () => 1, { timeoutMs: 0 })).not.toThrow();
  });
});
