import { Hono } from 'hono';
import { PluginRegistry, type ProtocolInstanceConfig } from '../engine/registry';
import { PluginError } from '../engine/errors';
import { adminAuth } from '../auth/middleware';
import { isValidSingboxVersion, isCompatSatisfied } from '../engine/compat';
import type { Template } from '../engine/types';
import type { DockerOverrides } from '../engine/docker_renderer';

const render = new Hono<{ Bindings: Env }>();

/** Parse the request body as JSON, returning a readable 400 instead of a 500
 * when the body is missing or malformed. */
async function readJson<T>(c: { req: { json<T>(): Promise<T> } }): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

/** 400 SBX_BAD_VERSION unless the value matches the docker-tag-safe semver shape. */
function badVersion(version: string) {
  return { code: 'SBX_BAD_VERSION' as const, message: `Invalid sing-box version: '${version}' (expected X.Y.Z[-suffix], no build metadata)` };
}

interface CompatConflict {
  template: string;
  category: string;
  singbox_compat: string | null;
  version: string;
}

/** 收集与指定版本不兼容的模板（纵深防御第 2 层）。一次性列出全部冲突项，
 * 让用户（尤其是 Deploy 页选了非默认模板的场景）一次看全。 */
function collectCompatConflicts(
  version: string,
  entries: Array<{ template: Template | undefined; id: string; category: string }>,
): CompatConflict[] {
  const conflicts: CompatConflict[] = [];
  for (const { template, id, category } of entries) {
    const compat = template?.singboxCompat ?? null;
    if (!isCompatSatisfied(compat, version)) {
      conflicts.push({ template: id, category, singbox_compat: compat, version });
    }
  }
  return conflicts;
}

function incompatibleResponse(conflicts: CompatConflict[]) {
  return {
    error: {
      code: 'SBX_VERSION_INCOMPATIBLE',
      message:
        `sing-box version incompatible with ${conflicts.length} template(s): ` +
        conflicts.map((cf) => `${cf.template} (${cf.category}) requires '${cf.singbox_compat}'`).join('; '),
      conflicts,
    },
  };
}

// POST /api/render — dry-run protocol instance rendering
render.post('/', adminAuth, async (c) => {
  const body = await readJson<{ protocolId?: string; params?: Record<string, unknown>; singboxVersion?: string }>(c);
  if (!body) {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON (set Content-Type: application/json)' } }, 400);
  }
  if (!body.protocolId) {
    return c.json({ error: { code: 'PROTOCOL_ID_REQUIRED', message: 'protocolId is required' } }, 400);
  }
  if (body.singboxVersion !== undefined && !isValidSingboxVersion(body.singboxVersion)) {
    return c.json({ error: badVersion(body.singboxVersion) }, 400);
  }

  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  if (body.singboxVersion) {
    const conflicts = collectCompatConflicts(body.singboxVersion, [
      { template: reg.getTemplate(body.protocolId), id: body.protocolId, category: 'protocol' },
    ]);
    if (conflicts.length > 0) {
      return c.json(incompatibleResponse(conflicts), 400);
    }
  }

  try {
    const rendered = await reg.renderProtocolInstance(body.protocolId, body.params ?? {});
    return c.json(rendered, 200);
  } catch (e) {
    if (e instanceof PluginError) {
      return c.json({ error: { code: e.code, message: e.message } }, 400);
    }
    throw e;
  }
});

