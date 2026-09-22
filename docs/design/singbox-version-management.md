# sing-box 版本管理方案设计

- **状态**: 提案（待评审 / 未实施）
- **日期**: 2026-09-22
- **基线**: `c31cd89`（feat(deploy): 支持选择非默认服务器模板进行部署）
- **范围**: cloud / core / panel / ctl 四包
- **参考**: [sing-box 迁移指南](https://sing-box.sagernet.org/migration/)（各版本破坏性变更的事实来源）

---

## 0. 背景与现状诊断

不同 sing-box 版本之间存在配置格式的不兼容（1.11 引入规则动作、1.12 移除旧 DNS
格式并要求 `domain_resolver` / 引入 `certificate_provider` 与 `http_clients` 等）。
当前系统中"实际运行的 sing-box 版本"不受任何人管理，且没有任何元数据表达
"某模板需要哪个版本的 sing-box"。

### 0.1 版本信息目前是三处割裂的

| 位置 | 现状 | 问题 |
|---|---|---|
| `packages/cloud/src/templates/docker/default/template.json` | 硬编码 `ghcr.io/sagernet/sing-box:latest` | 实际**运行**版本不受控；`latest` 重新 pull 时静默升级，可能直接跑不起来 |
| `packages/core/src/services/store.ts` `AppConfig.singbox_image` | 默认 `:latest`，仅 `SingboxValidator`（配置校验）读取 | 与部署镜像**无任何关联**；且 panel 的 `getCore()` 快照只比较 url/token（`packages/panel/server/core-provider.ts`），core 实例存活期间改此值，校验器不会刷新 |
| 模板 `config.json` 的 `version` 字段 | 模板自身版本（如 `1.0.0`） | 与 sing-box 兼容性无关 |

内置模板已全部使用 1.12+ 语法（`http_clients`、`default_domain_resolver`、
DNS `type: tls` 新格式、hysteria2 的 `certificate_provider`）。一台跑 1.10 的
节点拿到渲染结果会直接失败——系统对此一无所知，报错只会出现在容器日志里。

### 0.2 与 c31cd89 的关系

`c31cd89` 让部署链路支持选择非默认整体模板：
`core.deploy(options)` → `CloudClient.renderDeploy(instances, options)` →
`POST /api/render/deploy` body 携带 `serverOverallId` / `dockerOverallId`，
Deploy.vue 新增服务器模板下拉框（`templateStore.fetchTemplates('server')`）。

这让**版本兼容性问题多了一个暴露面**：用户在 Deploy 页选中的非默认模板，
可能与本机 sing-box 版本不兼容。本方案与该变更的协同点：

1. Deploy.vue 的模板下拉框经由 `/core/cloud/templates?role=server` 拉取 ——
   本方案让该路由自动带上本机版本做服务端过滤，**下拉框零前端改动即只剩兼容模板**；
2. `renderDeploy` 的 `options` 透传机制（`body: { instances, ...options }`）
   为 `singboxVersion` 提供了天然入口；
3. 部署期 compat 强校验（cloud 400）成为用户选错模板时的最终防线，
   错误信息需点名冲突模板（可能正是 Deploy 页的下拉选择）。

### 0.3 语义分层（沿用现有 asymmetry）

`db/schema.ts` 已有设计注释：节点级绑定（server/docker overall）与订阅级绑定
（client overall）分离是刻意的。本方案引入一组新的、同样刻意的分层：

- **模板选择**（`serverOverallId` / `dockerOverallId`）：**请求级**、临时的，
  每次部署可换 —— c31cd89 已实现；
- **sing-box 版本**（`singbox_version`）：**节点级**、持久的状态，
  存于 core `AppConfig`，驱动模板过滤、镜像 pin、校验器镜像。

版本不进 deploy 请求体：由 core 从 `AppConfig` 读取后合并进
`renderDeploy` options。panel 的 `deploySchema` 保持不变，ctl 同样免费获得
版本注入。若未来需要"临时试一个版本再决定"，可在 deploy options 里加
一次性覆盖（本方案不做，见 §12）。

---

## 1. 设计原则

1. **单一事实来源**：模板兼容范围归 cloud（模板元数据的一部分）；
   版本选择归节点（core 本地 store，panel / ctl 共写）。
2. **纵深防御**（任何一层漏过都有下一层兜底）：
   1. 列表过滤（panel 拉模板时只拿兼容的 —— UX 层）；
   2. 渲染强制（cloud 对不兼容组合直接 400）；
   3. 校验器（core 用 pin 版本镜像跑 `sing-box check`）；
   4. `entry.sh` 内的 `sing-box check` + 健康检查超时自动回滚（已有，
      `DockerManager.deployRenderedLocked`）。
3. **不设版本 = 现状行为**：所有新字段可选，NULL/空值语义为"任意"；
   旧数据、旧 cloud、旧 panel 全部无感。
4. **semver 匹配只在 cloud 实现**：panel / panel-server 只消费 cloud 的
   过滤结果，不复制判定逻辑，杜绝两端漂移。

---

## 2. 核心概念模型

```
┌──────────────────┐   singbox_version (节点持久状态)   ┌─────────────────┐
│ 节点 core/panel   │ ────────────────────────────────▶ │ cloud           │
│ AppConfig(本地库) │                                   │ · 列表按兼容过滤  │
└──────────────────┘                                   │ · 渲染时强制校验  │
        ▲                                              │ · 注入 docker    │
        │ singbox_compat (模板声明)                      │   params 镜像版本 │
┌──────────────────┐                                   └─────────────────┘
│ 模板 (cloud D1)   │  protocol / overall-server / overall-client / overall-docker
└──────────────────┘
                                     渲染产物: ghcr.io/sagernet/sing-box:v1.12.9
```

| 概念 | 字段 | 归属 | 示例 |
|---|---|---|---|
| 模板兼容范围 | `singbox_compat` | cloud 模板（DB 列 + config.json 元数据） | `">=1.12.0 <2.0.0"` |
| 本机 sing-box 版本 | `singbox_version` | core `AppConfig`（panel/ctl 设置） | `"1.12.9"` |
| docker 镜像版本参数 | `singbox_version`（docker 模板的 param） | cloud 渲染时注入 | 渲染出 `...:v1.12.9` |
| 部署模板选择 | `serverOverallId` / `dockerOverallId` | 每次部署请求（c31cd89 已有） | `"server-tls"` |

**推导规则**：

- `singbox_version` 为空 → 不做任何过滤；docker 模板用其 param 默认值
  （内置模板默认值从 `:latest` 改为 pinned 稳定版，见 §3.2）；校验器用
  `singbox_image` 原值 —— 行为与现状等价（除内置模板默认镜像的变化）。
- `singbox_version` 已设置 → 所有模板列表按兼容范围过滤；
  `/api/render/deploy` 注入 `dockerParams.singbox_version`，compose 镜像
  pin 到 `v${version}`；校验器镜像同步 pin。

---

## 3. Cloud 端设计

### 3.1 数据模型（D1，幂等迁移）

```sql
ALTER TABLE templates ADD COLUMN singbox_compat TEXT;   -- NULL = 兼容任意版本
ALTER TABLE nodes    ADD COLUMN singbox_version TEXT;   -- 心跳上报，舰队可视化
```

在 `db/schema.ts` 的 `doInitialize` 中按现有 try/catch 风格执行
（"column may already exist"，与 `CREATE TABLE IF NOT EXISTS` 的容错一致），
避免迁移只对新库生效。

`engine/types.ts`：`TemplateRow` / `TemplateSchema` / `parseTemplateRow`
同步增加 `singboxCompat`；`SELECT *` 的路由自动带出该列，无需改查询。

### 3.2 仓库内模板种子

**每类模板 `config.json` 增加顶层字段** `singbox_compat`。
JSON Schema（`protocols/config.schema.json`、`overall-config.schema.json`）
与 zod（`ProtocolConfigFileSchema` / `OverallConfigFileSchema`）同步增加：
可选字符串 + 格式校验。

```jsonc
// protocols/hysteria2/config.json
{
  "name": "Hysteria2",
  "version": "1.0.0",
  "singbox_compat": ">=1.12.0",   // certificate_provider 为 1.12 引入
  "params": [ ... ]
}
```

建议的种子值（按各模板实际使用的语法核定）：

| 模板 | 种子 `singbox_compat` | 依据 |
|---|---|---|
| `protocols/hysteria2` | `>=1.12.0` | `certificate_provider`（ACME）1.12 引入 |
| `protocols/vless-reality-vision` | `>=1.8.0` | `xtls-rprx-vision` flow |
| `server/default`、`client/default` | `>=1.12.0` | `http_clients`、`default_domain_resolver`、DNS 新格式 |
| `docker/default` | `>=1.10.0` | entry.sh 仅用基础子命令，范围放宽 |

**docker 模板镜像参数化**（复用现有 param + 占位符机制，渲染零新代码；
`interpolator.ts` 的嵌入式占位符天然支持字符串内插）：

```jsonc
// docker/default/config.json
{
  "singbox_compat": ">=1.10.0",
  "params": [
    { "name": "singbox_version", "type": "select",
      "default": "1.12.9",
      "enum": ["1.12.9", "1.12.4", "1.11.15"],
      "description": "sing-box image tag" }
  ]
}

// docker/default/template.json
{
  "services": {
    "sing-box": {
      "image": "ghcr.io/sagernet/sing-box:{{ params.singbox_version }}",
      ...
    }
  }
}
```

**enum 即版本目录**：cloud 管理员通过编辑 docker 模板的 enum 策展可选版本，
panel 的版本下拉框从这里取 —— 不需要新增"版本目录"表或端点。
未设置版本的节点使用 `default`（pinned 稳定版）。

`db/seed.ts` 的 `refreshSeedTemplates` 按 id upsert 内置模板，
改动随 cloud 部署自动 rollout（自定义模板不受影响，为既有语义）。
注意：这会把内置 docker 模板的 `:latest` 改为 pinned 默认值 ——
**有意的改进**（部署从"漂移"变"确定"），需在变更日志标注：
已部署节点下次 deploy 后镜像从 `latest` 固定为默认版本。

### 3.3 API 契约变更（全部向后兼容）

| 端点 | 变更 |
|---|---|
| `GET /api/protocols?singbox_version=1.12.9` | 服务端过滤：仅返回 `singbox_compat` 匹配的协议；响应行含 `singbox_compat` 原文；另增 `filtered_count`（被隐藏数量，供 UI 提示） |
| `GET /api/templates?category=&singbox_version=` | 同上。Deploy 页的 server 模板下拉（c31cd89）经由此过滤 |
| `POST/PUT /api/protocols`、`POST/PUT /api/templates` | 接受 `singboxCompat`；格式非法 → `400 SBX_BAD_RANGE` |
| `POST /api/render` | body 增可选 `singboxVersion`；协议不兼容 → `400 SBX_VERSION_INCOMPATIBLE`（附 compat 原文与版本） |
| `POST /api/render/deploy` | body 增可选 `singboxVersion`、`dockerParams`；instances 增可选 `protocolId`（见 §3.4） |
| `POST /api/nodes/register` | 增可选 `singboxVersion`，存入 nodes 表（心跳顺路上报） |
| `GET /s/:path?token=…&version=1.12.9` | 订阅交付：可选 `version`，与订阅的 overall-client 模板 compat 校验，不匹配 → 400 明确报错；不传 → 现状 |

### 3.4 `POST /api/render/deploy` 的关键改动

现状（含 c31cd89）：body 为
`{ instances, serverOverallId?, dockerOverallId?, serverParams?, dockerOverrides? }`，
其中 `serverParams` 被同时传给 server overall 与 docker overall 渲染（历史
conflation）。新增：

```ts
// body 增: { singboxVersion?, dockerParams?, instances[].protocolId? }

// 1. 解析生效版本：body.singboxVersion || docker 模板 singbox_version param 的 default
// 2. 兼容性校验（任一失败 → 400 SBX_VERSION_INCOMPATIBLE，一次性列出全部冲突项：
//    [{ template, category, singbox_compat, version }]）:
//    - server overall 模板（可能是 Deploy 页选中的非默认模板！）
//    - docker overall 模板
//    - 每个 instance 的 protocolId 对应协议（旧调用方不传 protocolId 则跳过该条）
// 3. 注入镜像版本:
const dockerParams = {
  ...(body.serverParams ?? {}),   // 向后兼容：现状 serverParams 一直透传给 docker 渲染
  ...(body.dockerParams ?? {}),   // 新：docker 模板独立参数（修复 conflation）
  ...(version ? { singbox_version: version } : {}),
};
// 4. 响应增加: singboxVersion（实际生效值）、singboxImage（渲染出的完整镜像引用）
```

用户值在 `resolveAndValidate` 中天然优先于 param default，注入即生效。
自定义 docker 模板若未声明 `singbox_version` param，多余 userParam 被
忽略、无副作用 —— 文档注明：**docker 模板需声明 `singbox_version` 参数
才能被版本 pin**。

`protocolId` 来源：panel 侧 `ConfigEntry.type` 存的是创建配置时的协议
模板 id（core 侧映射到 instances 元素）。这让"先建配置、后降级 sing-box"
的场景在部署时被发现，而不是等容器起不来。

### 3.5 semver 范围引擎（新模块 `engine/compat.ts`）

- **语法**：`*`（缺省/NULL 等价）、`>=X.Y.Z`、`<X.Y.Z`、空格分隔多条件（AND）、
  `~X.Y.Z`、`^X.Y.Z`、精确 `X.Y.Z`。
- **实现**：引入 `semver` npm 包（纯 JS、Workers 兼容；cloud 已依赖 hono +
  zod，体积可接受）。不手写 —— prerelease 语义（范围默认不含 prerelease、
  精确匹配可命中）这类坑不值得自己踩。
- **版本入参校验**：`/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/` → `400 SBX_BAD_VERSION`。
  不允许 `+build`（docker tag 不允许 `+`，同时收窄镜像 tag 注入面）。
- **模板写路径校验**：`singboxCompat` 必须可解析 → `400 SBX_BAD_RANGE`。
- 匹配逻辑只存在于 cloud（见 §1 原则 4）。

---

## 4. Core 端设计

### 4.1 `AppConfig` 与镜像推导

```ts
// packages/core/src/schemas/config.ts
export interface AppConfig {
  ...
  singbox_version: string   // '' = 未设置（现状行为）；'1.12.9' = pin
}
// packages/core/src/services/store.ts
export const DEFAULT_APP_CONFIG: AppConfig = { ..., singbox_version: '' }
```

**校验器镜像推导**（消除"校验版本 ≠ 运行版本"）：

```
规则: singbox_version 已设置 → 把基础镜像的 tag 替换为 `v${version}`
      未设置            → 用 singbox_image 原值（高级用户整体自定义镜像）
实现注意: tag 切分只在最后一个 '/' 之后的 ':' 处进行
          （兼容 registry.example.com:5000/sing-box:latest 这类带端口的 registry）
```

`SingboxValidator` 构造时接收推导结果；推导函数从 core 包导出
（`deriveSingboxImage(version, baseImage)`），deploy 与校验共用。

### 4.2 CloudClient

- `getProtocols(version?)` / `getServerTemplates(version?)` /
  `getClientTemplates(version?)` / `getDockerTemplates(version?)`
  → query 附 `singbox_version`；
- `renderDeploy(instances, options)`：options 增 `singboxVersion`（c31cd89 的
  options 透传机制 `{ instances, ...options }` 使其直接进 body）；
  instances 元素增 `protocolId`；
- `registerNode` 附 `singboxVersion`（心跳顺路上报，无额外请求）。

### 4.3 deploy 流程（`core.ts`）

```ts
// c31cd89 之后的签名保持不变；版本由 core 注入，不进 panel 请求体
async deploy(options: { serverOverallId?: string; dockerOverallId?: string } = {}) {
  const version = this.store.loadAppConfig().singbox_version;
  const instances = enabled.map((e) => ({
    id: e.name,
    protocolId: e.type,          // 新增：部署期协议兼容校验的依据
    serverConfig: e.server_config,
    clientConfig: e.client_config,
  }));
  const rendered = await this.cloud.renderDeploy(instances, {
    ...options,
    ...(version ? { singboxVersion: version } : {}),
  });
  await this.docker.deployRendered(rendered.serverConfig, rendered.composeYaml,
                                   rendered.entrySh, {
    singboxVersion: rendered.singboxVersion,
    singboxImage: rendered.singboxImage,
    deployedAt: new Date().toISOString(),
  });
}
```

### 4.4 DockerManager 增补

- `deployRendered` 增可选 `meta` 参数，与 compose 同批原子写
  `deploy-meta.json`（docker 目录内）：记录上次部署生效的版本 / 镜像 /
  时间 —— panel 之后随时可读，**不依赖容器还活着**；
- `getDeployMeta(): { singboxVersion?, singboxImage?, deployedAt? } | null`
  （旧部署无此文件 → null，UI 显示 unknown）；
- （P2 可选）健康检查通过后 `docker compose exec -T sing-box sing-box version`
  抓实际版本，与期望不符则告警 —— 防本地已有错误 tag 镜像等边缘情况。

---

## 5. Panel 端设计

### 5.1 Settings 新增 "sing-box" 卡片

```
┌ sing-box ─────────────────────────────────────────────┐
│ 版本: [1.12.9 ▾]     （未设置 = 跟随 docker 模板默认）  │
│   下拉选项 ← cloud docker 模板 singbox_version param    │
│   的 enum（Settings 页 fetchTemplates('docker') 后读取）│
│   + "custom…" 自由输入（semver 格式校验）               │
│ 当前运行: v1.12.4（deploy-meta）                        │
│   ⚠ 已选 1.12.9，Redeploy 后生效                       │
│ [保存]                                                 │
│ 提示: 不兼容模板将在创建配置/部署选择时隐藏;             │
│ 部署镜像固定为 ghcr.io/sagernet/sing-box:v1.12.9        │
└───────────────────────────────────────────────────────┘
```

服务端（`server/routes/settings.ts`）：schema 增 `singbox_version`；
保存时与 node identity 一样 mirror 进 `core.updateAppConfig`。
**同时把 `singbox_version` 加入 `getCore()` 的快照比较**
（`core-provider.ts` 的 `snapshot()`）—— 否则改版本后 core 实例不重建，
校验器拿不到新镜像。这顺带修复现有 `singbox_image` 同源的 stale 问题。

### 5.2 ConfigCreate（配置创建）

- panel 服务端 `/core/cloud/templates` 路由自动注入本机版本
  （读 `core.getAppConfig().singbox_version` 传给 CloudClient）→
  前端零改动即拿到过滤后列表；
- 模板卡片显示兼容徽章（如 `≥1.12`）；列表尾部提示
  "已隐藏 N 个与 sing-box 1.12.9 不兼容的模板"（用 `filtered_count`）；
- `POST /core/cloud/generate` → cloud `POST /api/render` 二次强制
  （纵深防御第 2 层）。

### 5.3 Deploy 页（与 c31cd89 的协同）

- **服务器模板下拉框自动被过滤**：`Deploy.vue` 的
  `templateStore.fetchTemplates('server')` → `/core/cloud/templates?role=server`
  已由 §5.2 的服务端注入带上版本 → 下拉只剩兼容模板，前端零改动；
- 状态卡片增一行：配置版本 / 运行版本（新路由
  `GET /api/core/deploy/meta` 读 `getDeployMeta`），不一致显示
  "Redeploy to apply"；
- `SBX_VERSION_INCOMPATIBLE` 错误透传为可读消息（列出冲突模板与所需范围
  —— 可能正是用户在下拉框里选的模板），并引导跳转 Settings；
- 未来若补 `dockerOverallId` 下拉框（c31cd89 已打通 API 但无 UI），
  同样自动获得过滤。

### 5.4 SubscriptionCreate（P1，可选）

- overall-client 模板选择器显示 compat 徽章；
- 订阅详情页提供"复制带版本参数的订阅链接"（`&version=1.12.9`）。

---

## 6. ctl

```bash
chorusctl config set singbox_version 1.12.9
chorusctl config get                  # 显示版本 + 推导出的镜像
chorusctl validate merged             # 自动用 pin 版本镜像校验
chorusctl deploy                      # core 内部注入版本，免费获得
```

---

## 7. 端到端流程

**创建配置**：

```
Panel 选择协议 ← cloud GET /api/protocols?singbox_version=1.12.9（只回兼容模板）
     ↓ 填参
Panel → core.generateConfig → cloud POST /api/render {singboxVersion}
        （不兼容 → 400，纵深防御第 2 层）
     ↓ 渲染结果存入本地 ConfigEntry
```

**部署**（含 c31cd89 的模板选择）：

```
Deploy.vue: serverTemplateId（下拉，已被版本过滤）→ POST /core/deploy
  { serverOverallId }            ← 请求体不含版本
     ↓
core.deploy({ serverOverallId })
  version = AppConfig.singbox_version          ← 节点持久状态
  instances 带 protocolId
     ↓
cloud POST /api/render/deploy
  { instances[+protocolId], serverOverallId, singboxVersion: "1.12.9" }
  ├─ 校验: server overall ∋ 1.12.9（含 Deploy 页选中的非默认模板）
  │        docker overall ∋ 1.12.9
  │        每个协议 compat ∋ 1.12.9
  │        任一失败 → 400 SBX_VERSION_INCOMPATIBLE（列出全部冲突项）
  ├─ dockerParams.singbox_version = "1.12.9"（用户值优先于 param default）
  └─ 返回 { serverConfig, composeYaml(镜像 pin 到 v1.12.9), entrySh,
            singboxVersion, singboxImage }
     ↓
DockerManager: 原子写 compose / entry / config + deploy-meta.json
     ↓ docker compose up -d
entry.sh: sing-box check（同版本镜像！）失败 → 健康检查超时 → 自动回滚（已有）
```

**版本变更**：Settings 选新版本 → 保存（mirror core + 快照重建实例）→
下次创建配置 / 部署即生效；运行中容器不动，Deploy 页显示 drift 提示。

---

## 8. 向后兼容矩阵

| 场景 | 行为 |
|---|---|
| 旧模板行（`singbox_compat` NULL） | 视为 `*`，任何版本兼容，不过滤 |
| 旧 panel/core（不传版本） | 现状：不过滤 + docker 模板 param 默认镜像。内置模板默认从 `:latest` 变为 pinned 稳定版（**有意改进**，仅影响下次部署，需在 changelog 标注） |
| 新 panel + 旧 cloud | 旧 cloud 的 zod strip 未知字段，仍渲染旧模板（`:latest`）→ panel 检测 deploy 响应缺 `singboxImage` 字段 → 显示"当前 cloud 不支持版本管理，镜像未固定"降级提示 |
| 已部署节点的存量 compose | 不动；下次 deploy 才重渲染 |
| c31cd89 的 `serverOverallId`/`dockerOverallId` | 不受影响；新版下附带版本强制校验 |
| 订阅消费端不带 `?version=` | 现状渲染，无强校验 |

**发布顺序**：cloud 先行（新字段/参数全部可选）→ core → panel。
三包独立发版时任何顺序都不坏，但功能完整生效需 cloud ≥ 新版。

---

## 9. 安全与边界

- **注入面收窄**：`singboxVersion` 必须通过 `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`
  才进镜像 tag；`renderDocker` 的 YAML quoting 已有（`needsYamlQuote`）；
  `+build` 被排除（docker tag 非法字符）。
- **`latest` / 未设置**：不评估 compat，不做过滤 —— 显式语义，不是隐式失败。
- **prerelease**：范围匹配默认不含 prerelease（semver 标准语义），
  精确指定可命中 —— 在模板文档中注明。
- **订阅端**：消费端 sing-box 版本对 cloud 不可知，`?version=` 为显式
  opt-in；不同版本受众各建一个订阅（订阅本就是 per-audience 的）。
- 端口冲突、Tag 唯一性等现有校验不受影响。

---

## 10. 测试计划

**cloud**
- `engine/compat.ts` 单测：范围 / 通配 / prerelease / 非法串；
- 列表过滤端点（含 `filtered_count`、NULL compat 全通过）；
- `POST /api/render` 与 `/api/render/deploy` 的
  `SBX_VERSION_INCOMPATIBLE` / `SBX_BAD_VERSION` / `SBX_BAD_RANGE` 路径
  （deploy 用例须覆盖"非默认 serverOverallId 不兼容"—— 对应 c31cd89 场景）；
- dockerParams 注入后 compose 镜像 tag 断言；`dockerParams` 与
  `serverParams` 分离的回归；
- ALTER TABLE 幂等（二次 init 不炸）。

**core**
- `deriveSingboxImage`：registry 带端口、`:latest` 替换、未设置原样返回；
- renderDeploy payload 含版本与 protocolId；options 与版本的合并；
- deploy-meta.json 写入 / 读取 / 旧部署缺失容错；
- 旧 cloud 响应（无新字段）不炸。

**panel**
- settings 回路（含 core mirror 与快照重建）；
- 模板过滤提示与徽章渲染；Deploy 页 drift 文案；
- `SBX_VERSION_INCOMPATIBLE` 错误展示。

---

## 11. 分期实施

**P0（核心闭环）**
- 模板 `singbox_compat` 字段 + D1 迁移 + 种子 + schema（JSON Schema / zod）；
- 列表过滤（protocols / templates 两个 GET）；
- `render` / `render/deploy` 强制校验 + `dockerParams` 注入 + 响应增版本字段；
- docker 模板镜像参数化（`:latest` → `{{ params.singbox_version }}`）；
- core `AppConfig.singbox_version` + validator 镜像推导 + deploy 注入 +
  `deploy-meta.json`；
- panel Settings 卡片（含快照修复）+ ConfigCreate / Deploy 下拉自动过滤。

**P1**
- 心跳上报版本（nodes 表 + 云端可见）；
- `GET /api/core/deploy/meta` 路由 + Deploy 页版本展示与 drift 提示；
- 订阅 `?version=` + SubscriptionCreate 徽章；
- ctl `config set/get`。

**P2（可选）**
- `ConfigEntry` 记录创建时 compat 快照 → 切换版本后本地标记不兼容存量配置；
- 部署后 `docker compose exec` 实际版本验证；
- legacy 模板族（如 `server-legacy-1.11`，`singbox_compat: ">=1.10.0 <1.12.0"`，
  使用旧 DNS 格式）实现多版本共存 —— 本方案的自然延伸：
  兼容范围声明 + Deploy 页模板选择（c31cd89）组合起来已经支持它。

---

## 12. 关键取舍（可推翻的决策点）

1. **版本选择存 core store**（panel mirror），而非 cloud nodes 表 ——
   ctl 与 panel 共享同一配置，cloud 不保存"偏好"；nodes 表只做心跳可视化。
2. **版本目录 = docker 模板 param enum**，不建新表/新端点 ——
   策展入口唯一（模板编辑），机制零新增。
3. **版本不进 deploy 请求体**，由 core 从 AppConfig 注入 ——
   与 c31cd89 的请求级模板选择形成清晰的分层（§0.3）；
   需要临时试版本时再扩展 deploy options。
4. **订阅端不强校验** —— 消费端版本不可知；`?version=` 显式 opt-in。
5. **semver 匹配只在 cloud** —— panel 只消费过滤结果。
6. **`singbox_image` 保留为高级覆盖**（自定义 registry 时整体替换），
   `singbox_version` 是常规路径。
