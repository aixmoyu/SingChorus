import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, renameSync, unlinkSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { LockTimeoutError, withFileLockSync } from './lock.js';
import { consoleLogger, type Logger } from '../logger.js';

const BACKUP_KEEP = 5;
const HEALTH_CHECK_TIMEOUT = 30;
const DOCKER_EXEC_TIMEOUT = 60_000;

export class DockerError extends Error {
  constructor(message: string, public statusCode: number = 500) {
    super(message);
    this.name = 'DockerError';
  }
}

/** Thrown when a deploy/stop/restart is attempted while another is in flight. */
export class DeployInProgressError extends DockerError {
  code = 'DEPLOY_IN_PROGRESS';
  constructor() {
    super('Another deploy operation is already in progress', 409);
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** 上次成功部署的元信息（写入 docker 目录的 deploy-meta.json）。 */
export interface DeployMeta {
  singboxVersion?: string
  singboxImage?: string
  deployedAt?: string
}

function execFileAsync(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout ?? DOCKER_EXEC_TIMEOUT, encoding: 'utf-8' }, (err: Error | null, stdout: string, stderr: string) => {
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

/**
 * Atomic in-place write: temp file + single rename (core-R3). A crash
 * mid-write can only leave the old file or the new file behind, never a
 * half-written artifact. The temp file is created in the target's own
 * directory — os.tmpdir() may live on a different filesystem (e.g. tmpfs
 * /tmp), and cross-device rename fails with EXDEV.
 */
function atomicWrite(filePath: string, data: string) {
  const tmp = join(dirname(filePath), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* ok */ }
    throw err;
  }
}

/**
 * Runs sing-box via docker compose. All deployable artifacts (compose yaml,
 * entry script, sing-box config) come from the cloud renderer — this class
 * only writes them to disk and drives `docker compose`. No local templates.
 */
export class DockerManager {
  private dockerDir: string;

  private log: Logger;

  /** Chain of in-flight lifecycle operations — serializes deploy/stop/restart. */
  private opQueue: Promise<unknown> = Promise.resolve();

  /** Set while a deploy is running so statusCompose can report 'deploying'. */
  private deploying = false;

  /** Cross-process deploy mutex file (core-R4): panel 与 ctl 双进程互斥。 */
  private deployLockPath: string;

  constructor(config: { docker_dir?: string }, log: Logger = consoleLogger) {
    this.dockerDir = config.docker_dir || join(process.env.HOME || '/tmp', '.singchorus', 'docker');
    this.deployLockPath = join(this.dockerDir, '.deploy.lock');
    this.log = log;
  }

  /**
   * Serialize lifecycle operations: each enqueued task runs only after the
   * previous one settles, so concurrent clicks can never interleave file
   * writes or docker commands. Rejections propagate to the caller of each
   * individual request without breaking the chain.
   */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opQueue.then(op, op);
    this.opQueue = run.catch(() => undefined);
    return run;
  }

  private withDeploying<T>(op: () => Promise<T>): Promise<T> {
    if (this.deploying) return Promise.reject(new DeployInProgressError());
    this.deploying = true;
    return this.enqueue(op).finally(() => { this.deploying = false; });
  }

  /**
   * Hold the cross-process deploy lock for the duration of an async lifecycle
   * op (core-R4). Fail-fast: a lock held by another process surfaces as 409,
   * matching the in-process semantics; stale locks (crashed holder) are
   * reclaimed by the lock helper.
   */
  private async withDeployLock<T>(op: () => Promise<T>): Promise<T> {
    mkdirSync(this.dockerDir, { recursive: true });
    let acquired = false;
    try {
      withFileLockSync(this.deployLockPath, () => undefined, { timeoutMs: 0 });
      acquired = true;
      return await op();
    } catch (err) {
      if (err instanceof LockTimeoutError) throw new DeployInProgressError();
      throw err;
    } finally {
      if (acquired) releaseDeployLock(this.deployLockPath);
    }
  }

  private composeArgs(...args: string[]): string[] {
    return ['compose', '-f', join(this.dockerDir, 'docker-compose.yml'), ...args];
  }

  private async run(args: string[], opts?: { timeout?: number }): Promise<string> {
    const result = await execFileAsync('docker', args, opts);
    return result.stdout;
  }

  private writeCompose(composeYaml: string) {
    mkdirSync(this.dockerDir, { recursive: true });
    atomicWrite(join(this.dockerDir, 'docker-compose.yml'), composeYaml.endsWith('\n') ? composeYaml : composeYaml + '\n');
  }

  private async writeEntry(entrySh: string) {
    const dataDir = join(this.dockerDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    // ACME certificate store — sing-box writes here, so it must be a host volume.
    const tlsDir = join(this.dockerDir, 'tls');
    if (!existsSync(tlsDir)) {
      mkdirSync(tlsDir, { recursive: true });
    }
    const entryPath = join(dataDir, 'entry.sh');
    atomicWrite(entryPath, entrySh.trimStart());
    await execFileAsync('chmod', ['755', entryPath], { timeout: 5_000 });
  }

  private writeConfig(config: Record<string, unknown>) {
    const dataDir = join(this.dockerDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    atomicWrite(join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
  }

  private backupConfig(): string | null {
    const configPath = join(this.dockerDir, 'data', 'config.json');
    if (!existsSync(configPath)) return null;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = join(this.dockerDir, 'data', `config.json.bak.${ts}`);
    copyFileSync(configPath, bakPath);
    this.pruneBackups();
    return bakPath;
  }

  private restoreConfig(bakPath: string | null) {
    if (!bakPath) return;
    const configPath = join(this.dockerDir, 'data', 'config.json');
    copyFileSync(bakPath, configPath);
  }

  private pruneBackups() {
    const dataDir = join(this.dockerDir, 'data');
    if (!existsSync(dataDir)) return;
    const backups = readdirSync(dataDir)
      .filter((f: string) => f.startsWith('config.json.bak.'))
      .sort()
      .reverse();
    if (backups.length > BACKUP_KEEP) {
      for (const old of backups.slice(BACKUP_KEEP)) {
        try { unlinkSync(join(dataDir, old)) } catch { /* ok */ }
      }
    }
  }

  /** Parse `docker compose ps --format json` output — one JSON object per
   *  line (NDJSON) or a single JSON array depending on compose version
   *  (core-R6). */
  private parseComposePs(out: string): Array<{ State?: string; Health?: string }> {
    const trimmed = out.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch { /* fall through to per-line parsing */ }
    const items: Array<{ State?: string; Health?: string }> = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        items.push(JSON.parse(l));
      } catch { /* skip malformed line */ }
    }
    return items;
  }

  private async composeContainers(): Promise<Array<{ State?: string; Health?: string }>> {
    const out = await this.run(this.composeArgs('ps', '--format', 'json'));
    return this.parseComposePs(out);
  }

  private async checkContainerHealth(timeout: number = HEALTH_CHECK_TIMEOUT): Promise<boolean> {
    const composePath = join(this.dockerDir, 'docker-compose.yml');
    if (!existsSync(composePath)) return false;
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      try {
        const containers = await this.composeContainers();
        if (containers.length > 0) {
          const running = containers.filter((c) => c.State === 'running');
          const allHealthy = running.length > 0 && running.every(
            (c) => !c.Health || c.Health === 'healthy',
          );
          if (allHealthy) return true;
        }
      } catch { /* not ready yet */ }
      await sleep(3000);
    }
    return false;
  }

  /**
   * Deploy with cloud-rendered artifacts. All three inputs are required —
   * the caller (core.deploy) obtains them from POST /api/render/deploy.
   * `meta` (optional) is persisted alongside the artifacts once the health
   * check passes, so the effective version/image of the last successful
   * deploy stays readable even when the container is stopped.
   */
  async deployRendered(
    serverConfig: Record<string, unknown>,
    composeYaml: string,
    entrySh: string,
    meta?: DeployMeta,
  ) {
    if (!composeYaml?.trim()) throw new DockerError('Cloud returned an empty compose yaml');
    if (!entrySh?.trim()) throw new DockerError('Cloud returned an empty entry script');

    return this.withDeploying(() => this.withDeployLock(() => this.deployRenderedLocked(serverConfig, composeYaml, entrySh, meta)));
  }

  private async deployRenderedLocked(
    serverConfig: Record<string, unknown>,
    composeYaml: string,
    entrySh: string,
    meta?: DeployMeta,
  ) {
    const startedAt = Date.now();
    const bak = this.backupConfig();
    this.writeCompose(composeYaml);
    await this.writeEntry(entrySh);
    this.writeConfig(serverConfig);

    try {
      this.log.info('docker: deploying compose stack');
      await this.run(this.composeArgs('up', '-d'));
      this.log.info('docker: containers started, waiting for health');
      if (!await this.checkContainerHealth()) {
        await this.run(this.composeArgs('down'));
        this.restoreConfig(bak);
        this.log.error('docker: deploy rolled back — containers not healthy in time', {
          timeoutSeconds: HEALTH_CHECK_TIMEOUT,
          durationMs: Date.now() - startedAt,
        });
        throw new DockerError(`Container failed to become healthy within ${HEALTH_CHECK_TIMEOUT}s`);
      }
      this.log.info('docker: deploy succeeded', { durationMs: Date.now() - startedAt });
      // 健康检查通过后才落盘元信息：回滚路径上不会留下"看似成功"的记录。
      if (meta) {
        try {
          atomicWrite(join(this.dockerDir, 'deploy-meta.json'), JSON.stringify(meta, null, 2));
        } catch { /* 元信息写失败不影响部署结果 */ }
      }
    } catch (err) {
      if (err instanceof DockerError) throw err;
      this.restoreConfig(bak);
      this.log.error('docker: deploy failed, restored previous config', {
        durationMs: Date.now() - startedAt,
        error: (err as any).stderr || ((err instanceof Error) ? err.message : String(err)),
      });
      throw new DockerError(`Deploy failed: ${(err as any).stderr || (err as any).message || 'unknown'}`);
    }
  }

  /**
   * Read the metadata of the last successful deploy. Returns null when the
   * file is missing (pre-feature deploy) or unreadable — callers show "unknown".
   */
  getDeployMeta(): DeployMeta | null {
    try {
      const raw = readFileSync(join(this.dockerDir, 'deploy-meta.json'), 'utf-8');
      const parsed = JSON.parse(raw) as DeployMeta;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async stopCompose() {
    return this.enqueue(() => this.withDeployLock(async () => {
      const composePath = join(this.dockerDir, 'docker-compose.yml');
      if (existsSync(composePath)) {
        await this.run(this.composeArgs('down'));
        this.log.info('docker: compose stack stopped');
      }
    }));
  }

  async restartCompose() {
    return this.enqueue(() => this.withDeployLock(async () => {
      const composePath = join(this.dockerDir, 'docker-compose.yml');
      if (existsSync(composePath)) {
        try {
          await this.run(this.composeArgs('restart'));
          this.log.info('docker: compose stack restarted');
        } catch {
          this.log.warn('docker: restart failed, recreating stack');
          await this.run(this.composeArgs('down'));
          await this.run(this.composeArgs('up', '-d'));
        }
      }
    }));
  }

  /** core-A3: 区分「docker 守护进程不可用」与「栈已停止」— 守护进程挂掉时
   *  把状态误报成 'stopped' 会误导用户以为服务已下线。 */
  private async dockerUnavailable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info'], { timeout: 5_000 });
      return false;
    } catch {
      return true;
    }
  }

  async statusCompose(): Promise<string> {
    // Surface the in-flight state first: docker ps during `compose up` may
    // still show nothing, and callers (UI) need to know an op is running.
    if (this.deploying) return 'deploying';
    const composePath = join(this.dockerDir, 'docker-compose.yml');
    if (!existsSync(composePath)) return 'stopped';
    try {
      const containers = await this.composeContainers();
      return containers.some((c) => c.State === 'running') ? 'running' : 'stopped';
    } catch {
      // core-A3: 观测失败时探测守护进程 —— 不可用返回 'unavailable'（面板
      // 显示为告警态并可重试），仅 compose 文件/输出异常时才报 'stopped'。
      if (await this.dockerUnavailable()) return 'unavailable';
      return 'stopped';
    }
  }

  async logsCompose(tail: number = 100): Promise<string> {
    const composePath = join(this.dockerDir, 'docker-compose.yml');
    if (!existsSync(composePath)) return '';
    try {
      return await this.run(this.composeArgs('logs', '--tail', String(tail)));
    } catch {
      return '';
    }
  }
}

function releaseDeployLock(lockPath: string) {
  // Simple unlink in the finally path — the lock helper's stale detection
  // covers any crash between acquire and release.
  try { unlinkSync(lockPath) } catch { /* already gone */ }
}
