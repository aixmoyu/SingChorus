---
project: SingChorus
type: development-principle
id: principle-cloud-008
description: 双运行时（Workers+D1 / Node+SQLite）差异只允许存在于唯一 seam——绑定注入；业务代码零运行时分支，适配器只实现应用实际使用的 D1 表面并由 Node API 测试套件钉住。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 运行时差异收敛单一 Seam

## 原则详细描述

同一 Hono app（`export { app }`，index.ts:106-108）被两个入口消费：Workers fetch（index.ts:100-104）与 Node serve（node/entry.ts:125-131）。差异全部体现在注入的 env 对象上：D1→SqliteD1、Secrets→env 变量（缺失则自动生成持久化 secrets.json，entry.ts:53-85）、RateLimit→MemoryRateLimiter（opt-in）、LOG_LEVEL→process.env（entry.ts:96-106 注释「Single seam between runtimes」）。运行时感知的工具（fireAndForget 的 waitUntil vs 分离 Promise，fire-and-forget.ts:13-19；日志目的地 console→Workers Logs/stdout，logger.ts:1-20）内部消化差异，对外接口一致。

## 为什么要这样

- 自托管（VPS/Docker）与 Cloudflare 托管共享全部业务逻辑——修复一次，两边生效；测试（tests/node/api.spec.ts:1-9）直接跑 Node 适配器钉住契约，漂移在 CI 暴露而非生产事故。
- SqliteD1 刻意镜像 D1 的绑定值拒绝规则（boolean/undefined throw，d1-sqlite.ts:28-43），让「Workers 上会失败的代码在 Node 上也失败」，避免运行时行为分叉。
- 未实现的 D1 方法不补齐（raw 虽无消费者也实现以阻断未来静默分叉，d1-sqlite.ts:83-87）——表面用最小化与钉死测试是一体两面。
- 可选绑定（SUBSCRIPTION_RATE_LIMITER）以 `?.` + try/catch 消费（subscriptions.ts:197-206），env.d.ts:3-4 声明「有意不绑定，免费版友好」。

## 适用范围

- packages/cloud/src/node/；任何需要感知运行时的新代码。

## 规则

- 业务/路由/engine 代码禁止 `import` Node 专有模块或 Workers 专有 API。
- 运行时差异只允许出现在：node/ 入口装配、fireAndForget、logger 的目的地注释、SqliteD1 适配器。
- 新增 D1 方法调用必须确认 SqliteD1 已实现，并在 tests/node/api.spec.ts 补用例。
- Node 专属行为（如 boot 即建库 fail-fast，entry.ts:108-112）放入口文件，不进共享层。

## 反模式 / 禁止项

- 业务代码里 `if (isWorkers)` 式分支。
- 在 Workers bundle 引入 better-sqlite3（适配器仅被 Node 入口 import，d1-sqlite.ts:10-12）。
- 为「对称」把 Node 专有逻辑抽进共享模块。

## 修改检查清单

- [ ] 改动是否引入了运行时分支？
- [ ] 双套件（vitest + vitest.config.node.ts）都过了吗？
- [ ] 新绑定在两个入口都有注入（或显式可选）吗？
