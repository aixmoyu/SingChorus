import { createHash } from 'crypto';

/**
 * Deterministic JSON serialization: keys are sorted recursively, so identical
 * content produces identical strings regardless of key insertion order.
 *
 * 不能用 `JSON.stringify(obj, Object.keys(obj).sort())` 实现 —— replacer 数组
 * 是「递归白名单」，会把所有嵌套对象/数组的深层字段过滤掉（如 users 里的
 * password、tls 配置、params 深层参数），导致嵌套内容变更不改变 content_hash，
 * 同步状态误报 synced（订阅漂移）。
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function computeContentHash(
  server: Record<string, unknown>,
  client: Record<string, unknown>,
  params: Record<string, unknown>,
  routeRules: unknown[] = [],
): string {
  const parts = [
    stableStringify(server),
    stableStringify(client),
    stableStringify(params),
  ];
  // 空规则不产生第 4 段：与引入 route_rules 之前的三段格式完全一致。
  // 否则存量条目（本地存的是旧格式 hash）在「无实质修改的保存」后会被
  // update() 误判为内容已变更，触发 deployed=false → 配置从订阅中下线。
  // 非空规则仍完整计入（[] 与 [rule] 之间、规则内容之间的变更都能被感知）。
  if (routeRules.length > 0) {
    parts.push(stableStringify(routeRules));
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
