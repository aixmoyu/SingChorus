import { validRange, satisfies } from 'semver';

/**
 * sing-box 版本兼容引擎（设计文档 docs/design/singbox-version-management.md §3.5）。
 *
 * semver 匹配逻辑只存在于 cloud（设计原则 4）：panel / panel-server 只消费
 * cloud 的过滤结果，不复制判定逻辑，杜绝两端漂移。
 *
 * 范围语法：`*`（缺省/NULL 等价）、`>=X.Y.Z`、`<X.Y.Z`、空格分隔多条件（AND）、
 * `~X.Y.Z`、`^X.Y.Z`、精确 `X.Y.Z`。委托给 semver npm 包 —— prerelease 语义
 * （范围默认不含 prerelease、精确匹配可命中）不值得手写复刻。
 */

/** 允许进 docker 镜像 tag 的版本格式。不允许 `+build`（docker tag 非法字符，
 * 同时收窄镜像 tag 注入面）。 */
export const SINGBOX_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** 校验节点上报/请求携带的 sing-box 版本（如 `1.12.9`、`1.13.0-rc.1`）。 */
export function isValidSingboxVersion(v: unknown): v is string {
  return typeof v === 'string' && SINGBOX_VERSION_RE.test(v);
}

/** 校验模板声明的兼容范围（如 `>=1.12.0 <2.0.0`、`*`、精确版本）。 */
export function isValidCompatRange(range: string): boolean {
  return validRange(range) !== null;
}

/**
 * 是否兼容。`compat` 为 null / undefined / '' / '*' 时视为兼容任意版本
 * （旧行为，显式语义而非隐式失败）。
 */
export function isCompatSatisfied(compat: string | null | undefined, version: string): boolean {
  if (!compat || compat.trim() === '' || compat.trim() === '*') return true;
  const range = validRange(compat);
  if (range === null) return true; // 写路径已拦截非法范围；读到脏数据时放行（不过滤）
  return satisfies(version, range);
}
