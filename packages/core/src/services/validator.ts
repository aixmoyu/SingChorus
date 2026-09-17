import { execFile } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID, createHash } from 'crypto';
import type { AppConfig } from '../schemas/config.js';
import { consoleLogger, type Logger } from '../logger.js';

interface ValidationResult {
  valid: boolean
  errors: string[]
}

/** Deterministic JSON serialization so identical configs hash identically
 *  regardless of key order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

// core-P1: 校验结果按内容去重（同 content 免检）+ 单飞合并 + 串行队列，
// 避免 docker run 校验把事件循环外的并发请求放大成多个 60s 级容器任务。
const CACHE_TTL_MS = 5 * 60_000;   // 镜像可能是 :latest，结果不宜缓存过久
const CACHE_MAX = 100;

function execFileAsync(cmd: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, encoding: 'utf-8' }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export class SingboxValidator {
  private image: string;
  private timeout: number;
  private prepull: boolean;
  private cache = new Map<string, { at: number; result: ValidationResult }>();
  private inflight = new Map<string, Promise<ValidationResult>>();
  /** Serializes docker validations: at most one `docker run` at a time. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    config: Pick<AppConfig, 'singbox_image' | 'validate_timeout_seconds' | 'prepull_singbox_image'>,
    private log: Logger = consoleLogger,
  ) {
    this.image = config.singbox_image || 'ghcr.io/sagernet/sing-box:latest';
    this.timeout = (config.validate_timeout_seconds || 30) * 1000;
    this.prepull = config.prepull_singbox_image ?? true;
  }

  /** All docker invocations use execFile argument arrays — no shell
   *  interpolation of image names or paths (core-R1). */
  private async prepullImage() {
    if (!this.prepull) return;
    try {
      await execFileAsync('docker', ['pull', this.image], 60_000);
    } catch {
      this.log.warn('failed to prepull sing-box image', { image: this.image });
    }
  }

  private async dockerAvailable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info'], 5_000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate a config. core-P1 mitigations:
   *  - content-hash cache: identical content within the TTL skips docker entirely
   *  - single-flight: concurrent identical requests share one in-flight run
   *  - queue: at most one docker validation runs at a time, so a burst of
   *    validation requests can never pile up parallel 60s containers
   */
  async validate(config: Record<string, unknown>): Promise<ValidationResult> {
    const key = createHash('sha256').update(stableStringify(config)).digest('hex');
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result;

    const running = this.inflight.get(key);
    if (running) return running;

    const task = this.enqueue(() => this.doValidate(config)).then((result) => {
      // Refresh-on-set keeps the map bounded: delete + re-insert ≈ LRU.
      this.cache.delete(key);
      this.cache.set(key, { at: Date.now(), result });
      if (this.cache.size > CACHE_MAX) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.inflight.delete(key);
      return result;
    }, (err: unknown) => {
      this.inflight.delete(key);
      throw err;
    });
    this.inflight.set(key, task);
    return task;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async doValidate(config: Record<string, unknown>): Promise<ValidationResult> {
    if (!await this.dockerAvailable()) {
      return { valid: true, errors: ['Docker not available, skipping validation'] };
    }
    await this.prepullImage();

    const checkDir = join(tmpdir(), randomUUID());
    mkdirSync(checkDir, { recursive: true });
    const tmpFile = join(checkDir, 'config.json');
    try {
      writeFileSync(tmpFile, JSON.stringify(config), 'utf-8');
      try { chmodSync(tmpFile, 0o644) } catch { /* best-effort */ }

      // execFile 传参不经过 shell，镜像名/路径中的特殊字符不会构成注入面。
      try {
        await execFileAsync(
          'docker',
          ['run', '--rm', '-v', `${tmpFile}:/etc/sing-box/config.json`, this.image, 'check', '-c', '/etc/sing-box/config.json'],
          this.timeout,
        );
        return { valid: true, errors: [] };
      } catch (err: any) {
        const stderr = err.stderr?.toString() || err.message || '';
        return { valid: false, errors: [stderr] };
      }
    } finally {
      try { unlinkSync(tmpFile) } catch { /* ok */ }
    }
  }
}
