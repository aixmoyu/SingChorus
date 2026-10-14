# cloud-core-panel 组件版本兼容性检测机制

## Context

panel 同进程加载 `@chorus/core` 的 dist（`workspace:*` 依赖），并远程调用 cloud。当 core/cloud 单独升级而 panel 未跟进（或反之）时，可能出现 API 形状、行为契约不兼容，且目前**没有任何检测手段**——问题会以运行期诡异故障的形式暴露。

目标：建立三组件版本兼容性检测机制——
- 各组件暴露自身版本号；
- panel 启动时校验 core 版本、运行期校验 cloud 版本是否在 panel 声明的支持范围内；
- 默认非严格模式仅告警（日志 + `/api/info` + 前端横幅提示管理员升级）；`CHORUS_PANEL_STRICT_COMPAT=1` 时 core 不匹配直接拒绝启动；
- 落地维护约定：破坏性修改 → bump 包版本 → 更新下游 compat 范围，用测试自动提醒。

已确认决策：本地数据格式（~/.singchorus）**不纳入**本次范围；覆盖链路为 cloud-core-panel。

顺手修复已知 bug：[info.ts:26](file:///Users/li/Projects/SingChorus/packages/panel/server/routes/info.ts#L26) 硬编码 `panel_version: '0.2.0'`。

## 改动清单

### 1. core（@chorus/core）
- 新建 `packages/core/src/version.ts`：`export const CORE_VERSION = '0.1.0'`（src 不能 import package.json，用常量）。
- [index.ts](file:///Users/li/Projects/SingChorus/packages/core/src/index.ts) 追加 re-export `CORE_VERSION`。
- 新建 `packages/core/tests/version.spec.ts`：fs 读 package.json 断言 `CORE_VERSION === version`（钉一致性，不硬编码具体号）。

### 2. cloud（@chorus/cloud）
- 新建 `packages/cloud/src/version.ts`：`CLOUD_VERSION = '0.1.0'`。
- [index.ts /health](file:///Users/li/Projects/SingChorus/packages/cloud/src/index.ts#L58-L60) 返回 `{ status, service, version: CLOUD_VERSION }`。
- 测试：现有 health 用例补断言 `version` 非空；一致性测试放 node 组（workerd 内无 fs），新建 `tests/version.node.spec.ts`（先确认 vitest.node 配置 include 覆盖）。

### 3. panel server
- 依赖：`pnpm -C packages/panel add semver && pnpm -C packages/panel add -D @types/semver`。
- 新建 `packages/panel/server/version.ts`：`createRequire(import.meta.url)` 读 `../package.json` 导出 `PANEL_VERSION`（tarball 内置 package.json，路径成立）。
- 新建 `packages/panel/server/compat.ts`（**兼容范围单点声明**）：
  - `SUPPORTED_CORE_RANGE = '>=0.1.0 <0.2.0'`、`SUPPORTED_CLOUD_RANGE = '>=0.1.0 <0.2.0'`
  - `checkCoreVersion(v)` / `checkCloudVersion(v)`：`semver.satisfies` + 非法值处理，返回 `{ ok, version, range }`
  - `fetchCloudVersion(cloudUrl, timeoutMs=3000)`：panel 直接 `fetch ${cloud_url}/health`（公开端点，无需走 core CloudClient——那是同步/部署授权通道），模块级 Promise 缓存 + 60s TTL，失败返回 null；settings 改 cloud_url 时清缓存
  - `isStrictCompat()`：`CHORUS_PANEL_STRICT_COMPAT === '1'`
- [index.ts](file:///Users/li/Projects/SingChorus/packages/panel/server/index.ts)：`startServer()` 内 listen **之前**校验 core——不匹配 `logger.warn({core_version, range})`；strict 且不匹配 → `logger.error` + `process.exit(1)`（listen 前无 socket，无需优雅关闭；不放 createApp，避免测试触发 exit）。
- [routes/info.ts](file:///Users/li/Projects/SingChorus/packages/panel/server/routes/info.ts) 改 async，响应扩展：
  ```
  panel_version  // 来自 version.ts，修硬编码 bug
  core_version   // import { CORE_VERSION } from '@chorus/core'（静态常量，不依赖 getCore）
  cloud_version  // await fetchCloudVersion，不可达为 null
  compat: { core: {version,range,ok}, cloud: {version,range,ok}|{version:null,ok:null}, strict }
  ```

### 4. panel 前端
- [stores/info.ts](file:///Users/li/Projects/SingChorus/packages/panel/src/stores/info.ts)：SystemInfo 扩展 `core_version / cloud_version / compat`（snake_case，现有约定无 camel 转换）。
- 新建 `src/components/CompatBanner.vue`：n-alert type=warning，仅当 `compat.core.ok === false || compat.cloud.ok === false` 显示（`ok:null` = unknown 不告警，避免 cloud 不可达误报）；文案提示 "contact your administrator to upgrade"。App.vue 在 `n-config-provider` 内、`router-view` 上方插入（401 时静默不显示）。
- 新建 composable `useCompatCheck()`：onMounted 拉取 + visibilitychange 恢复可见时刷新 + 低频定时（页面隐藏暂停——遵循项目既有约定）。
- [SystemSettings.vue:75-90](file:///Users/li/Projects/SingChorus/packages/panel/src/views/settings/SystemSettings.vue#L75-L90)：版本区展示 panel/core/cloud 三个版本号。

### 5. 维护约定落地
- 根 `README.md` 发布自查节追加一段（不新建文件）：破坏性变更 → bump 对应包 version → 更新 `packages/panel/server/compat.ts` 范围 → 发布顺序 core → panel/ctl；strict 模式说明（仅作用于 core，cloud 不可达不强判）。
- 自动提醒：panel `tests/compat.test.ts` 断言 `semver.satisfies(CORE_VERSION, SUPPORTED_CORE_RANGE)`——core 版本 bump 出范围而未更新 panel 时此测试变红。

## 测试计划（vitest + supertest，沿用 helpers.loadApp：makeTempHome 后动态 import）
- core `tests/version.spec.ts`：CORE_VERSION 与 package.json 一致。
- cloud：health 用例扩展 + `tests/version.node.spec.ts` 一致性。
- panel `tests/compat.test.ts`：range 边界（0.1.0 过 / 0.2.0 拒 / 非法串拒）、strict env 解析、`satisfies(CORE_VERSION, range)` 出范围变红机制。
- panel `tests/info.test.ts`：/api/info 返回 `panel_version` === 包版本（钉死硬编码 bug）、`core_version` 非空、cloud 不可达时 `cloud_version=null` 且 `compat.cloud.ok=null`。

## 实施顺序与验证
1. core：改代码 → `pnpm -C packages/core build && pnpm -C packages/core test`（panel import 的是 core dist，必须先 build）
2. cloud：改代码 → `pnpm -C packages/cloud test`
3. panel server：加依赖、compat/version/info/index → `pnpm -C packages/panel test && pnpm -C packages/panel typecheck`
4. panel 前端：store/横幅/composable/设置页 → `pnpm -C packages/panel build`
5. README 约定；全量 `pnpm -r build && pnpm -r test`

## 风险与边界
- cloud 不可达：`cloud_version=null`、`compat.cloud.ok=null`（unknown 语义），前端不横幅、strict 不生效（启动时无法强判远端）。
- core 版本运行期不变（静态 import），core-provider 快照重建 ChorusCore 无需复检，启动校验一次即可。
- /health 探测 3s 超时 + Promise 去重缓存，避免 /api/info 被慢 cloud 拖慢。
- panel server 实际是 Express 4（已核实），前端字段保持 snake_case。
