# Panel 初始化增加 sing-box 版本选择 + 创建链路版本校验

## Context

**问题**：协议模板（hy / vless-reality-vision 等）的配置随 sing-box 版本演进（每份模板声明 `singbox_compat` 范围），deploy 和订阅交付都按版本过滤/校验，但新建协议实例的链路没有：

1. **初始化向导（Setup.vue）没有版本选择步骤**——本机版本（`AppConfig.singbox_version`）只是 Settings 页的可选项。pin 为空时，模板列表过滤（cloud `GET /api/protocols?singbox_version=` 的 compat 过滤）完全不生效，任何版本的协议模板都能看到、能新建。
2. **预览渲染不带版本**——`renderProtocol` 只传 protocolId+params，cloud `/api/render` 的 compat 校验（`render.ts:77-84`，仅 body 带版本才触发）被跳过，不兼容配置要等到 deploy / 订阅交付才报错。

**目标**：
- 初始化向导新增必选的 sing-box 版本步骤（候选来自 cloud 版本目录），保证 pin 从一开始就设置。
- 渲染预览自动携带本机 pin 版本，cloud 侧既有 compat 校验立即生效，不兼容配置在创建预览时就报错。

**非目标**（有意不改）：
- cloud `POST /api/protocol-instances` 不加创建时校验：实例在 cloud 管理侧创建时没有版本上下文，交付时按订阅绑定版本逐实例排除已有兜底（`subscriptions.ts:280-322`）。
- `/core/configs` 服务端不加 compat 校验：创建前必经预览渲染（现在会校验），且 `config-manager.ts:45` 已快照版本、ConfigList 已展示版本漂移。

## 现状关键代码

| 位置 | 作用 |
|---|---|
| `packages/panel/src/views/Setup.vue` | 3 步向导：Password / Identity / Cloud Connection，`finish()`(:207-228) 调 `init.completeInit` |
| `packages/panel/src/stores/init.ts` | `completeInit`(:28-39) POST `/init`；`testCloud`(:41-46) 用 `/settings/test-candidate` 探测候选连接 |
| `packages/panel/server/routes/init.ts` | schema(:31-41) 无版本字段；POST 内已构建 `probe` CloudClient(:53-56) 探测 cloud；`core.updateAppConfig`(:104-109) 只写 url/token/node |
| `packages/panel/server/routes/settings.ts` | `SINGBOX_VERSION_RE`(:27)；`singbox_version` 显式携带时写 core + `invalidateCore()`(:61-64)——**保存模式的参照**；`/test-candidate`(:100-120) 临时 CloudClient 探测——**预初始化 cloud 调用的参照** |
| `packages/core/src/services/cloud-client.ts` | `renderProtocol(protocolId, params)`(:328-345) body 不带版本；`getSingboxVersions()`(:322-326) 已有 |
| `packages/core/src/core.ts` | `generateConfig(type, params)`(:130-135) 转发 cloud |
| `packages/cloud/src/routes/render.ts` | `/api/render` body 带 `singboxVersion` 时校验 compat(:77-84)——**已实现，无需改** |
| `packages/cloud/src/routes/templates.ts` | `GET /api/singbox-versions` 返回 `{ versions: string[] }`（semver 降序） |

## 改动清单

### 1. panel server：初始化路由支持版本

**`packages/panel/server/routes/settings.ts`**
- 新增 `POST /api/settings/candidate-singbox-versions`：body `{ cloud_url, cloud_token }`（复用 `testCandidateSchema`），临时 `new CloudClient({cloud_url, cloud_token})` 调 `getSingboxVersions()` 返回 `{ versions }`；失败返回 `{ versions: [], error }`（仿 `/test-candidate` 结构）。

