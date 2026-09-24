/**
 * 种子数据的动态基线：测试所需的版本号、版本目录、compat 范围一律从模板
 * config.json（db/seed.ts 的同一数据源）推导，禁止在测试里硬编码。
 *
 * 理由（2026-09-24 复盘）：sing-box 版本目录与 compat 范围会随迭代频繁演进，
 * 硬编码意味着「改一次种子就要同步改一批测试」。测试应钉死机制（过滤、
 * 校验、回落、排除），而非钉死随时会变的数据。
 */
import dockerConfig from '../src/templates/docker/default/config.json';
import hysteria2Config from '../src/templates/protocols/hysteria2/config.json';
import vlessConfig from '../src/templates/protocols/vless-reality-vision/config.json';
import serverConfig from '../src/templates/server/default/config.json';
import clientConfig from '../src/templates/client/default/config.json';
import { SEED_TEMPLATES } from '../src/db/seed';

interface Param { name: string; default?: string; enum?: string[] }
interface Cfg { singbox_compat?: string; params?: Param[] }

const cfg = (c: unknown): Cfg => c as Cfg;

/** 各种子模板的 singbox_compat 原文，按模板 id 索引。 */
export const SEED_COMPAT: Record<string, string> = {
  hysteria2: cfg(hysteria2Config).singbox_compat ?? '*',
  'vless-reality-vision': cfg(vlessConfig).singbox_compat ?? '*',
  'server-default': cfg(serverConfig).singbox_compat ?? '*',
  'client-default': cfg(clientConfig).singbox_compat ?? '*',
  'docker-default': cfg(dockerConfig).singbox_compat ?? '*',
};

/** 种子协议模板 id（从 seed.ts 的结构摘要推导，种子演进无需改测试）。 */
export const SEED_PROTOCOL_IDS = SEED_TEMPLATES.filter((t) => t.category === 'protocol').map((t) => t.id);

/** 全部种子模板 id（种子总条数断言用）。 */
export const SEED_TEMPLATE_IDS = SEED_TEMPLATES.map((t) => t.id);

/** 指类别（protocol / overall-server / overall-client / overall-docker）的种子模板 id。 */
export const SEED_CATEGORY_IDS = (category: string) =>
  SEED_TEMPLATES.filter((t) => t.category === category).map((t) => t.id);

/** docker-default 的 singbox_version param —— 版本目录的唯一来源（设计 §13.3）。 */
const dockerParam = cfg(dockerConfig).params?.find((p) => p.name === 'singbox_version');

// --- 极简 semver 工具（x.y.z 数值比较，测试够用） ---

function cmpVer(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  return (pa[0] - pb[0]) || (pa[1] - pb[1]) || (pa[2] - pb[2]);
}

function bumpPatch(v: string): string {
  const [maj, min, pat] = v.split('-')[0].split('.').map(Number);
  return `${maj}.${min}.${pat + 1}`;
}

function below(v: string): string {
  const [maj, min, pat] = v.split('-')[0].split('.').map(Number);
  return min > 0 ? `${maj}.${min - 1}.${pat}` : `${maj - 1}.0.0`;
}

function satisfies(version: string, range: string): boolean {
  if (!range || range === '*') return true;
  const min = />=\s*(\d+\.\d+\.\d+)/.exec(range)?.[1];
  const max = /<\s*(\d+\.\d+\.\d+)/.exec(range)?.[1];
  if (min && cmpVer(version, min) < 0) return false;
  if (max && cmpVer(version, max) >= 0) return false;
  return true;
}

/** 版本目录（docker param enum，semver 降序）。 */
export const SINGBOX_CATALOG: string[] = [...(dockerParam?.enum ?? [])].sort((a, b) => cmpVer(b, a));

/** docker 模板 param default（render/deploy 不传版本时的回落值）。 */
export const DOCKER_DEFAULT_VERSION: string = dockerParam?.default ?? SINGBOX_CATALOG[0] ?? '0.0.1';

const seedRanges = Object.values(SEED_COMPAT);

/** 一个低于全部种子 compat 下限的输入版本（过滤 / INCOMPATIBLE 用例）。 */
export const VERSION_BELOW_ALL_SEEDS: string = (() => {
  const mins = seedRanges.map((r) => />=\s*(\d+\.\d+\.\d+)/.exec(r)?.[1]).filter(Boolean) as string[];
  if (mins.length === 0) return '0.0.1';
  const floor = mins.sort(cmpVer)[mins.length - 1];
  return below(floor);
})();

/** 满足全部种子 compat 且在版本目录内的输入版本（正常路径用例）。 */
export const VERSION_IN_ALL_SEEDS: string =
  SINGBOX_CATALOG.find((v) => seedRanges.every((r) => satisfies(v, r))) ?? DOCKER_DEFAULT_VERSION;

/** 满足全部种子 compat 但不在版本目录内的输入版本（NOT_OFFERED 用例）。 */
export const VERSION_NOT_OFFERED: string = (() => {
  let candidate = bumpPatch(SINGBOX_CATALOG[0] ?? DOCKER_DEFAULT_VERSION);
  for (let i = 0; i < 1000 && (SINGBOX_CATALOG.includes(candidate) || !seedRanges.every((r) => satisfies(candidate, r))); i++) {
    candidate = bumpPatch(candidate);
  }
  return candidate;
})();

/** 一个把 VERSION_IN_ALL_SEEDS 排除在外的 compat 范围（模板收窄用例）。 */
export const RANGE_EXCLUDING_VERSION_IN_ALL_SEEDS: string = (() => {
  const [maj, min, pat] = VERSION_IN_ALL_SEEDS.split('-')[0].split('.').map(Number);
  return `>=${maj}.${min + 1}.${pat}`;
})();

/** sing-box 镜像 tag 断言用：只钉「param 值 → :v 前缀 tag」的映射关系，
 * 不钉 registry 地址（那是部署事实，不属于本层契约）。 */
export const expectImageFor = (version: string) => `:v${version}`;
