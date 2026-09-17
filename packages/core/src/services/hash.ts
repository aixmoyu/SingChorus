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

export function computeContentHash(server: Record<string, unknown>, client: Record<string, unknown>, params: Record<string, unknown>): string {
  const parts = [
    stableStringify(server),
    stableStringify(client),
    stableStringify(params),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