**`packages/panel/server/routes/init.ts`**
- `SINGBOX_VERSION_RE` 从 settings.ts 导出复用（或抽到两路由共用的位置），initSchema 增加 `singbox_version: z.string().regex(SINGBOX_VERSION_RE)`（**必填**，与「初始化必须选择」一致）。
- GET `/` 响应增加 `singbox_version`（读 `getCore().getAppConfig().singbox_version`），供重跑向导时预选。
- POST handler：`cloudOk` 后用已有 `probe.getSingboxVersions()` 校验所选版本在目录内，不在则 400 `SBX_VERSION_NOT_OFFERED`（`cloud_required=false` 且 cloud 不可达时跳过目录校验，仅保存）。
- `core.updateAppConfig({ ..., singbox_version })` 后跟 `invalidateCore()`（照抄 settings.ts:61-64 的注释约定）。

### 2. panel 前端：向导新增版本步骤

**`packages/panel/src/views/Setup.vue`**
- `n-steps` 增加 "sing-box Version"（第 4 步），成功页从 step 4 顺移为 step 5；相关 `step.value` 赋值同步（含 `!auth.firstRun` 时 `step.value = 2` 的逻辑不变）。
- 新步骤 UI：进入时调 init store 新 action 拉候选列表（用 step 3 输入的 `cloudUrl`/`cloudToken`）；`n-select` 必选 + 手动「Refresh」按钮；拉取失败显示 error alert + 重试，未选择则 Next 禁用；重跑向导时用 GET `/init` 返回的 `singbox_version` 预选。
- `finish()` 的 `completeInit` 参数增加 `singbox_version`。
- UI 文案保持英文（与现有步骤标题一致）。

**`packages/panel/src/stores/init.ts`**
- 新增 `fetchCandidateVersions(url, token)`（POST `/settings/candidate-singbox-versions`）；`completeInit` 参数类型加 `singbox_version: string`。

### 3. core：渲染自动携带本机 pin 版本

**`packages/core/src/core.ts`** `generateConfig(type, params)`(:130-135)
- 转发时自动附加 `this.getAppConfig().singbox_version || undefined` 作为第三参。不改方法签名——所有调用方（ConfigCreate 预览、`generateAndAdd` 等）零改动即获得校验。

**`packages/core/src/services/cloud-client.ts`** `renderProtocol`(:328-345)
- 签名改为 `(protocolId, params, singboxVersion?)`，带版本时 body 加 `singboxVersion`；`generateConfig(type, params, singboxVersion?)` 透传。
- 检查其余 `renderProtocol` / `generateConfig` 调用点，确认无遗漏（grep 全仓）。

cloud `/api/render` 已有校验，**不改**。效果：ConfigCreate 预览即报 `SBX_VERSION_INCOMPATIBLE`，错误经 `extractApiError` 展示在预览区。

### 4. 测试

- **panel**（注意铁律：server 模块在 `makeTempHome` 设置 HOME 之后动态 import）：init 路由测试——缺 `singbox_version` 返回 422；携带时写入 core store（读回断言）+ invalidate；版本不在目录返回 400。candidate-singbox-versions 路由的参数校验测试。
- **core**：generateConfig 透传版本——mock CloudClient 断言 `/api/render` body 含 `singboxVersion`；pin 为空时不含该字段。
- **cloud**：不改（`/api/render` compat 校验已有测试覆盖）。
- 测试数据遵循「钉机制不钉数据」：版本字面量仅用于测试自建 fixture，涉及种子的断言从 `tests/seed-baseline.ts` 推导。

## 验证

1. `pnpm -r test` 全绿。
2. 手动 e2e（本地）：起 cloud（wrangler dev）+ panel dev →
   - 走初始化向导：第 4 步出现版本下拉（数据来自 cloud 目录）；不选无法完成；完成后 Settings 页显示所选版本。
   - ConfigCreate：协议模板列表只显示兼容当前版本的模板；将 Settings 版本改为不满足某模板 compat 的版本后预览该模板 → 预览区报 `SBX_VERSION_INCOMPATIBLE`。
3. 重跑向导（已初始化状态）：版本步骤预选当前 pin。
