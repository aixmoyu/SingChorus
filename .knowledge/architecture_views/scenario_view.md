---
project: "SingChorus"
type: scenario-view
description: "sing-box 节点管理与订阅交付系统的六个端到端核心场景（部署、同步、交付、并发互斥、CLI 自动化、双形态发布），场景×四视图追溯矩阵与场景承载的非功能需求。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
---

# 场景视图（核心场景与四视图追溯）

> 场景视图是 4+1 模型的 **+1**：以「一个典型业务从触发到终局的完整旅程」为轴，把逻辑/进程/部署/开发四张视图串成一条可追溯的链。
> 四视图：[logical_view.md](logical_view.md) / [development_view.md](development_view.md) / [process_view.md](process_view.md) / [deployment_view.md](deployment_view.md)
> 模块划分（供 `subsystems/<module_id>/` 引用）：`core`（内核门面+本地状态）、`cloud`（云端渲染与订阅交付）、`panel`（管理台 BFF+SPA）、`ctl`（CLI）。

## 1. 核心场景

|场景 ID|场景名称|触发者|涉及子系统（subsystems/ 模块）|详情|
|-|-|-|-|-|
|SC-001|管理员部署 sing-box 节点|管理员（panel UI）|panel, core, cloud|§2.1|
|SC-002|节点配置变更自动同步云端|本地配置变更事件|core, cloud|§2.2|
|SC-003|客户端拉取订阅配置（交付面）|外部订阅客户端|cloud|§2.3|
|SC-004|双进程并发操作本地状态|panel-server 与 ctl 并存|core, panel, ctl|§2.4|
|SC-005|CLI 脚本化批量操作|自动化脚本 / 运维|ctl, core|§2.5|
|SC-006|cloud 双形态构建发布与升级|开发者 push / tag|cloud, panel（CI/CD）|§2.6|

## 2. 场景详述与四视图追溯

### 2.1 SC-001 管理员部署 sing-box 节点

**旅程**：管理员在 panel SPA 发起部署 → panel Express BFF（`/api` 固定前缀，`packages/panel/src/lib/http.ts:11`）→ core 门面 → **云端模板渲染**（无本地回退：「No local fallback: if the cloud can't render, deploy fails loudly」`packages/core/src/core.ts:421-427`）→ 渲染制品 temp+rename 原子写、保留 5 份备份（`packages/core/src/services/docker-manager.ts:50-66,8`）→ execFile 驱动 docker 启动容器（60s 超时、参数数组不经 shell，`docker-manager.ts:78-79`；`packages/core/src/services/validator.ts:80-82`）→ 健康检查通过后才落盘成功 meta（`docker-manager.ts:287-291`）；进程内 opQueue 串行 + `DeployInProgressError` 409（`docker-manager.ts:10,19-25`）。

|视图|追溯要点|
|-|-|
|逻辑视图|core 门面组装 6 服务、docker-manager 职责边界 — [logical_view.md](logical_view.md) §核心抽象|
|开发视图|panel BFF 分层、core 经 dist 被消费（改 core 先 build）— [development_view.md](development_view.md)|
|进程视图|opQueue 串行、execFile 子进程调用、健康检查信号 — [process_view.md](process_view.md)|
|部署视图|panel 容器 DooD 挂宿主 docker.sock 驱动 sing-box — [deployment_view.md](deployment_view.md)|

**非功能需求**：部署互斥（单飞）；失败显式化（观测不可用 ≠ stopped，`docker-manager.ts:344-370`）；端到端时长上限（渲染 25s + docker 60s + 健康 30s）超前端 axios 30s 超时为已知风险（[risk.md](risk.md) RISK-STAB-004）。

### 2.2 SC-002 节点配置变更自动同步云端

