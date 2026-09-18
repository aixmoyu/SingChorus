import type { AppConfig } from '../schemas/config.js';
import { AppError } from '../errors.js';
import { consoleLogger, type Logger } from '../logger.js';
interface CloudApiConfig {
  baseUrl: string
  authToken: string
}

interface RequestOptions {
  method: string
  path: string
  body?: unknown
  skipAuth?: boolean
  /** Skip the 5xx/network retry backoff — for best-effort calls where a slow
   * failure is worse than a fast one (e.g. tag-uniqueness pre-checks, where
   * the caller already treats any failure as "don't block"). */
  noRetry?: boolean
}

interface ApiResponse {
  status: number
  data: any
}

interface CachedToken {
  token: string
  exp: number  // seconds since epoch
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

const RETRY_DELAYS = [1000, 4000, 16000, 64000];
const DEFAULT_TIMEOUT = 10_000;

/** Summarize an error-response body for logs, e.g. `: [KV_UNAVAILABLE] Config
 *  storage temporarily unavailable`. Keeps panel logs actionable without
 *  dumping whole response bodies. */
function describeBody(data: any): string {
  if (!data) return '';
  if (data.error?.code || data.error?.message) {
    return `: [${data.error.code ?? 'UNKNOWN'}] ${data.error.message ?? ''}`;
  }
  if (typeof data.raw === 'string') return `: ${data.raw}`;
  return '';
}
/**
 * Overall budget for one logical request (all attempts + backoff sleeps).
 * Must stay below the panel frontend's 30s axios timeout — otherwise an
 * unreachable cloud surfaces to the user as an opaque axios timeout instead
 * of a proper error envelope.
 *
 * core-D2: this is a cross-module contract constant, exported from the
 * package root. The panel frontend (30s axios timeout in
 * `packages/panel/src/lib/http.ts`) and the core pull budget (core.ts) both
 * anchor on it — change it only together with those call sites.
 */
export const REQUEST_BUDGET_MS = 25_000;
const TOKEN_REFRESH_MARGIN = 60; // refresh 60s before expiry

export interface CloudClientOptions {
  logger?: Logger;
  /** Returns the current request id to forward as `X-Request-ID` (tracing). */
  getRequestId?: () => string | undefined;
}

export class CloudClient {
  private baseUrl: string;
  private authToken: string;
  private cachedToken: CachedToken | null = null;
  private logger: Logger;
  private getRequestId?: () => string | undefined;

  constructor(config: Partial<AppConfig> = {}, options?: CloudClientOptions) {
    this.baseUrl = (config.cloud_url || 'http://localhost:8787').replace(/\/+$/, '');
    this.authToken = config.cloud_token || '';
    this.logger = options?.logger ?? consoleLogger;
    this.getRequestId = options?.getRequestId;
  }

  /**
   * P1: 使用 AUTH_TOKEN 换取 JWT (24h 过期)
   * JWT 缓存在内存中，过期前自动刷新
   */
  private async ensureToken(): Promise<string> {
    if (!this.authToken) return '';

    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.exp > now + TOKEN_REFRESH_MARGIN) {
      return this.cachedToken.token;
    }

