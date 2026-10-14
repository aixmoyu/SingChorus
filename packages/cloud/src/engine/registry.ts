import type { D1Database } from '@cloudflare/workers-types';
import {
  Protocol,
  OverallTemplate,
  Template,
  TemplateRow,
  parseTemplateRow,
} from './types';
import { resolveAndValidate } from './validator';
import { replacePlaceholders } from './interpolator';
import { renderDocker, type DockerOverrides } from './docker_renderer';
import { PluginError } from './errors';
import type { Logger } from '../logger';

export interface ProtocolInstanceConfig {
  id: string;
  serverConfig: Record<string, unknown>;
  clientConfig: Record<string, unknown>;
}

function normalizeToken(s: string): string {
  return s.replace(/\s+/g, '');
}

/** Normalized splice token for custom route rules (whitespace-insensitive). */
const ROUTE_RULES_TOKEN = normalizeToken('{{ route_rules }}');

/** Whether a rendered-template tree mentions the given (normalized) splice
 *  token anywhere — used to detect templates that would silently drop rules. */
function containsToken(node: unknown, token: string): boolean {
  if (typeof node === 'string') return normalizeToken(node).includes(token);
  if (Array.isArray(node)) return node.some((n) => containsToken(n, token));
  if (node && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).some((v) => containsToken(v, token));
  }
  return false;
}

