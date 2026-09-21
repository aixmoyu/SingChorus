import { LocalStore, DEFAULT_APP_CONFIG } from './services/store.js';
import { ConfigManager } from './services/config-manager.js';
import { CloudClient, REQUEST_BUDGET_MS } from './services/cloud-client.js';
import { SingboxValidator } from './services/validator.js';
import { DockerManager } from './services/docker-manager.js';
import { mergeServer, mergeSubscription } from './services/merger.js';
import type { ConfigEntry, SyncStatus, AppConfig, Subscription, NodeIdentity } from './schemas/config.js';
import { AppError, ERRORS } from './errors.js';
import { consoleLogger, type Logger } from './logger.js';
import { composeTag } from './tag.js';

/** Optional host-provided dependencies (logging, request tracing). */
export interface CoreOptions {
  /** Structured logger; defaults to plain console warn/error. */
  logger?: Logger;
  /**
   * Returns the current request id (if any) so outbound cloud calls can
   * forward `X-Request-ID` for cross-service tracing. Panel wires this to
   * its AsyncLocalStorage; CLI hosts omit it.
   */
  getRequestId?: () => string | undefined;
}

/** Reject if the promise hasn't settled within `ms` (core-P3 shared pull budget). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export class ChorusCore {
  readonly store: LocalStore;
  readonly configs: ConfigManager;
  readonly cloud: CloudClient;
  readonly validator: SingboxValidator;
  readonly docker: DockerManager;
  readonly logger: Logger;

  constructor(appConfig?: Partial<AppConfig>, options?: CoreOptions) {
    const cfg = { ...DEFAULT_APP_CONFIG, ...appConfig };
    this.logger = options?.logger ?? consoleLogger;
    this.store = new LocalStore(this.logger);
    this.configs = new ConfigManager(this.store);
    this.cloud = new CloudClient(cfg, { logger: this.logger, getRequestId: options?.getRequestId });
    this.validator = new SingboxValidator(cfg, this.logger);
    this.docker = new DockerManager({ docker_dir: appConfig?.docker_dir }, this.logger);
  }

  static fromStore(store: LocalStore): ChorusCore {
    const cfg = store.loadAppConfig();
    const core = new ChorusCore(cfg);
    return core;
  }

  getAppConfig(): AppConfig {
    return this.store.loadAppConfig();
  }

  updateAppConfig(cfg: Partial<AppConfig>): AppConfig {
    const current = this.store.loadAppConfig();
    const updated = { ...current, ...cfg };
    this.store.saveAppConfig(updated);
    return updated;
  }

  createConfig(data: { name: string; node?: string; type: string; server_config?: Record<string, unknown>; client_config?: Record<string, unknown>; params?: Record<string, unknown> }): ConfigEntry {
    return this.configs.add(
      data.name,
      data.node || 'default',
      data.type,
      data.server_config || {},
      data.client_config || {},
      data.params || {},
    );
  }

  // --- Node identity ---

  /** Stable per-install fingerprint, generated on first use. */
  getFingerprint(): string {
    return this.store.getFingerprint();
  }

  /**
   * Adopt a previous fingerprint (reinstall recovery): the cloud keeps
   * recognizing this node under its old identity so configs sync back.
   */
  importFingerprint(fp: string): string {
    return this.store.importFingerprint(fp);
  }

  /** Current node identity: fingerprint + configured name/address. */
  getIdentity(): NodeIdentity {
    const cfg = this.store.loadAppConfig();
    return {
      fingerprint: this.store.getFingerprint(),
      name: cfg.node_name || `node-${this.store.getFingerprint().slice(0, 8)}`,
      address: cfg.node_address,
    };
  }

  isInitialized(): boolean {
    const cfg = this.store.loadAppConfig();
    return Boolean(cfg.cloud_token) && Boolean(cfg.node_name);
  }

  metrics(): string {
    const all = this.configs.listAll();
    const enabled = all.filter(e => e.enabled);
    const unsynced = all.filter(e => !e.synced);
    return [
      `total_configs: ${all.length}`,
      `enabled_configs: ${enabled.length}`,
      `unsynced_configs: ${unsynced.length}`,
      `timestamp: ${new Date().toISOString()}`,
    ].join('\n');
  }

  /**
   * Render a protocol config via the cloud. When the caller leaves `tag`
   * empty, compose one locally as `<node-name>-<protocol>-<random>` (e.g.
   * `tokyo-01-hy2-x7k2m9`) so rendered configs are identifiable per node;
   * an explicit user tag passes through untouched — cloud's
   * resolveAndValidate gives user values precedence over generators.
   */
  async generateConfig(type: string, params: Record<string, unknown>) {
    if (!params.tag) {
      return this.cloud.generateConfig(type, { ...params, tag: composeTag(this.getIdentity().name, type) });
    }
    return this.cloud.generateConfig(type, params);
  }

  async generateAndAdd(name: string, node: string, type: string, params: Record<string, unknown>, enabled?: boolean): Promise<ConfigEntry> {
    const result = await this.generateConfig(type, params);
    this.configs.upsert(name, node, type, result.server_config, result.client_config, params);
    if (enabled === false) this.configs.disable(name);
    return this.configs.get(name);
  }

  async syncToCloud(name: string): Promise<void> {
    const entry = this.configs.get(name);

    const identity = this.getIdentity();
    await this.cloud.uploadNodeClient({
      name: entry.name,
      fingerprint: identity.fingerprint,
      config: entry.client_config,
      server_config: entry.server_config,
      params: entry.params,
      protocol_type: entry.type,
      content_hash: entry.content_hash,
      enabled: entry.enabled,
      deployed: Boolean(entry.deployed),
    });
    this.configs.markSynced(name);
  }

  /**
   * Full bidirectional sync:
   *  1. Register this node with the cloud (heartbeat).
   *  2. Push all local configs whose content or enabled flag changed.
   *  3. Reconcile: configs deleted locally are removed from the cloud.
   *  4. Pull every other node's configs into the local read-only store.
   *  5. Reconcile: remote configs deleted in the cloud are removed locally.
   */
  async syncAllToCloud(): Promise<{ synced: number; skipped: number; pulled: number; deleted: number; failures: Array<{ name: string; message: string }> }> {
    let synced = 0;
    let skipped = 0;
    let pulled = 0;
    let deleted = 0;
    // Per-config push failures (e.g. cloud 409 PORT_CONFLICT) — surfaced to
    // the panel UI so a permanently-stuck 'pending' badge is explainable
    // (CONS-PANEL-002) instead of only living in server logs.
    const failures: Array<{ name: string; message: string }> = [];

    const identity = this.getIdentity();

    // 1. Node heartbeat (best-effort — a registration failure shouldn't block config sync).
    try {
      await this.cloud.registerNode({
        fingerprint: identity.fingerprint,
        name: identity.name,
        address: identity.address,
      });
    } catch (err) {
      this.logger.warn('sync: node heartbeat failed', { error: err instanceof Error ? err.message : String(err) });
    }

    // 2. Push local configs.
    const remote = await this.cloud.listNodes().catch(() => [] as Record<string, unknown>[]);
    const otherFingerprints = new Set<string>(
      remote.map((n) => String(n.fingerprint ?? '')).filter(Boolean).filter((fp) => fp !== identity.fingerprint),
    );
    const cloudMap = new Map<string, Record<string, unknown>>();
    // getClients must succeed before acting: treating a failure as "cloud is
    // empty" would re-upload every config each tick. Abort this round instead;
    // SyncService retries with backoff.
    const cloudClients = await this.cloud.getClients().catch(() => null);
    if (cloudClients === null) {
      throw new Error('cloud client list unavailable — sync aborted this round');
    }
    for (const c of cloudClients) {
      // Only own configs count for push-reconciliation; other nodes' entries
      // are keyed by their own fingerprint.
      const owner = String(c.fingerprint ?? '');
      if (owner && owner !== identity.fingerprint) continue;
      const name = c.name as string | undefined;
      if (name) cloudMap.set(name, c);
    }

    for (const entry of this.configs.listAll()) {
      const cloudEntry = cloudMap.get(entry.name) ?? null;
      const status = this.configs.computeSyncStatus(entry, cloudEntry as any);
      // Push when content differs OR the local entry is flagged unsynced —
      // enable/disable only flips `enabled`, leaving content_hash unchanged.
      if (entry.synced && status === 'synced') continue;

      try {
        await this.cloud.uploadNodeClient({
          name: entry.name,
          fingerprint: identity.fingerprint,
          config: entry.client_config,
          server_config: entry.server_config,
          params: entry.params,
          protocol_type: entry.type,
          content_hash: entry.content_hash,
          enabled: entry.enabled,
          deployed: Boolean(entry.deployed),
        });
        this.configs.markSynced(entry.name);
        synced++;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.warn('sync: upload failed', { config: entry.name, error: detail });
        failures.push({ name: entry.name, message: detail });
        skipped++;
      }
    }

    // 3. Reconcile deletes: cloud entries with no local counterpart are stale —
    //    removed locally and never pushed back, so the subscription endpoint
    //    (which reads all client configs) stops serving them.
    //    Guard: a freshly reinstalled node has an empty local store — deleting
    //    there would wipe the cloud copies before restoreFromCloud() can bring
    //    them back. Skip with a warning; explicit deletes still work because
    //    they leave at least one config locally (guard requires a fully empty
    //    store).
    if (this.configs.listAll().length === 0 && cloudMap.size > 0) {
      this.logger.warn(
        'sync: local store is empty while the cloud still has this node\'s configs — delete-reconcile skipped (reinstall? run restore)',
        { cloud_configs: cloudMap.size },
      );
    } else {
      const localNames = new Set(this.configs.listAll().map((e) => e.name));
      for (const name of Array.from(cloudMap.keys())) {
        if (localNames.has(name)) continue;
        try {
          await this.cloud.deleteNodeClient(identity.fingerprint, name);
          deleted++;
        } catch (err) {
          // best-effort; retried on next sync since the entry stays in the cloud
          this.logger.warn('sync: delete in cloud failed', { config: name, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // 3. Pull other nodes' configs — in parallel under one shared time budget
    //    (core-P3): N slow/unreachable nodes no longer multiply the round
    //    duration (串行时为 节点数×25s，并行后整轮 ≤ 预算上限).
    //    core-D2: 直接复用 CloudClient 的请求预算常量，两处不再各自维护。
    const pullDeadline = Date.now() + REQUEST_BUDGET_MS;
    const localRemoteConfigs = this.store.listRemoteConfigs();
    await Promise.allSettled(Array.from(otherFingerprints).map(async (fp) => {
      try {
        const remaining = Math.max(0, pullDeadline - Date.now());
        const others = await withTimeout(this.cloud.getNodeClients(fp), remaining, `pull from node '${fp}'`);
        const byName = new Map(others.map((c) => [String(c.name), c]));
        pulled += others.length;

        for (const c of others) {
          const entry = this.toRemoteEntry(c, fp);
          if (entry) this.store.saveRemoteConfig(fp, entry);
        }

        // 4. Remove local copies of configs the owner has since deleted in the cloud.
        for (const local of localRemoteConfigs) {
          if (local.node_fingerprint === fp && !byName.has(local.name)) {
            this.store.deleteRemoteConfig(fp, local.name);
          }
        }
      } catch (err) {
        // this node's configs unavailable; keep local cache
        this.logger.warn('sync: pull from node failed', { node: fp, error: err instanceof Error ? err.message : String(err) });
      }
    }));
    return { synced, skipped, pulled, deleted, failures };
  }

  /**
   * Reinstall recovery: pull this node's own configs back down from the
   * cloud into the local (editable) store. Local entries always win —
   * existing names are skipped. Restored entries are marked synced and
   * deployed=false (the service must be re-deployed after a reinstall).
   */
  async restoreFromCloud(): Promise<{ restored: string[]; skipped: string[] }> {
    const identity = this.getIdentity();
    const cloudClients = await this.cloud.getNodeClients(identity.fingerprint);
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const c of cloudClients) {
      const name = String(c.name ?? '');
      if (!name) continue;
      try {
        const outcome = this.configs.restore({
          name,
          type: String(c.protocol_type ?? ''),
          server_config: (c.server_config && typeof c.server_config === 'object' ? c.server_config : {}) as Record<string, unknown>,
          client_config: (c.config && typeof c.config === 'object' ? c.config : {}) as Record<string, unknown>,
          params: (c.params && typeof c.params === 'object' ? c.params : {}) as Record<string, unknown>,
          enabled: c.enabled === undefined ? true : Boolean(c.enabled),
        });
        if (outcome === 'restored') restored.push(name);
        else skipped.push(name);
      } catch (err) {
        // Port conflicts etc. — surface per-config instead of aborting the batch.
        this.logger.warn('restore: config import failed', { config: name, error: err instanceof Error ? err.message : String(err) });
        skipped.push(name);
      }
    }
    this.logger.info('restore: pulled own configs from cloud', { restored: restored.length, skipped: skipped.length });
    return { restored, skipped };
  }

  /** Convert a cloud client record into a read-only remote ConfigEntry. */
  private toRemoteEntry(c: Record<string, unknown>, fingerprint: string): ConfigEntry | null {
    const name = String(c.name ?? '');
    if (!name) return null;
    return {
      name,
      node: String(c.node_id ?? ''),
      type: String(c.protocol_type ?? ''),
      enabled: Boolean(c.enabled),
      deployed: false,
      synced: true,
      content_hash: String(c.content_hash ?? ''),
      server_config: {},
      client_config: (c.config as Record<string, unknown>) ?? {},
      params: {},
      created_at: String(c.created_at ?? ''),
      updated_at: String(c.updated_at ?? ''),
      node_fingerprint: fingerprint,
    };
  }

  /** List configs owned by other machines (read-only, for display). */
  listRemoteConfigs(): ConfigEntry[] {
    return this.store.listRemoteConfigs();
  }

  /**
   * Read one remote config owned by another machine (read-only query).
   * core-D1: panel 的单条远端配置读取走此门面，不再深读 `core.store`。
   */
  getRemoteConfig(fingerprint: string, name: string): ConfigEntry | null {
    return this.store.loadRemoteConfig(fingerprint, name);
  }

  /** Delete a remote config locally and in the cloud. */
  async deleteRemoteConfig(fingerprint: string, name: string): Promise<void> {
    await this.cloud.deleteNodeClient(fingerprint, name);
    this.store.deleteRemoteConfig(fingerprint, name);
  }

  async getSyncStatus(name: string): Promise<SyncStatus> {
    const entry = this.configs.get(name);
    if (!entry.synced) return 'pending_upload';
    const identity = this.getIdentity();
    const others = await this.cloud.getNodeClients(identity.fingerprint);
    const cloudEntry = others.find((c) => String(c.name) === name) ?? null;
    return this.configs.computeSyncStatus(entry, cloudEntry as any);
  }

  async getAllSyncStatuses(): Promise<Record<string, SyncStatus>> {
    const entries = this.configs.listAll();
    const identity = this.getIdentity();
    const cloudClients = await this.cloud.getNodeClients(identity.fingerprint).catch(() => [] as Record<string, unknown>[]);
    const cloudMap = new Map<string, { content_hash?: string; name?: string }>();
    for (const c of cloudClients) {
      if (c.name) cloudMap.set(c.name as string, c as any);
    }
    const result: Record<string, SyncStatus> = {};
    for (const entry of entries) {
      const cloudEntry = cloudMap.get(entry.name) ?? null;
      result[entry.name] = this.configs.computeSyncStatus(entry, cloudEntry);
    }
    return result;
  }

  async generateServerConfig(): Promise<Record<string, unknown>> {
    const enabled = this.configs.listEnabled();
    if (enabled.length === 0) throw new AppError(ERRORS.CFG_NONE_ENABLED.code, ERRORS.CFG_NONE_ENABLED.message, ERRORS.CFG_NONE_ENABLED.status);
    return mergeServer(enabled);
  }

  async generateSubscription(): Promise<Record<string, unknown>> {
    const enabled = this.configs.listEnabled();
    if (enabled.length === 0) throw new AppError(ERRORS.CFG_NONE_ENABLED.code, ERRORS.CFG_NONE_ENABLED.message, ERRORS.CFG_NONE_ENABLED.status);
    return mergeSubscription(enabled);
  }

  async validate(config: Record<string, unknown>): Promise<{ valid: boolean; errors: string[] }> {
    return this.validator.validate(config);
  }

  /** Deploy the enabled configs. The server config and docker compose are
   *  rendered by the cloud from its templates — same source of truth as
   *  subscriptions. No local fallback: if the cloud can't render, deploy
   *  fails loudly instead of silently serving a stale local config. */
  async deploy() {
    const enabled = this.configs.listEnabled();
    if (enabled.length === 0) {
      throw new AppError(ERRORS.CFG_NONE_ENABLED.code, ERRORS.CFG_NONE_ENABLED.message, ERRORS.CFG_NONE_ENABLED.status);
    }

    const instances = enabled.map((e) => ({
      id: e.name,
      serverConfig: e.server_config,
      clientConfig: e.client_config,
    }));

    const rendered = await this.cloud.renderDeploy(instances);
    await this.docker.deployRendered(rendered.serverConfig, rendered.composeYaml, rendered.entrySh);
    // 部署成功：本批 enabled 配置进入部署集合（其余条目自动清出），随后由
    // panel 触发同步，把 deployed 状态上报云端供订阅过滤。
    this.configs.markDeployed(enabled.map((e) => e.name));
  }

  async stopDeploy() {
    await this.docker.stopCompose();
    // 停止部署：所有配置退出部署集合，订阅端不再生成这些节点。
    this.configs.markDeployed([]);
  }

  async restartDeploy() {
    await this.docker.restartCompose();
  }

  async deployStatus(): Promise<string> {
    return await this.docker.statusCompose();
  }

  async deployLogs(tail: number = 100): Promise<string> {
    return await this.docker.logsCompose(tail);
  }

  // --- Subscriptions ---

  async listSubscriptions(): Promise<Subscription[]> {
    return this.cloud.listSubscriptions();
  }

  async getSubscription(id: string): Promise<Subscription | null> {
    return this.cloud.getSubscription(id);
  }

  async createSubscription(data: Record<string, unknown>): Promise<Subscription> {
    return this.cloud.createSubscription(data);
  }

  async updateSubscription(id: string, data: Record<string, unknown>): Promise<Subscription> {
    return this.cloud.updateSubscription(id, data);
  }

  async deleteSubscription(id: string): Promise<void> {
    return this.cloud.deleteSubscription(id);
  }
}
