---
project: "SingChorus"
type: development-principle
id: principle-global-004
principle_scope: 模块级（cloud）
description: "cloud 以单一 Hono 应用同时运行于 Cloudflare Workers+D1 与 Node.js+SQLite，全部平台差异收敛到 node/ 适配器接缝（SqliteD1、MemoryRateLimiter、日志级别），业务路由零平台分支，并由 Node API 测试钉住适配面。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构-可移植性
---

# 双运行时差异收敛单一接缝

## 原则详细描述

cloud 的业务路由与引擎代码完全平台无关；Workers 与 Node 形态仅注入不同绑定：Node 侧以 `SqliteD1` 适配 D1Database 接口（`packages/cloud/src/node/d1-sqlite.ts:5-11`）、`MemoryRateLimiter` 替代 Workers 限流、日志级别从 env 注入（`packages/cloud/src/node/entry.ts:11-19,96-106`）。两形态共享同一 app 装配（`packages/cloud/src/index.ts:100-108`）。适配面由 `tests/node/api.spec.ts` 钉住防漂移。决策背景见 ADR-002。

## 为什么要这样

- 自托管（Docker/SQLite）与 Cloudflare（Workers/D1）双分发形态是产品需求；复制两套业务代码会让每个功能翻倍维护。
- 单一接缝让平台差异可枚举、可测试；「业务路由零分支」意味着新增功能默认两形态同时可用。
- 测试钉住适配面后，绑定语义漂移会在 CI 暴露。

## 适用范围

- 模块级：`packages/cloud/`。其他包若出现多运行时需求，应复制此「接缝适配 + 测试钉住」结构。

## 规则

- 业务路由/服务代码禁止 import 平台专有 API（workers types、node:sqlite 等）。
- 平台差异只允许出现在 `src/node/`（或对应的 workers 装配处），且必须对应一个适配器类实现 Workers 侧同名接口。
- 适配器行为必须有测试覆盖（api.spec 模式）。

## 反模式 / 禁止项

- 在路由 handler 里 `if (isWorkers)` 分支。
- 绕过 D1Database 接口直接使用 SQLite 方言特性导致两形态行为分叉。
- 只在一种形态手动验证就发布。

## 修改检查清单

- [ ] 改动是否引入平台分支？若是，能否下沉到接缝？
- [ ] SqliteD1/MemoryRateLimiter 适配面测试是否仍覆盖新行为？
- [ ] 两形态的日志/限流配置注入口是否同步？