**旅程**：本地变更（panel UI / ctl / 部署落盘）→ fire-and-forget `triggerSync()`（9 处调用点）+ 30s tick + 5→900s 五级退避（unref 定时器），并发触发合并单飞（`packages/core/src/services/sync-service.ts:12-19,50-79,100-133`）→ core `syncAllToCloud` 五步双向同步：心跳 → 推送 → 删除对账 → 并行拉取（`Promise.allSettled` + 共享 25s 预算）→ 最终对账（`packages/core/src/core.ts:170-303,273-301`）→ 一致性靠 content_hash 对账 + (fingerprint,name) 幂等 upsert（`packages/cloud/src/routes/clients.ts:6-14,200-238`）。重装保护：本地全空时跳过删除对账，防清空云端唯一副本（`core.ts:246-258`，commit 66c45c2）。

|视图|追溯要点|
|-|-|
|逻辑视图|ChorusCore 门面编排、CloudClient 出站契约 — [logical_view.md](logical_view.md)|
|开发视图|core 零运行时依赖、host 注入 Logger/getRequestId — [development_view.md](development_view.md)|
|进程视图|进程内异步信号（无 MQ）、退避定时器、单飞合并 — [process_view.md](process_view.md)|
|部署视图|出站目标为 cloud 双形态实例（Workers 或自托管 Docker）— [deployment_view.md](deployment_view.md)|

**非功能需求**：最终一致（content_hash 对账）；失败显式化（getClients 失败即中止本轮而非当「云端为空」，`core.ts:201-207`；每配置失败上报 UI，`sync-service.ts:27-29`）；超时契约 25s < 前端 30s（`packages/core/src/services/cloud-client.ts:49-59`）。

### 2.3 SC-003 客户端拉取订阅配置（交付面）

**旅程**：订阅客户端带 token 请求 → cloud（同一 Hono app 双运行时，`packages/cloud/src/index.ts:100-108`）→ 三级降级交付：isolate 级 configsCache(300s) → D1 → `sub_delivery_cache` 陈旧兜底（24h TTL、仅存 token 哈希、active 校验、写限频 5min/path）→ 仍失败显式 503 `DB_UNAVAILABLE`（`packages/cloud/src/routes/subscriptions.ts:15-54,85-150,169-176,317-327`；`packages/cloud/src/index.ts:45-56`）。sing-box 版本绑定校验在交付端强制执行（commit e28b164/ea0a861，`subscriptions.ts:341-364`）。

|视图|追溯要点|
|-|-|
|逻辑视图|模板渲染引擎（interpolator/generators/compat）纯逻辑零 IO；semver 判定云端单点 — [logical_view.md](logical_view.md)|
|开发视图|KV→D1 迁移后的 schema（7+2 表）与 migrations — [development_view.md](development_view.md)|
|进程视图|三级降级链路、缓存写 best-effort 不阻塞主流程 — [process_view.md](process_view.md)|
|部署视图|Workers+D1 / Node+SQLite 双形态下交付行为一致；管理面不降级 — [deployment_view.md](deployment_view.md)|

**非功能需求**：可用性优先（D1 宕机仍可交付陈旧配置）；降级路径安全不放松（token 仅哈希、禁用/换 token 即失效，`subscriptions.ts:42-47,189-192`）；多 isolate 下缓存本地性风险见 [risk.md](risk.md) RISK-STAB-003。

### 2.4 SC-004 双进程并发操作本地状态

**旅程**：panel-server（长驻）与 ctl（CLI 短进程）共享 `~/.singchorus/data` → 所有 store 写操作经 `store.locked()` 串行 → 跨进程互斥：独占创建锁文件（O_EXCL）+ mtime 陈旧回收（10s）+ `Atomics.wait` 同步轮询（20ms 间隔/5s 超时）（`packages/core/src/services/lock.ts:4-17,37-86`；`packages/core/src/services/store.ts:172-187,314-322`）。锁内写身份/指纹防双进程分叉。

