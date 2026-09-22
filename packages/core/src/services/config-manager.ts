import { LocalStore } from './store.js';
import { computeContentHash } from './hash.js';
import type { ConfigEntry, SyncStatus } from '../schemas/config.js';
import { AppError, ERRORS } from '../errors.js';

function now() {
  return new Date().toISOString();
}

/** Extract the effective port from a config entry (server listen_port first, then client server_port). */
export function extractConfigPort(entry: { server_config?: Record<string, unknown>; client_config?: Record<string, unknown> }): number | null {
  const raw = entry?.server_config?.listen_port ?? entry?.client_config?.server_port;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function makeEntry(name: string, node: string, type: string, server: Record<string, unknown>, client: Record<string, unknown>, params: Record<string, unknown>, enabled?: boolean, singboxVersion?: string): ConfigEntry {
  return {
    name, node, type,
    enabled: enabled ?? true,
    deployed: false,
    synced: false,
    content_hash: computeContentHash(server, client, params),
    server_config: server,
    client_config: client,
    params,
    created_at: now(),
    updated_at: now(),
    ...(singboxVersion !== undefined ? { singbox_version: singboxVersion } : {}),
  };
}

export class ConfigManager {
  constructor(private store: LocalStore) {}

  /** 生成/重生成时的版本快照（设计 §13.4）：本机 sing-box 版本 pin（'' = 未设置）。 */
  private currentSingboxVersion(): string {
    return this.store.loadAppConfig().singbox_version || '';
  }

  add(name: string, node: string, type: string, server: Record<string, unknown>, client: Record<string, unknown>, params: Record<string, unknown>): ConfigEntry {
    if (!name) throw new AppError(ERRORS.CFG_NAME_REQUIRED.code, ERRORS.CFG_NAME_REQUIRED.message, ERRORS.CFG_NAME_REQUIRED.status);
    if (this.store.configExists(name)) throw new AppError(ERRORS.CFG_DUPLICATE.code, ERRORS.CFG_DUPLICATE.message, ERRORS.CFG_DUPLICATE.status);
    this.assertNoPortConflict(name, { server_config: server, client_config: client });
    const entry = makeEntry(name, node, type, server, client, params, undefined, this.currentSingboxVersion());
    this.store.saveConfig(entry);
    return entry;
  }

  /** Upsert an entry built from rendered configs (used by generateAndAdd —
   *  no duplicate check: re-generating the same config overwrites it). */
  upsert(name: string, node: string, type: string, server: Record<string, unknown>, client: Record<string, unknown>, params: Record<string, unknown>): ConfigEntry {
    if (!name) throw new AppError(ERRORS.CFG_NAME_REQUIRED.code, ERRORS.CFG_NAME_REQUIRED.message, ERRORS.CFG_NAME_REQUIRED.status);
    const entry = makeEntry(name, node, type, server, client, params, undefined, this.currentSingboxVersion());
    this.store.saveConfig(entry);
    return entry;
  }

  /**
   * Restore a config pulled back from the cloud (reinstall recovery).
   * Skips when a local config with the same name already exists — local
   * edits always win. `deployed` resets to false: after a reinstall the
   * underlying service no longer runs until the config is re-deployed.
   */
  restore(input: {
    name: string
    type: string
    server_config: Record<string, unknown>
    client_config: Record<string, unknown>
    params: Record<string, unknown>
    enabled?: boolean
  }): 'restored' | 'skipped' {
    if (this.store.configExists(input.name)) return 'skipped';
    this.assertNoPortConflict(input.name, input);
    const entry = makeEntry(
      input.name, '', input.type,
      input.server_config, input.client_config, input.params,
      input.enabled ?? true,
    );
    this.store.saveConfig(entry);
    this.markSynced(input.name);
    return 'restored';
  }

  update(name: string, data: Partial<ConfigEntry>): ConfigEntry {
    const existing = this.get(name);
    const merged = { ...existing, ...data, name: existing.name };
    // Tag（配置名）创建后不可修改：params.tag / client_config.tag 必须与
    // 原值完全一致（含缺失状态），否则整个更新被拒绝。
    this.assertTagUnchanged('params.tag', existing.params?.tag, merged.params?.tag);
    this.assertTagUnchanged('client_config.tag', existing.client_config?.tag, merged.client_config?.tag);
    if (data.server_config || data.client_config || data.params) {
      this.assertNoPortConflict(name, merged);
      const nextHash = computeContentHash(
        merged.server_config,
        merged.client_config,
        merged.params,
      );
      // 内容真变更才失效同步/部署状态：键序不同但内容相同（hash 一致）的写入
      // 不应触发冗余重传与订阅下线。
      if (nextHash !== existing.content_hash) {
        merged.synced = false;
        // 内容已变，线上运行的实例与本条目不再一致：从订阅中隐藏直至重新部署。
        merged.deployed = false;
      }
      merged.content_hash = nextHash;
    }
    merged.updated_at = now();
    this.store.saveConfig(merged);
    return merged;
  }

  /** Tag（配置名）创建后不可修改：任一侧 tag 值（含缺失）不一致即拒绝。 */
  private assertTagUnchanged(field: string, before: unknown, after: unknown): void {
    if (before !== after) {
      throw new AppError(
        ERRORS.CFG_TAG_IMMUTABLE.code,
        `${ERRORS.CFG_TAG_IMMUTABLE.message}: '${field}' must stay '${String(before)}'`,
        ERRORS.CFG_TAG_IMMUTABLE.status,
      );
    }
  }

  /** Reject a new/changed config whose port collides with another config on this machine. */
  private assertNoPortConflict(excludeName: string, candidate: { server_config?: Record<string, unknown>; client_config?: Record<string, unknown> }): void {
    const port = extractConfigPort(candidate);
    if (port === null) return;
    const conflict = this.store.listConfigs().find((e) => e.name !== excludeName && extractConfigPort(e) === port);
    if (conflict) {
      throw new AppError(
        ERRORS.CFG_PORT_CONFLICT.code,
        `${ERRORS.CFG_PORT_CONFLICT.message}: port ${port} is used by '${conflict.name}'`,
        ERRORS.CFG_PORT_CONFLICT.status,
      );
    }
  }

  get(name: string): ConfigEntry {
    const entry = this.store.loadConfig(name);
    if (!entry) throw new AppError(ERRORS.CFG_NOT_FOUND.code, ERRORS.CFG_NOT_FOUND.message, ERRORS.CFG_NOT_FOUND.status);
    return entry;
  }

  listAll(): ConfigEntry[] {
    return this.store.listConfigs();
  }

  listEnabled(): ConfigEntry[] {
    return this.store.listConfigs().filter(e => e.enabled);
  }

  listUnsynced(): ConfigEntry[] {
    return this.store.listConfigs().filter(e => !e.synced);
  }

  listHistory(name: string): ConfigEntry[] {
    return this.store.listHistory(name);
  }

  delete(name: string) {
    if (!this.store.configExists(name)) throw new AppError(ERRORS.CFG_NOT_FOUND.code, ERRORS.CFG_NOT_FOUND.message, ERRORS.CFG_NOT_FOUND.status);
    this.store.deleteConfig(name);
  }

  enable(name: string) {
    if (!this.store.configExists(name)) throw new AppError(ERRORS.CFG_NOT_FOUND.code, ERRORS.CFG_NOT_FOUND.message, ERRORS.CFG_NOT_FOUND.status);
    const entry = this.store.loadConfig(name)!;
    entry.enabled = true;
    entry.synced = false;
    entry.updated_at = now();
    this.store.saveConfig(entry);
  }

  disable(name: string) {
    if (!this.store.configExists(name)) throw new AppError(ERRORS.CFG_NOT_FOUND.code, ERRORS.CFG_NOT_FOUND.message, ERRORS.CFG_NOT_FOUND.status);
    const entry = this.store.loadConfig(name)!;
    entry.enabled = false;
    // 未开启的配置不进入部署集合，也从订阅中隐藏。
    entry.deployed = false;
    entry.synced = false;
    entry.updated_at = now();
    this.store.saveConfig(entry);
  }

  /**
   * 标记最近一次成功部署的配置集合：名单内的条目 deployed=true，其余全部置 false。
   * deploy 成功后传入 enabled 名单；stop 成功后传入空名单。
   */
  markDeployed(names: string[]) {
    const deployedSet = new Set(names);
    for (const entry of this.store.listConfigs()) {
      const next = deployedSet.has(entry.name);
      if (Boolean(entry.deployed) === next) continue;
      entry.deployed = next;
      entry.synced = false;
      entry.updated_at = now();
      this.store.saveConfig(entry);
    }
  }

  markSynced(name: string) {
    const entry = this.get(name);
    entry.synced = true;
    entry.content_hash = computeContentHash(entry.server_config, entry.client_config, entry.params);
    entry.updated_at = now();
    this.store.saveConfig(entry);
  }

  computeSyncStatus(entry: ConfigEntry, cloudClient: { content_hash?: string; enabled?: boolean; deployed?: boolean; name?: string } | null): SyncStatus {
    if (!cloudClient) return 'pending_upload';
    const deployedMatches =
      Boolean(entry.deployed) === Boolean(cloudClient.deployed);
    if (
      entry.content_hash === (cloudClient.content_hash || '') &&
      entry.enabled === Boolean(cloudClient.enabled ?? true) &&
      deployedMatches
    ) {
      return 'synced';
    }
    return 'pending_update';
  }
}
