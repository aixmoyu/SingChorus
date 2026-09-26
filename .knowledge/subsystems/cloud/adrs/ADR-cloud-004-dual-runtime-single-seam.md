---
project: SingChorus
type: adr
id: ADR-cloud-004
description: 双运行时采用「单一 Hono app + 绑定注入 seam」：Node 侧以手写最小 SqliteD1 适配器代替 ORM 抽象，适配器契约由 Node API 测试套件在 CI 钉死。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-cloud-004: 双运行时单一 seam 与最小 D1 适配器"
date: 2026-09-18
code_refs:
  - packages/cloud/src/node/entry.ts
  - packages/cloud/src/node/d1-sqlite.ts
  - packages/cloud/src/node/rate-limiter.ts
  - packages/cloud/tests/node/api.spec.ts
  - packages/cloud/src/index.ts
---

# ADR-cloud-004: 双运行时单一 seam 与最小 D1 适配器

## 状态

accepted（细化全局 ADR-002；wrangler compatibility_flags nodejs_compat，wrangler.toml:4）

## 1. 背景

**业务背景**：目标用户分两类——Cloudflare 免费版托管用户与 VPS 自托管用户；功能必须同步发布。
**技术背景**：Workers 提供 D1/Rate Limiting/Secrets 绑定；Node 只有 better-sqlite3 与 env。Workers bundle 不得引入原生模块（better-sqlite3）。
**核心问题**：如何让同一业务代码跑在两个运行时，且不出现「Workers 上正常、VPS 上炸」（或反之）的分叉？

**约束条件**：

- esbuild 打 Node 包时 better-sqlite3 必须 external（package.json:19）
- D1 与 SQLite 语义差异（bind 值规则、batch 事务）必须显式处理

## 2. 决策驱动因素

1. **行为一致**（高）：bind 规则等语义差异若静默吞掉即成生产分叉。
2. **零抽象税**（中）：全量 ORM/Drizzle 类抽象对 9 表小 schema 过重，且 Workers 侧仍要写 D1 原生 SQL。
3. **CI 可钉**（高）：分叉必须在测试暴露。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|仅支持 Workers|零适配成本|放弃自托管用户群|—|
|Option B|引入 ORM/查询构建器统一方言|类型安全|双驱动方言仍需适配；包体与复杂度上升；D1 特有 batch/RETURNING 仍要旁路|抽象泄漏|
|Option C|单一 app + env 注入 seam + 手写最小 SqliteD1 + Node API 套件钉契约|业务零分支；表面最小；CI 钉死|适配器需跟随路由新增方法手动补|漏补即 CI 失败（设计意图）|

### Option C：seam + 最小适配器（已实施）

- `export { app }`（index.ts:106-108）；Node entry 注入 SqliteD1/Secrets/MemoryRateLimiter/LOG_LEVEL（entry.ts:96-106）。
- SqliteD1 只实现应用用到的表面：prepare→bind/first/all/run/raw + batch（better-sqlite3 事务，d1-sqlite.ts:101-119）。
- 镜像 D1 bind 拒绝规则：boolean/undefined throw（d1-sqlite.ts:28-43）。
- fireAndForget 统一 waitUntil/分离 Promise（fire-and-forget.ts）；logger 只碰 console，目的地由运行时决定（logger.ts:1-20）。
- 契约钉子：tests/node/api.spec.ts 以完整中间件链跑同一 app（:1-9 注释「drift fails CI instead of breaking self-hosted deploys」）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：业务代码零运行时分支使修复单点生效双端；最小表面让适配器维护成本 ≈ 路由 D1 方法多样性（当前 6 个方法）；CI 套件把「漏适配」从生产事故降级为测试失败。

### 4.1 实施要点

- Node 密钥自动生成并持久化 secrets.json（0600），env 优先（entry.ts:53-85）。
- Node 启动即 ensureDatabaseInitialized fail-fast（entry.ts:108-112）。
- raw() 虽无消费者也实现，阻断未来静默分叉（d1-sqlite.ts:83-87）。

## 备注

- 可选绑定（SUBSCRIPTION_RATE_LIMITER）未在 wrangler.toml 绑定为有意决策（env.d.ts:3-4，免费版友好）。
- 相关原则：principles_cloud_008。
