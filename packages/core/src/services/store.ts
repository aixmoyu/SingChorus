import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, chmodSync, statSync } from 'fs';
import { basename, dirname, join } from 'path';
import { randomUUID, randomBytes, createHash } from 'crypto';
import type { ConfigEntry, AppConfig } from '../schemas/config.js';
import { LockTimeoutError, withFileLockSync } from './lock.js';
import { consoleLogger, type Logger } from '../logger.js';
import { AppError, ERRORS } from '../errors.js';

const DATA_DIR = join(process.env.HOME || '/tmp', '.singchorus', 'data');
const CONFIGS_DIR = join(DATA_DIR, 'configs');
const ENABLED_DIR = join(CONFIGS_DIR, 'enabled');
const DISABLED_DIR = join(CONFIGS_DIR, 'disabled');
const HISTORY_DIR = join(CONFIGS_DIR, '.history');
const APP_CONFIG_FILE = join(DATA_DIR, 'app_config.json');
const FINGERPRINT_FILE = join(DATA_DIR, 'fingerprint');
const REMOTE_CONFIGS_DIR = join(DATA_DIR, 'remote-configs');
const LOCK_FILE = join(DATA_DIR, '.lock');
const MAX_HISTORY = 20;

export const DEFAULT_APP_CONFIG: AppConfig = {
  cloud_url: 'http://localhost:8787',
  cloud_token: '',
  singbox_image: 'ghcr.io/sagernet/sing-box:latest',
  singbox_version: '',
  validate_timeout_seconds: 30,
  prepull_singbox_image: true,
  node_name: '',
  node_address: '',
};

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function jsonPath(name: string, enabled: boolean) {
  const dir = enabled ? ENABLED_DIR : DISABLED_DIR;
  return join(dir, `${name}.json`);
}

function atomicWrite(filePath: string, data: string) {
  const tmp = join(dirname(filePath), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, data, 'utf-8');
  try { chmodSync(tmp, 0o600) } catch { /* chmod may fail on some platforms */ }
  renameSync(tmp, filePath);
}

function loadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch { return null }
}

function corruptStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Fingerprint charset guard — loose enough for user-chosen ids, strict
 *  enough to survive round-trips through URLs and file storage. */
export function isValidFingerprint(fp: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(fp);
}

/** Read the persisted fingerprint without creating one (empty when absent). */
function readStableFingerprint(): string {
  try {
    return readFileSync(FINGERPRINT_FILE, 'utf-8').trim();
  } catch { return '' }
}

/**
 * core-A1: 顶层 JSON 文件（app_config/state 等，无历史快照可恢复）损坏时
 * 不静默丢弃 —— 改名隔离保留现场供人工排查，然后返回 null 由调用方回退默认值。
 */
function loadJsonQuarantine<T>(filePath: string, log: Logger): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    if (existsSync(filePath)) {
      const quarantined = `${filePath}.corrupt-${corruptStamp()}`;
      try { renameSync(filePath, quarantined) } catch { /* best-effort */ }
      log.warn('store: file corrupted — quarantined', { filePath, quarantined });
    }
    return null;
  }
}

export class LocalStore {
  private initialized = false;
  private log: Logger;
  // core-P2: listConfigs 的目录级内存索引。签名 = enabled/disabled 两个目录的
  // mtime（atomicWrite/rename 均为换 dirent，必然更新目录 mtime），因此其他
  // 进程（panel/ctl 双进程）写入后签名变化、本缓存自动失效；本进程内的写操作
  // 额外显式失效，不依赖 mtime 精度。
  private configsCache: { sig: string; entries: ConfigEntry[] } | null = null;

  constructor(log: Logger = consoleLogger) {
    this.log = log;
  }

  private dirSignature(): string {
    const sig = (p: string) => {
      try { return String(statSync(p).mtimeMs) } catch { return 'missing' }
    };
    return `${sig(ENABLED_DIR)}|${sig(DISABLED_DIR)}`;
  }

  init() {
    // 先置位再执行：self-heal 内部会经 listHistory 重入 init，避免递归。
    if (this.initialized) return;
    this.initialized = true;
    ensureDir(ENABLED_DIR);
    ensureDir(DISABLED_DIR);
    ensureDir(HISTORY_DIR);
    this.repairLegacyDuplicates();
    this.selfHealCorruptedConfigs();
  }