function splicePlaceholders(
  node: unknown,
  replacements: Record<string, unknown[]>,
): unknown {
  if (Array.isArray(node)) {
    const result: unknown[] = [];
    for (const item of node) {
      if (typeof item === 'string') {
        const key = normalizeToken(item);
        if (key in replacements) {
          const repl = replacements[key];
          if (Array.isArray(repl)) result.push(...repl);
          else result.push(repl);
          continue;
        }
        result.push(item);
      } else if (item && typeof item === 'object') {
        result.push(splicePlaceholders(item, replacements));
      } else {
        result.push(item);
      }
    }
    return result;
  }
  if (node && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') {
        const normKey = normalizeToken(value);
        if (normKey in replacements) {
          result[key] = replacements[normKey];
          continue;
        }
        result[key] = value;
      } else if (value && typeof value === 'object') {
        result[key] = splicePlaceholders(value, replacements);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  return node;
}

// Cast a unified Template to the Protocol shape expected by existing rendering code.
function asProtocol(t: Template): Protocol {
  if (!t.serverTemplate || !t.clientTemplate) {
    throw new PluginError('PLG_UNKNOWN_TYPE', `Template '${t.id}' is not a protocol (missing server/client template)`);
  }
  return {
    id: t.id,
    category: 'protocol',
    name: t.name,
    version: t.version,
    serverTemplate: t.serverTemplate,
    clientTemplate: t.clientTemplate,
    params: t.params,
    description: t.description,
    singboxCompat: t.singboxCompat,
  } as Protocol;
}

function asOverall(t: Template): OverallTemplate {
  if (!t.templateContent) {
    throw new PluginError('PLG_UNKNOWN_TYPE', `Template '${t.id}' is not an overall template (missing templateContent)`);
  }
  return {
    id: t.id,
    category: t.category as any,
    name: t.name,
    version: t.version,
    templateContent: t.templateContent,
    config: t.config,
    entryScript: t.entryScript,
    description: t.description,
    singboxCompat: t.singboxCompat,
  } as OverallTemplate;
}

// Parsed heavy fields, cached per-template to avoid re-parsing JSON on every render.
interface ParsedTemplate {
  params?: unknown[];
  serverTemplate?: Record<string, unknown>;
  clientTemplate?: Record<string, unknown>;
  templateContent?: Record<string, unknown>;
  config?: { params?: unknown[] } & Record<string, unknown>;
}

function parseJson<T>(s: string | undefined | null): T | undefined {
  if (!s) return undefined;
  return JSON.parse(s) as T;
}

/**
 * Template cache is shared across ALL PluginRegistry instances in the isolate.
 * Routes construct a fresh registry per request, so instance-level caching
 * (the previous design) re-ran `SELECT * FROM templates` on every request.
 * Workers isolates survive across requests, so a module-level cache turns
 * that into ~1 D1 read per TTL window.
 */
const sharedTemplates = new Map<string, Template>();
const sharedParsed = new Map<string, ParsedTemplate>();
let sharedLoadedAt = 0;

/** Test-only: drop the shared cache so a fresh mock/DB re-runs loadAll.
 * Module state persists across tests while the D1 storage is reset per test. */
export function resetRegistryCache(): void {
  sharedTemplates.clear();
  sharedParsed.clear();
  sharedLoadedAt = 0;
}

/** Write-path invalidation: drop the shared cache immediately so a render
 * right after a template edit (e.g. the batch re-render maintenance endpoint)
 * sees the new definition without waiting out the 30s TTL. */
export function invalidateTemplateCache(): void {
  sharedTemplates.clear();
  sharedParsed.clear();
  sharedLoadedAt = 0;
}

export class PluginRegistry {
  private db: D1Database;
  /** Optional request-scoped logger — diagnostics only (e.g. silently-dropped
   *  route rules); rendering itself never depends on it. */
  private logger?: Logger;

  /** Cache TTL: templates edited by an admin become visible to rendering
   *  within this window without waiting for an isolate restart. */
  private static CACHE_TTL_MS = 30_000;

  constructor(db: D1Database, logger?: Logger) {
    this.db = db;
    this.logger = logger;
  }

  async loadAll(): Promise<void> {
    if (sharedLoadedAt && Date.now() - sharedLoadedAt < PluginRegistry.CACHE_TTL_MS) return;
    // Fresh load invalidates parsed JSON caches too.
    sharedTemplates.clear();
    sharedParsed.clear();

    const result = await this.db.prepare('SELECT * FROM templates').all();
    for (const row of result.results ?? []) {
      const tmpl = parseTemplateRow(row as unknown as TemplateRow);
      sharedTemplates.set(tmpl.id, tmpl);
    }

    sharedLoadedAt = Date.now();
  }

  // Lazily parse + cache the heavy JSON fields of a template.
  private parsed(id: string): ParsedTemplate {
    let cached = sharedParsed.get(id);
    if (cached) return cached;
    const t = sharedTemplates.get(id);
    if (!t) return {};
    cached = {
      params: parseJson<unknown[]>(t.params),
      serverTemplate: parseJson<Record<string, unknown>>(t.serverTemplate),
      clientTemplate: parseJson<Record<string, unknown>>(t.clientTemplate),
      templateContent: parseJson<Record<string, unknown>>(t.templateContent),
      config: parseJson<{ params?: unknown[] } & Record<string, unknown>>(t.config),
    };
    sharedParsed.set(id, cached);
    return cached;
  }

  getProtocol(id: string): Protocol | undefined {
    const t = sharedTemplates.get(id);
    if (!t || t.category !== 'protocol') return undefined;
    return asProtocol(t);
  }

  /** Raw unified template (any category) — used by version-compat checks. */
  getTemplate(id: string): Template | undefined {
    return sharedTemplates.get(id);
  }

  /** Default value of a param declared in the template's config.json
   *  (undefined when the template or the param doesn't exist). */
  getParamDefault(id: string, paramName: string): unknown {
    const defs = (this.parsed(id).config?.params ?? []) as Array<{ name?: string; default?: unknown }>;
    return defs.find((d) => d.name === paramName)?.default;
  }

  getOverallTemplate(id: string): OverallTemplate | undefined {
    const t = sharedTemplates.get(id);
    if (!t || !t.category.startsWith('overall-')) return undefined;
    return asOverall(t);
  }

  getProtocolsByCategory(category: string): OverallTemplate[] {
    // Map old category names (server/client/docker) to new (overall-server/overall-client/overall-docker)
    const mapped = category.startsWith('overall-') ? category : `overall-${category}`;
    return Array.from(sharedTemplates.values())
      .filter((t) => t.category === mapped)
      .map(asOverall);
  }

  has(id: string): boolean {
    return sharedTemplates.has(id);
  }

  size(): { protocols: number; overalls: number } {
    let protocols = 0;
    let overalls = 0;
    for (const t of sharedTemplates.values()) {
      if (t.category === 'protocol') protocols++;
      else if (t.category.startsWith('overall-')) overalls++;
    }
    return { protocols, overalls };
  }

  private resolveParams(
    paramsJson: string,
    userParams: Record<string, unknown>,
  ): Record<string, unknown> {
    const defs = JSON.parse(paramsJson);
    return resolveAndValidate(defs, userParams);
  }

  async renderProtocolInstance(
    protocolId: string,
    userParams: Record<string, unknown>,
  ): Promise<{ serverConfig: Record<string, unknown>; clientConfig: Record<string, unknown> }> {
    const protocol = this.getProtocol(protocolId);
    if (!protocol) throw new PluginError('PLG_UNKNOWN_TYPE', `Protocol not found: ${protocolId}`);

    const resolved = this.resolveParams(protocol.params, userParams);
    const p = this.parsed(protocolId);
    const serverTemplate = p.serverTemplate ?? JSON.parse(protocol.serverTemplate);
    const clientTemplate = p.clientTemplate ?? JSON.parse(protocol.clientTemplate);

    const serverConfig = replacePlaceholders(serverTemplate, resolved) as Record<string, unknown>;
    const clientConfig = replacePlaceholders(clientTemplate, resolved) as Record<string, unknown>;

    return { serverConfig, clientConfig };
  }

  /**
   * Shared overall-template rendering for both sides. Server templates splice
   * `{{ protocols }}`; client templates additionally splice `{{ proxy_tags }}`
   * and the subscription-level `routeRules` at `{{ route_rules }}`.
   */
  private async renderOverall(
    instances: ProtocolInstanceConfig[],
    overallId: string,
    overallParams: Record<string, unknown>,
    side: 'server' | 'client',
    routeRules?: unknown[],
  ): Promise<Record<string, unknown>> {
    const overall = this.getOverallTemplate(overallId);
    if (!overall) throw new PluginError('PLG_UNKNOWN_TYPE', `Overall template not found: ${overallId}`);
    if (overall.category !== `overall-${side}`) {
      throw new PluginError('PLG_UNKNOWN_TYPE', `Template '${overallId}' is not a ${side} overall template`);
    }

    const p = this.parsed(overallId);
    const paramDefs = p.config?.params ?? [];

    const replacements: Record<string, unknown[]> = {
      [normalizeToken('{{ protocols }}')]: instances.map((i) =>
        side === 'server' ? i.serverConfig : i.clientConfig,
      ),
    };
    if (side === 'client') {
      replacements[normalizeToken('{{ proxy_tags }}')] = instances
        .map((i) => i.clientConfig.tag)
        .filter((t): t is string => typeof t === 'string' && t.length > 0);
      // Subscription-level route rules: always registered (possibly empty) so
      // an unused `{{ route_rules }}` splice point is removed from the rules
      // array instead of surviving as a literal placeholder element.
      replacements[normalizeToken('{{ route_rules }}')] = routeRules ?? [];
    }

    const resolved = resolveAndValidate(paramDefs as any, overallParams);
    const parsedTemplate = p.templateContent ?? JSON.parse(overall.templateContent);
    if (side === 'client') {
      const ruleCount = routeRules?.length ?? 0;
      if (ruleCount > 0) {
        if (!containsToken(parsedTemplate, ROUTE_RULES_TOKEN)) {
          // 可观测性（B3）：订阅携带了自定义规则、但模板没有 {{ route_rules }}
          // 拼接点时，规则会被 splice 静默丢弃——打 warn 让管理员能在日志里
          // 定位，而不是交付出去的配置「看起来正常却没有生效规则」。
          this.logger?.warn(
            'overall-client template has no {{ route_rules }} splice point — custom route rules were not applied',
            { template: overallId, rules: ruleCount, instances: instances.length },
          );
        } else {
          // outbound 白名单告警（best-effort）：规则的 outbound 不在
          // direct/proxy/auto 与被交付实例 outbound tag 的并集里 → 大概率是
          // 引用了模板生成的 selector 分组或拼写错误。订阅级无法在写入时预知
          // 交付 outbound 集合（实例可后改），故在渲染时告警而不阻断。
          const known = new Set<string>(['direct', 'proxy', 'auto']);
          for (const i of instances) {
            const tag = (i.clientConfig as { tag?: unknown }).tag;
            if (typeof tag === 'string' && tag.length > 0) known.add(tag);
          }
          const unknownOutbounds = new Set<string>();
          for (const rule of routeRules ?? []) {
            const outbound = (rule as { outbound?: unknown } | null)?.outbound;
            if (typeof outbound === 'string' && outbound.length > 0 && !known.has(outbound)) {
              unknownOutbounds.add(outbound);
            }
          }
          if (unknownOutbounds.size > 0) {
            this.logger?.warn(
              'route rules reference outbounds not present in the delivered config — they may target template-generated selector groups or contain typos',
              { template: overallId, rules: ruleCount, unknownOutbounds: [...unknownOutbounds] },
            );
          }
        }
      }
    }
    const spliced = splicePlaceholders(parsedTemplate, replacements);
    return replacePlaceholders(spliced, resolved) as Record<string, unknown>;
  }

  renderServerOverall(
    instances: ProtocolInstanceConfig[],
    overallId: string,
    overallParams: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.renderOverall(instances, overallId, overallParams, 'server');
  }

  renderClientOverall(
    instances: ProtocolInstanceConfig[],
    overallId: string,
    overallParams: Record<string, unknown>,
    routeRules?: unknown[],
  ): Promise<Record<string, unknown>> {
    return this.renderOverall(instances, overallId, overallParams, 'client', routeRules);
  }

  async renderDocker(
    overallId: string,
    overallParams: Record<string, unknown>,
    overrides: DockerOverrides = {},
  ): Promise<{ composeYaml: string; entrySh: string; singboxImage: string | null }> {
    const overall = this.getOverallTemplate(overallId);
    if (!overall) throw new PluginError('PLG_UNKNOWN_TYPE', `Docker template not found: ${overallId}`);
    if (overall.category !== 'overall-docker') throw new PluginError('PLG_UNKNOWN_TYPE', `Template '${overallId}' is not a docker template`);

    const p = this.parsed(overallId);
    const paramDefs = p.config?.params ?? [];
    const resolved = resolveAndValidate(paramDefs as any, overallParams);

    const parsedTemplate = p.templateContent ?? JSON.parse(overall.templateContent);
    const renderedCompose = replacePlaceholders(parsedTemplate, resolved) as Record<string, unknown>;

    // Pure compose YAML — the entry script is returned separately and must
    // never be appended to the yaml (the compose file is fed to `docker compose`).
    const composeYaml = renderDocker(renderedCompose, overrides);

    // Post-substitution image reference of the `sing-box` service — surfaced
    // so deploy responses can pin/report the exact running version.
    const services = renderedCompose.services as Record<string, Record<string, unknown>> | undefined;
    const image = services?.['sing-box']?.image;
    return {
      composeYaml,
      entrySh: overall.entryScript ?? '',
      singboxImage: typeof image === 'string' ? image : null,
    };
  }
}
