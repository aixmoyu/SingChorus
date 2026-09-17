import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { logger } from './logger.js'

export interface PanelConfig {
  admin_password_hash: string | null
  core_url: string
  core_token: string
  jwt_secret: string
  /** Bumped on every password change/setup; JWTs carry it and are rejected on mismatch. */
  token_version: number
  node_name: string
  node_address: string
  initialized: boolean
}

const DEFAULT_CONFIG: PanelConfig = {
  admin_password_hash: null,
  core_url: '',
  core_token: '',
  jwt_secret: '',
  token_version: 0,
  node_name: '',
  node_address: '',
  initialized: false,
}

/**
 * Historical "cloud not configured" value written by older panel versions.
 * One-time migrated to '' on read (see readConfigFromDisk); the effective
 * default cloud URL is resolved in core-provider.ts.
 */
const LEGACY_CORE_URL_SENTINEL = 'http://127.0.0.1:8080'

let cachedConfig: PanelConfig | null = null
let configMtime: number = 0
/** How long a cached config may skip the `statSync` revalidation (#14). */
const CACHE_TTL_MS = 500
let cachedAt: number = 0

const STORE_DIR = path.join(os.homedir(), '.singchorus', 'panel')

function getStoreDir(): string {
  return STORE_DIR
}

function getConfigPath(): string {
  return path.join(getStoreDir(), 'config.json')
}

function ensureDir(): void {
  const dir = getStoreDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function generateSecret(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function loadConfig(): PanelConfig {
  ensureDir()
  const file = getConfigPath()
  if (!fs.existsSync(file)) {
    cachedConfig = { ...DEFAULT_CONFIG, jwt_secret: generateSecret() }
    saveConfig(cachedConfig)
    configMtime = 0
    return cachedConfig
  }
  // Short TTL avoids a `statSync` on every request while still picking up
  // out-of-band edits shortly after they land on disk.
  if (cachedConfig && Date.now() - cachedAt < CACHE_TTL_MS) return cachedConfig
  const stat = fs.statSync(file)
  if (cachedConfig && stat.mtimeMs === configMtime) {
    cachedAt = Date.now()
    return cachedConfig
  }
  readConfigFromDisk(file)
  cachedAt = Date.now()
  return cachedConfig!
}

/** Re-read the config file into the cache (stat → parse → recover). */
function readConfigFromDisk(file: string): void {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PanelConfig>
    // One-time migration: collapse the legacy "unset" sentinel to '' so the
    // sentinel constant can eventually be dropped everywhere else.
    let migrated = false
    if (parsed.core_url === LEGACY_CORE_URL_SENTINEL) {
      parsed.core_url = ''
      migrated = true
    }
    cachedConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      jwt_secret: parsed.jwt_secret || generateSecret(),
    }
    if (migrated || !parsed.jwt_secret) saveConfig(cachedConfig)
    configMtime = fs.statSync(file).mtimeMs
  } catch (err) {
    logger.error({ err }, 'failed to read panel config, recreating')
    // Preserve the unreadable file for manual recovery before the reset
    // overwrites it (AVAIL-PANEL-003): the snapshot holds the password hash
    // and cloud connection settings that the fresh default loses.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* nothing to preserve */ }
    cachedConfig = { ...DEFAULT_CONFIG, jwt_secret: generateSecret() }
    saveConfig(cachedConfig)
    configMtime = 0
  }
}

export function saveConfig(cfg: PanelConfig): void {
  ensureDir()
  const filePath = getConfigPath()
  // Atomic write (tmp + rename): a crash mid-write can never leave a
  // half-written config.json behind (AVAIL-PANEL-003).
  const tmpPath = `${filePath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf-8')
  fs.renameSync(tmpPath, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* chmod may fail on some platforms */ }
  cachedConfig = cfg
  // Record the freshly written mtime — otherwise the next load beyond the TTL
  // would mistake our own write for an out-of-band edit and re-read (and
  // updateConfig's pre-write check would false-positive on every save).
  try { configMtime = fs.statSync(filePath).mtimeMs } catch { configMtime = 0 }
  cachedAt = Date.now()
}

/**
 * Read-modify-write a config update. Assumes a single panel process owns
 * config.json (no multi-instance guard; document this when scaling out).
 *
 * The pre-write mtime re-check guards against an out-of-band edit (manual
 * edit, another tool) landing on disk after our cached snapshot was taken:
 * in that case we reload the fresh copy from disk and apply the update on
 * top of it instead of clobbering it (CONS-PANEL-003).
 */
export function updateConfig(updates: Partial<PanelConfig>): PanelConfig {
  const cfg = loadConfig()
  let base = cfg
  try {
    const stat = fs.statSync(getConfigPath())
    if (cachedConfig && stat.mtimeMs !== configMtime) {
      base = loadConfigFresh()
    }
  } catch { /* file missing — proceed with the cached snapshot */ }
  const next: PanelConfig = { ...base, ...updates }
  saveConfig(next)
  return next
}

/** Force a disk re-read, bypassing the TTL cache (used before writes). */
function loadConfigFresh(): PanelConfig {
  const file = getConfigPath()
  readConfigFromDisk(file)
  cachedAt = Date.now()
  return cachedConfig!
}

/**
 * Process-wide write mutex for config mutations whose read-modify-write
 * spans an `await` (bcrypt hashing in the auth routes). Without it two
 * requests suspended at their await can resume and interleave
 * loadConfig→updateConfig, letting a stale snapshot overwrite a newer
 * password hash / token_version (RISK-PANEL-001).
 */
let configWriteQueue: Promise<unknown> = Promise.resolve()

export function runConfigExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = configWriteQueue.then(fn)
  configWriteQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function isFirstRun(): boolean {
  const cfg = loadConfig()
  return !cfg.admin_password_hash
}

/**
 * Whether the panel has completed the first-run wizard (password + node
 * identity + cloud connection). The wizard result is recorded explicitly so
 * re-running or skipping the cloud test can't silently un-initialize.
 */
export function isInitialized(): boolean {
  const cfg = loadConfig()
  return Boolean(cfg.initialized && cfg.admin_password_hash)
}

export function getStoreDirPath(): string {
  return getStoreDir()
}