  /**
   * core-A1: 启动自愈 —— 扫描 enabled/disabled 中的损坏 JSON，能从 .history
   * 最新快照恢复的自动恢复；无快照可用的改名隔离保留，避免配置静默消失。
   */
  private selfHealCorruptedConfigs() {
    for (const dir of [ENABLED_DIR, DISABLED_DIR]) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        if (loadJson<ConfigEntry>(join(dir, f)) === null) {
          this.repairOrQuarantine(dir, f);
        }
      }
    }
  }

  /**
   * core-A1: 处理单个损坏的配置文件 —— 优先从 .history 最新可解析快照原子写
   * 回（RPO = 最长 20 次变更前）；无快照可用时改名隔离保留现场。恢复后失效
   * 目录缓存，让后续 listConfigs 读到修复结果。
   */
  private repairOrQuarantine(dir: string, file: string): ConfigEntry | null {
    const path = join(dir, file);
    const name = file.slice(0, -'.json'.length);
    const snaps = this.listHistory(name);
    if (snaps.length > 0) {
      atomicWrite(path, JSON.stringify(snaps[0], null, 2));
      this.log.warn('store: config corrupted — restored from history snapshot', { config: name });
      this.configsCache = null;
      return snaps[0];
    }
    const quarantined = `${path}.corrupt-${corruptStamp()}`;
    try { renameSync(path, quarantined) } catch { /* best-effort */ }
    this.log.warn('store: config corrupted and no history snapshot exists — quarantined', { config: name, quarantined });
    return null;
  }

  /**
   * 修复历史版本遗留的 enabled/disabled 双份文件（core-C1 残留）：saveConfig
   * 已改为 rename 迁移 + 原子写，不会再产生双份，但旧数据目录可能仍残留。
   * loadConfig 语义是 enabled 优先，因此 enabled 侧文件可正常解析时删除
   * disabled 侧重复副本；enabled 侧损坏时保留双份，由 loadConfig 回退兜底。
   * 不加锁、尽力而为：panel 与 ctl 同时清理同一文件时单方 unlink 失败可容忍。
   */
  private repairLegacyDuplicates() {
    for (const f of readdirSync(DISABLED_DIR)) {
      if (!f.endsWith('.json')) continue;
      const enabledPath = join(ENABLED_DIR, f);
      if (!existsSync(enabledPath)) continue;
      if (loadJson<ConfigEntry>(enabledPath) !== null) {
        try { unlinkSync(join(DISABLED_DIR, f)) } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Serialize mutations across processes (core-R2): panel 与 ctl 是两个独立
   * 进程，共享同一数据目录。这里用独占锁文件串行化所有写操作，消除
   * last-writer-wins 丢更新与迁移半途状态。
   */
  private locked<T>(fn: () => T): T {
    this.init();
    try {
      return withFileLockSync(LOCK_FILE, fn);
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        throw new Error(`Data directory is busy (lock held by another process): ${LOCK_FILE}`);
      }
      throw err;
    }
  }

  saveConfig(entry: ConfigEntry) {
    this.locked(() => {
      const target = jsonPath(entry.name, entry.enabled);
      const other = jsonPath(entry.name, !entry.enabled);
      // 先用单次 rename 把另一状态目录的旧文件迁移到目标位置（POSIX rename
      // 原子覆盖），再原子写内容 —— 两步之间任何时刻中断都不会出现
      // enabled/disabled 双份并存（core-R2 / core-C1）。
      try { renameSync(other, target) } catch { /* no opposite-side file */ }
      atomicWrite(target, JSON.stringify(entry, null, 2));
      const historyDir = join(HISTORY_DIR, entry.name);
      ensureDir(historyDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      atomicWrite(join(historyDir, `${stamp}.json`), JSON.stringify(entry, null, 2));
      const snaps = readdirSync(historyDir).sort().reverse();
      if (snaps.length > MAX_HISTORY) {
        for (const old of snaps.slice(MAX_HISTORY)) {
          unlinkSync(join(historyDir, old));
        }
      }
      this.configsCache = null;
    });
  }

  loadConfig(name: string): ConfigEntry | null {
    this.init();
    for (const enabled of [true, false]) {
      const p = jsonPath(name, enabled);
      let entry = loadJson<ConfigEntry>(p);
      // core-A1: 文件存在但解析失败（运行期损坏）→ 尝试历史恢复/隔离。
      if (entry === null && existsSync(p)) {
        entry = this.repairOrQuarantine(dirname(p), basename(p));
      }
      if (entry !== null) return entry;
    }
    return null;
  }

  listConfigs(): ConfigEntry[] {
    this.init();
    const sig = this.dirSignature();
    if (this.configsCache && this.configsCache.sig === sig) {
      // 浅拷贝：调用方（如 markDeployed）会原地改条目顶层字段，不能污染缓存。
      return this.configsCache.entries.map(e => ({ ...e }));
    }
    const result: ConfigEntry[] = [];
    for (const dir of [ENABLED_DIR, DISABLED_DIR]) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const p = join(dir, f);
        let e = loadJson<ConfigEntry>(p);
        // core-A1: 损坏条目不静默跳过 —— 先恢复，恢复不了再隔离。
        if (e === null) e = this.repairOrQuarantine(dir, f);
        if (e) result.push(e);
      }
    }
    this.configsCache = { sig, entries: result };
    return result.map(e => ({ ...e }));
  }

  deleteConfig(name: string) {
    this.locked(() => {
      try { unlinkSync(jsonPath(name, true)) } catch { /* ok */ }
      try { unlinkSync(jsonPath(name, false)) } catch { /* ok */ }
      this.configsCache = null;
    });
  }

  configExists(name: string): boolean {
    this.init();
    return existsSync(jsonPath(name, true)) || existsSync(jsonPath(name, false));
  }

  isEnabled(name: string): boolean {
    this.init();
    return existsSync(jsonPath(name, true));
  }

  loadAppConfig(): AppConfig {
    this.init();
    // core-A1: 损坏时隔离保留现场，再回退默认值（无历史快照可恢复）。
    return { ...DEFAULT_APP_CONFIG, ...(loadJsonQuarantine<AppConfig>(APP_CONFIG_FILE, this.log) ?? {}) };
  }

  saveAppConfig(cfg: AppConfig) {
    this.locked(() => {
      atomicWrite(APP_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    });
  }

  listHistory(name: string): ConfigEntry[] {
    this.init();
    const dir = join(HISTORY_DIR, name);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).sort().reverse().map(f => {
      return loadJson<ConfigEntry>(join(dir, f));
    }).filter((e): e is ConfigEntry => e !== null);
  }

  // --- Node identity ---

  /**
   * Get the stable machine fingerprint, generating one on first use.
   * The fingerprint is a random 32-hex-char value persisted in the data dir —
   * it survives restarts and stays constant for the lifetime of the install.
   *
   * CHORUS_FINGERPRINT overrides (and re-persists over) the stored value, so a
   * reinstalled machine can reclaim its previous identity by setting the env
   * var once; every process afterwards reads the restored value from disk.
   */
  getFingerprint(): string {
    this.init();
    const fromEnv = process.env.CHORUS_FINGERPRINT?.trim();
    if (fromEnv && isValidFingerprint(fromEnv)) {
      const stored = readStableFingerprint();
      if (stored === fromEnv) return fromEnv;
      // 锁内写：panel/ctl 双进程可能同时带着 env 启动，写入需互斥。
      this.locked(() => {
        if (readStableFingerprint() === fromEnv) return;
        atomicWrite(FINGERPRINT_FILE, fromEnv);
        try { chmodSync(FINGERPRINT_FILE, 0o600) } catch { /* best-effort */ }
      });
      return fromEnv;
    }
    const existing = readStableFingerprint();
    if (existing) return existing;
    // 锁内生成：避免双进程同时发现文件缺失、各自生成不同指纹（core-R2）。
    return this.locked(() => {
      const existing = readStableFingerprint();
      if (existing) return existing;
      const fp = randomBytes(16).toString('hex');
      atomicWrite(FINGERPRINT_FILE, fp);
      try { chmodSync(FINGERPRINT_FILE, 0o600) } catch { /* best-effort */ }
      return fp;
    });
  }

  /**
   * Explicitly adopt a fingerprint (reinstall recovery). Validates the format
   * and overwrites the stored value — the cloud keeps recognizing this node
   * under its previous identity, letting configs sync back down.
   */
  importFingerprint(fp: string): string {
    this.init();
    const trimmed = fp.trim();
    if (!isValidFingerprint(trimmed)) {
      throw new AppError(
        ERRORS.INVALID_FINGERPRINT.code,
        `${ERRORS.INVALID_FINGERPRINT.message}: got '${trimmed.slice(0, 128)}'`,
        ERRORS.INVALID_FINGERPRINT.status,
      );
    }
    if (trimmed === readStableFingerprint()) return trimmed;
    this.locked(() => {
      atomicWrite(FINGERPRINT_FILE, trimmed);
      try { chmodSync(FINGERPRINT_FILE, 0o600) } catch { /* best-effort */ }
    });
    return trimmed;
  }

  // --- Remote configs (owned by other machines, read-only locally) ---

  /** Filenames for remote configs can't be trusted as keys, so we key by
   *  fingerprint+name hash to avoid path traversal and collisions. */
  private remoteConfigPath(fingerprint: string, name: string): string {
    const key = createHash('sha256').update(`${fingerprint}/${name}`).digest('hex').slice(0, 24);
    return join(REMOTE_CONFIGS_DIR, key + '.json');
  }

  saveRemoteConfig(fingerprint: string, entry: ConfigEntry) {
    this.locked(() => {
      ensureDir(REMOTE_CONFIGS_DIR);
      const payload = { ...entry, node_fingerprint: fingerprint };
      atomicWrite(this.remoteConfigPath(fingerprint, entry.name), JSON.stringify(payload, null, 2));
    });
  }

  loadRemoteConfig(fingerprint: string, name: string): ConfigEntry | null {
    this.init();
    return loadJson<ConfigEntry>(this.remoteConfigPath(fingerprint, name));
  }

  listRemoteConfigs(): ConfigEntry[] {
    this.init();
    if (!existsSync(REMOTE_CONFIGS_DIR)) return [];
    const result: ConfigEntry[] = [];
    for (const f of readdirSync(REMOTE_CONFIGS_DIR)) {
      if (f.endsWith('.json')) {
        const e = loadJson<ConfigEntry>(join(REMOTE_CONFIGS_DIR, f));
        if (e) result.push(e);
      }
    }
    return result;
  }

  deleteRemoteConfig(fingerprint: string, name: string) {
    this.locked(() => {
      try { unlinkSync(this.remoteConfigPath(fingerprint, name)) } catch { /* ok */ }
    });
  }
}