    // Login to get JWT
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this.authToken }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status !== 200) {
        // If login fails (e.g., Cloud not updated yet), fall back to static token
        return this.authToken;
      }

      const data = await res.json() as { accessToken?: string; expiresIn?: number };
      if (!data.accessToken || !data.expiresIn) {
        return this.authToken;
      }

      this.cachedToken = {
        token: data.accessToken,
        exp: now + data.expiresIn,
      };
      return this.cachedToken.token;
    } catch {
      clearTimeout(timer);
      // Fall back to static token if Cloud auth endpoint unavailable
      return this.authToken;
    }
  }

  /** Content-type + tracing headers, without auth (login / token refresh). */
  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const requestId = this.getRequestId?.();
    if (requestId) h['X-Request-ID'] = requestId;
    return h;
  }

  private async headers(): Promise<Record<string, string>> {
    const h = this.baseHeaders();
    const token = await this.ensureToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  /** Read a response body as JSON; non-JSON bodies (e.g. Cloudflare error
   * pages) resolve to a raw-text payload instead of throwing, so HTTP-level
   * failures are never misclassified as network errors by the retry loop. */
  private async readBody(res: Response): Promise<any> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.slice(0, 200) };
    }
  }

  private async request(opts: RequestOptions): Promise<ApiResponse> {
    const url = `${this.baseUrl}${opts.path}`;
    const label = `${opts.method} ${opts.path}`;
    const deadline = Date.now() + REQUEST_BUDGET_MS;
    let lastError: Error | undefined;
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const timeout = Math.min(DEFAULT_TIMEOUT, remaining);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const headers = opts.skipAuth
          ? this.baseHeaders()
          : await this.headers();
        const res = await fetch(url, {
          method: opts.method,
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const data = res.status === 204 ? null : await this.readBody(res);

        // If 401, clear cached token and retry once
        if (res.status === 401 && !opts.skipAuth) {
          this.cachedToken = null;
          if (attempt === 0) {
            // Retry with fresh token
            const freshHeaders = await this.headers();
            const retryController = new AbortController();
            const retryTimer = setTimeout(() => retryController.abort(), Math.min(DEFAULT_TIMEOUT, deadline - Date.now()));
            try {
              const retryRes = await fetch(url, {
                method: opts.method,
                headers: freshHeaders,
                body: opts.body ? JSON.stringify(opts.body) : undefined,
                signal: retryController.signal,
              });
              clearTimeout(retryTimer);
              const retryData = retryRes.status === 204 ? null : await this.readBody(retryRes);
              return { status: retryRes.status, data: retryData };
            } catch (err: any) {
              lastError = err;
            }
          }
        }

        if (res.status >= 500 && !opts.noRetry && attempt < RETRY_DELAYS.length - 1) {
          this.logger.warn(
            `cloud 5xx, retrying in ${RETRY_DELAYS[attempt] / 1000}s`,
            { request: label, attempt: attempt + 1, maxAttempts: RETRY_DELAYS.length, status: res.status, detail: describeBody(data) },
          );
          lastStatus = res.status;
          await sleep(Math.min(RETRY_DELAYS[attempt], Math.max(0, deadline - Date.now())));
          continue;
        }
        lastStatus = res.status;
        return { status: res.status, data };
      } catch (err: any) {
        lastError = err;
        lastStatus = undefined;
        const backoff = Math.min(RETRY_DELAYS[attempt], Math.max(0, deadline - Date.now()));
        if (!opts.noRetry && attempt < RETRY_DELAYS.length - 1 && backoff > 0) {
          this.logger.warn(
            `cloud request failed, retrying in ${backoff / 1000}s`,
            { request: label, attempt: attempt + 1, maxAttempts: RETRY_DELAYS.length, error: err?.message ?? String(err) },
          );
          await sleep(backoff);
          continue;
        }
      }
    }
    throw new AppError(
      'CLOUD_UNREACHABLE',
      `Cloud unreachable on ${label}` +
      (lastStatus !== undefined ? ` (last HTTP status ${lastStatus})` : ' (no response)') +
      `: ${lastError?.message ?? 'unknown error'} within ${REQUEST_BUDGET_MS / 1000}s. ` +
      'Check the cloud address / network path in panel settings.',
      503,
    );
  }

  async getProtocols(noRetry: boolean = false): Promise<any[]> {
    const resp = await this.request({ method: 'GET', path: '/api/protocols', noRetry });
    return resp.data?.protocols ?? [];
  }

  async getServerTemplates(): Promise<any[]> {
    const resp = await this.request({ method: 'GET', path: '/api/templates?category=server' });
    return resp.data?.templates ?? [];
  }

  async getClientTemplates(): Promise<any[]> {
    const resp = await this.request({ method: 'GET', path: '/api/templates?category=client' });
    return resp.data?.templates ?? [];
  }

  async getDockerTemplates(): Promise<any[]> {
    const resp = await this.request({ method: 'GET', path: '/api/templates?category=docker' });
    return resp.data?.templates ?? [];
  }

  async getTemplates(role?: string): Promise<any[]> {
    if (role) {
      const dispatch: Record<string, () => Promise<any[]>> = {
        protocol: () => this.getProtocols(),
        server: () => this.getServerTemplates(),
        client: () => this.getClientTemplates(),
        docker: () => this.getDockerTemplates(),
      };
      return dispatch[role]?.() ?? [];
    }
    const [p, s, c, d] = await Promise.all([
      this.getProtocols(),
      this.getServerTemplates(),
      this.getClientTemplates(),
      this.getDockerTemplates(),
    ]);
    return [...p, ...s, ...c, ...d];
  }

  async renderProtocol(
    protocolId: string,
    params: Record<string, unknown>,
  ): Promise<{ server_config: Record<string, unknown>; client_config: Record<string, unknown> }> {
    const resp = await this.request({
      method: 'POST',
      path: '/api/render',
      body: { protocolId, params },
    });
    if (resp.status !== 200) {
      const err = resp.data?.error || {};
      throw new AppError('CFG_GENERATE_FAILED', err.message || `Render failed: ${resp.status}`, 400);
    }
    return {
      server_config: resp.data.serverConfig ?? resp.data.server_config ?? {},
      client_config: resp.data.clientConfig ?? resp.data.client_config ?? {},
    };
  }

  async generateConfig(type: string, params: Record<string, unknown>) {
    return this.renderProtocol(type, params);
  }

  /**
   * Render everything needed to deploy this node's sing-box: combined server
   * config + docker compose + entry script, all from cloud templates. Same
   * source of truth as subscriptions — no local assembly.
   */
  async renderDeploy(instances: Array<{ id: string; serverConfig: Record<string, unknown>; clientConfig?: Record<string, unknown> }>): Promise<{
    serverConfig: Record<string, unknown>;
    composeYaml: string;
    entrySh: string;
  }> {
    const resp = await this.request({
      method: 'POST',
      path: '/api/render/deploy',
      body: { instances },
    });
    if (resp.status === 404) {
      // Cloud predates the deploy-render endpoint — caller falls back to local assembly.
      throw new AppError('CLOUD_ENDPOINT_MISSING', 'Cloud does not expose /api/render/deploy (update the cloud)', 502);
    }
    if (resp.status !== 200) {
      const err = resp.data?.error || {};
      throw new AppError('CLOUD_RENDER_DEPLOY_FAILED', err.message || `Deploy render failed: ${resp.status}`, 502);
    }
    return {
      serverConfig: resp.data.serverConfig ?? {},
      composeYaml: resp.data.composeYaml ?? '',
      entrySh: resp.data.entrySh ?? '',
    };
  }

  async getClients(): Promise<Record<string, unknown>[]> {
    const resp = await this.request({ method: 'GET', path: '/api/clients' });
    if (resp.status >= 400) {
      // Distinguish "cloud has no clients" from "cloud unavailable" (e.g. D1
      // outage → 503). Callers reconcile against this list; an
      // empty list on failure would trigger mass re-uploads.
      throw new Error(`cloud client list failed with status ${resp.status}`);
    }
    return resp.data?.clients ?? [];
  }

  /**
   * core-D1/CLOUD-D1: legacy single-segment client endpoints
   * (`GET/DELETE /api/clients/:name`, `PUT /api/clients`) were removed —
   * the cloud only serves fingerprint-namespaced routes
   * (`/api/clients/:fingerprint[/:name]`). Call the `*NodeClient` variants.
   */

  /**
   * Upload a config owned by this node. Keyed by fingerprint+name in the cloud
   * so two machines with the same config name no longer overwrite each other.
   */
  async uploadNodeClient(data: {
    name: string
    fingerprint: string
    config: Record<string, unknown>
    protocol_type: string
    content_hash: string
    enabled: boolean
    deployed: boolean
  }): Promise<Record<string, unknown>> {
    const resp = await this.request({
      method: 'PUT',
      path: `/api/clients/${encodeURIComponent(data.fingerprint)}/${encodeURIComponent(data.name)}`,
      body: {
        config: data.config,
        protocol_type: data.protocol_type,
        content_hash: data.content_hash,
        enabled: data.enabled,
        deployed: data.deployed,
      },
    });
    if (resp.status >= 400) {
      const err = resp.data?.error || {};
      throw new AppError('CLOUD_UPLOAD_FAILED', err.message || `Upload failed: ${resp.status}`, 502);
    }
    return resp.data?.client ?? {};
  }

  /** Fetch configs owned by a specific node fingerprint (empty for self). */
  async getNodeClients(fingerprint: string): Promise<Record<string, unknown>[]> {
    const resp = await this.request({
      method: 'GET',
      path: `/api/clients/${encodeURIComponent(fingerprint)}`,
    });
    if (resp.status === 404) return [];
    if (resp.status >= 400) {
      const err = resp.data?.error || {};
      throw new AppError('CLOUD_UNREACHABLE', err.message || `Fetch failed: ${resp.status}`, 502);
    }
    return resp.data?.clients ?? [];
  }

  /** Delete a config owned by the given node fingerprint. */
  async deleteNodeClient(fingerprint: string, name: string): Promise<void> {
    const resp = await this.request({
      method: 'DELETE',
      path: `/api/clients/${encodeURIComponent(fingerprint)}/${encodeURIComponent(name)}`,
    });
    if (resp.status === 404) return;
    if (resp.status >= 400) {
      const err = resp.data?.error || {};
      throw new AppError('CLOUD_DELETE_FAILED', err.message || `Delete failed: ${resp.status}`, 502);
    }
  }

  /** Register/heartbeat this node with the cloud (creates or updates the node row). */
  async registerNode(data: { fingerprint: string; name: string; address?: string }): Promise<void> {
    const resp = await this.request({
      method: 'POST',
      path: '/api/nodes/register',
      body: data,
    });
    if (resp.status >= 400) {
      const err = resp.data?.error || {};
      throw new AppError('CLOUD_UNREACHABLE', err.message || `Node registration failed: ${resp.status}`, 502);
    }
  }

  /** List all nodes known to the cloud. */
  async listNodes(): Promise<Record<string, unknown>[]> {
    const resp = await this.request({ method: 'GET', path: '/api/nodes' });
    return resp.data?.nodes ?? [];
  }

  /** Check whether a tag is globally unique in the cloud. */
  async checkTagAvailable(tag: string): Promise<boolean> {
    // noRetry: the caller treats any failure as "available" (creation is never
    // blocked by this pre-check), so retrying a 5xx for 25s only burns the
    // frontend's request budget and surfaces as an opaque timeout.
    const resp = await this.request({ method: 'GET', path: `/api/tags/check?tag=${encodeURIComponent(tag)}`, noRetry: true });
    if (resp.status >= 400) {
      // If the check endpoint is unavailable, don't block creation.
      return true;
    }
    return resp.data?.available !== false;
  }

  async getProtocolInstances(): Promise<any[]> {
    const resp = await this.request({ method: 'GET', path: '/api/protocol-instances' });
    return resp.data?.instances ?? [];
  }

  async listSubscriptions(): Promise<any[]> {
    const resp = await this.request({ method: 'GET', path: '/api/subscriptions' });
    return resp.data?.subscriptions ?? [];
  }

  async getSubscription(id: string): Promise<any> {
    const resp = await this.request({ method: 'GET', path: `/api/subscriptions/${encodeURIComponent(id)}` });
    return resp.data?.subscription ?? null;
  }

  async createSubscription(data: Record<string, unknown>): Promise<any> {
    const resp = await this.request({ method: 'POST', path: '/api/subscriptions', body: data });
    if (resp.status >= 400) {
      const issues = resp.data?.error?.issues;
      const detail = issues ? issues.map((i: any) => `${i.path?.join('.')}: ${i.message}`).join('; ') : resp.data?.error?.message;
      throw new AppError('CLOUD_CREATE_FAILED', detail || 'Cloud rejected the request', 502);
    }
    return resp.data?.subscription ?? null;
  }

  async updateSubscription(id: string, data: Record<string, unknown>): Promise<any> {
    const resp = await this.request({ method: 'PUT', path: `/api/subscriptions/${encodeURIComponent(id)}`, body: data });
    if (resp.status >= 400) {
      throw new AppError('CLOUD_UPDATE_FAILED', resp.data?.error?.message || 'Cloud rejected the request', 502);
    }
    return resp.data?.subscription ?? null;
  }

  async deleteSubscription(id: string): Promise<void> {
    const resp = await this.request({ method: 'DELETE', path: `/api/subscriptions/${encodeURIComponent(id)}` });
    if (resp.status >= 400) {
      throw new AppError('CLOUD_DELETE_FAILED', resp.data?.error?.message || 'Cloud rejected the request', 502);
    }
  }

}