// POST /api/render/deploy — render everything a node needs to deploy.
// Body: { instances: [{ id, serverConfig, clientConfig, protocolId? }], serverOverallId?,
//         dockerOverallId?, serverParams?, dockerParams?, dockerOverrides?, singboxVersion? }
// Falls back to the default server/docker overall templates when ids are omitted.
// Returns { serverConfig, composeYaml, entrySh, singboxVersion, singboxImage } so panels deploy
// cloud-rendered artifacts instead of assembling their own (same source of truth as subscriptions).
render.post('/deploy', adminAuth, async (c) => {
  const body = await readJson<{
    instances?: Array<ProtocolInstanceConfig & { protocolId?: string }>;
    serverOverallId?: string;
    dockerOverallId?: string;
    serverParams?: Record<string, unknown>;
    dockerParams?: Record<string, unknown>;
    dockerOverrides?: DockerOverrides;
    singboxVersion?: string;
  }>(c);

  if (!body) {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON (set Content-Type: application/json)' } }, 400);
  }
  if (!Array.isArray(body.instances) || body.instances.length === 0) {
    return c.json({ error: { code: 'INSTANCES_REQUIRED', message: 'instances must be a non-empty array' } }, 400);
  }
  if (body.singboxVersion !== undefined && !isValidSingboxVersion(body.singboxVersion)) {
    return c.json({ error: badVersion(body.singboxVersion) }, 400);
  }

  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  const serverOverallId = body.serverOverallId || 'server-default';
  const dockerOverallId = body.dockerOverallId || 'docker-default';

  // 1. 解析生效版本：请求显式携带 → 用之；否则回落 docker 模板
  //    singbox_version param 的 default（内置模板为 pinned 稳定版）。
  const effectiveVersion =
    (body.singboxVersion && body.singboxVersion.trim()) ||
    (typeof reg.getParamDefault(dockerOverallId, 'singbox_version') === 'string'
      ? (reg.getParamDefault(dockerOverallId, 'singbox_version') as string)
      : '');

  // 2. 兼容性校验：server overall（可能是 Deploy 页选中的非默认模板）、
  //    docker overall、每个 instance 的 protocolId 对应协议（旧调用方不传
  //    protocolId 则跳过该条）。
  if (effectiveVersion) {
    const conflicts = collectCompatConflicts(effectiveVersion, [
      { template: reg.getTemplate(serverOverallId), id: serverOverallId, category: 'overall-server' },
      { template: reg.getTemplate(dockerOverallId), id: dockerOverallId, category: 'overall-docker' },
      ...body.instances
        .filter((i) => i.protocolId)
        .map((i) => ({ template: reg.getTemplate(i.protocolId!), id: i.protocolId!, category: 'protocol' })),
    ]);
    if (conflicts.length > 0) {
      return c.json(incompatibleResponse(conflicts), 400);
    }
  }

  // 3. 注入镜像版本：用户值优先于 param default（resolveAndValidate 语义）；
  //    显式生效版本最后合并、覆盖用户同名参数。自定义 docker 模板未声明
  //    singbox_version param 时多余 userParam 被忽略、无副作用。
  const dockerParams: Record<string, unknown> = {
    ...(body.serverParams ?? {}),   // 向后兼容：serverParams 历史上一直透传给 docker 渲染
    ...(body.dockerParams ?? {}),   // docker 模板独立参数（解除历史 conflation）
    ...(effectiveVersion ? { singbox_version: effectiveVersion } : {}),
  };

  const serverConfig = await reg.renderServerOverall(body.instances, serverOverallId, body.serverParams ?? {});
  const dockerResult = await reg.renderDocker(dockerOverallId, dockerParams, body.dockerOverrides ?? {});

  return c.json({
    serverConfig,
    composeYaml: dockerResult.composeYaml,
    entrySh: dockerResult.entrySh,
    ...(effectiveVersion ? { singboxVersion: effectiveVersion } : {}),
    ...(dockerResult.singboxImage ? { singboxImage: dockerResult.singboxImage } : {}),
  }, 200);
});

// POST /api/render/overall — dry-run overall template rendering (server/client/docker).
// Body: { category: 'server'|'client'|'docker', templateId, params?, instances?, overrides? }
// - For 'server'/'client': instances is an array of { id, serverConfig, clientConfig }.
// - For 'docker': overrides is { env?, volumes? }.
render.post('/overall', adminAuth, async (c) => {
  const body = await readJson<{
    category: 'server' | 'client' | 'docker';
    templateId: string;
    params?: Record<string, unknown>;
    instances?: ProtocolInstanceConfig[];
    overrides?: DockerOverrides;
  }>(c);

  if (!body) {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON (set Content-Type: application/json)' } }, 400);
  }
  if (!body.templateId) {
    return c.json({ error: { code: 'TEMPLATE_ID_REQUIRED', message: 'templateId is required' } }, 400);
  }
  if (!['server', 'client', 'docker'].includes(body.category)) {
    return c.json({ error: { code: 'INVALID_CATEGORY', message: "category must be 'server', 'client', or 'docker'" } }, 400);
  }

  const reg = new PluginRegistry(c.env.DB);
  await reg.loadAll();

  try {
    if (body.category === 'server') {
      const result = await reg.renderServerOverall(body.instances ?? [], body.templateId, body.params ?? {});
      return c.json({ serverConfig: result }, 200);
    }
    if (body.category === 'client') {
      const result = await reg.renderClientOverall(body.instances ?? [], body.templateId, body.params ?? {});
      return c.json({ clientConfig: result }, 200);
    }
    // docker
    const result = await reg.renderDocker(body.templateId, body.params ?? {}, body.overrides ?? {});
    return c.json({ composeYaml: result.composeYaml, entrySh: result.entrySh }, 200);
  } catch (e) {
    if (e instanceof PluginError) {
      return c.json({ error: { code: e.code, message: e.message } }, 400);
    }
    throw e;
  }
});

export { render };