|视图|追溯要点|
|-|-|
|逻辑视图|LocalStore 单一本地事实源、ctl/panel 同依赖 core — [logical_view.md](logical_view.md)|
|开发视图|core 经 dist 双消费方，锁行为由测试钉住 — [development_view.md](development_view.md)|
|进程视图|锁全生命周期、sleepSync 阻塞语义与风险 — [process_view.md](process_view.md)|
|部署视图|panel 常驻容器/宿主进程 vs ctl 临时进程共址 — [deployment_view.md](deployment_view.md)|

**非功能需求**：互斥正确性（已知实现缺口见 [risk.md](risk.md) RISK-STAB-001/002：部署锁与文件锁语义差异、sleepSync 阻塞事件循环）。

### 2.5 SC-005 CLI 脚本化批量操作

**旅程**：运维脚本调用 `chorus ctl <command> --json` → ctl（8 个 CLI 命令）→ 复用 core 门面与本地锁 → 输出 JSON 契约供脚本消费（`packages/ctl/src/index.ts:19`，R-CTL-D4：文案格式不保证稳定）。

|视图|追溯要点|
|-|-|
|逻辑视图|ctl 与 panel 平级共享 core 门面 — [logical_view.md](logical_view.md)|
|开发视图|ctl 零 core 之外的运行时依赖、测试近空风险 — [development_view.md](development_view.md)|
|进程视图|ctl 短进程参与文件锁竞争 — [process_view.md](process_view.md)|
|部署视图|ctl 以 npm 包分发（预编译产物）— [deployment_view.md](deployment_view.md)|

**非功能需求**：机器可读输出契约稳定（--json）；短进程快速退出（无守护逻辑）。

### 2.6 SC-006 cloud 双形态构建发布与升级

**旅程**：开发者 push → CI（`.github/workflows/ci.yml`；改 core 先 build 再跑下游，`ci.yml:20`）→ tag `cloud-v*`/`panel-v*` 触发 GHCR 双架构镜像（amd64+arm64；tag→semver+latest，main→`edge` 通道，`docker-cloud.yml:45-69`）→ 自托管 `docker compose` 拉起 Node+SQLite 形态（`packages/cloud/Dockerfile:24-35`）；或 `wrangler deploy` 推 Workers+D1 形态（生产配置由 `scripts/setup-prod.mjs` 生成 `wrangler.prod.toml`，不手编）。npm 包内嵌预编译产物（panel bin 只加载 dist-server，`packages/panel/bin/chorus-panel.mjs:4-8`）。

|视图|追溯要点|
|-|-|
|逻辑视图|单一 Hono app 支撑双运行时，绑定注入差异 — [logical_view.md](logical_view.md)|
|开发视图|monorepo 工作区、构建顺序纪律、lockfile 约束 — [development_view.md](development_view.md)|
|进程视图|两形态运行时单元与适配器接缝（D1↔SqliteD1）— [process_view.md](process_view.md)|
|部署视图|环境矩阵（dev/CI/prod×2）、密钥三处存放、无 staging — [deployment_view.md](deployment_view.md)|

**非功能需求**：两形态行为一致由 Node API 测试钉住适配面（`packages/cloud/src/node/entry.ts:96-106`）；生产升级无金丝雀、无自动备份（[risk.md](risk.md) RISK-AVAIL-002）。

## 3. 场景 × 非功能需求汇总

|场景|关键 NFR|主要保障机制|残余风险|
|-|-|-|-|
|SC-001|互斥、失败显式|opQueue 串行 + 409 + 原子写|RISK-STAB-001/004|
|SC-002|最终一致|content_hash 对账 + 幂等 upsert + 空库守卫|RISK-DATA-001|
|SC-003|可用性|三级降级 + token 哈希|RISK-STAB-003、RISK-SEC-001|
|SC-004|互斥|O_EXCL 锁 + mtime 回收 + Atomics.wait|RISK-STAB-001/002|
|SC-005|输出契约|--json 稳定契约|RISK-DEBT-004|
|SC-006|形态一致性|单一 app + 适配层测试钉住|RISK-DEBT-001、RISK-AVAIL-002|
