---
project: SingChorus
type: adr
id: ADR-cloud-001
description: 客户端配置与订阅缓存从 KV Namespace 全面迁入 D1，以「单一存储 + isolate 级 memoize/TTL」同时解决双存储一致性与 subrequest 预算问题。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-cloud-001: KV 全面迁入 D1 与昂贵调用记忆化"
date: 2026-09-18
code_refs:
  - packages/cloud/src/db/schema.ts
  - packages/cloud/src/db/seed.ts
  - packages/cloud/migrations/0001_init.sql
  - packages/cloud/src/engine/registry.ts
  - packages/cloud/src/routes/subscriptions.ts
  - packages/cloud/wrangler.toml
---

# ADR-cloud-001: KV 全面迁入 D1 与昂贵调用记忆化

## 状态

accepted（细化全局 ADR-001，不重复其全局编号）

## 1. 背景

**业务背景**：客户端配置（panel 推送）与订阅交付缓存原本放 KV；配置语义是「按节点指纹组织的记录集」，KV 的单键模型迫使拆分键位（`client:{...}`）并维护二级索引。
**技术背景**：D1 已承担全部元数据表；KV 与 D1 并存造成两套迁移/两套降级路径；同时 D1 调用计入 Workers 免费版 50 subrequest/请求预算，历史事故为幂等 DDL 每请求重跑挤爆预算随机 500。
**核心问题**：如何用单一存储承载记录型数据，且不让 D1 预算成为热路径瓶颈？

**约束条件**：

- 免费版预算：每请求 50 subrequests（schema.ts:5-9 注释）
- 订阅消费端为高频轮询（与 panel 5min 全同步节奏对齐）

## 2. 决策驱动因素

1. **单一数据域**（高）：配置记录的查询（按指纹/ tag/端口）是关系型需求，KV 无法表达。
2. **预算硬约束**（高）：每请求 D1 往返数必须可数且有界。
3. **部署简化**（中）：wrangler.toml 仅剩 DB 绑定（wrangler.toml:10-17）。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|保留 KV+D1 双存储，KV 存配置体|读便宜|双源一致性、双降级路径、键位漂移（历史已发生：deploy 归档键与 clients 键 schema 冲突，deploy.ts:103-106）|数据漂移|
|Option B|全迁 D1 + 无缓存|单一真值|每请求多次 D1 往返，预算爆|热路径 500|
|Option C|全迁 D1 + isolate memoize/TTL + 写路径失效|单一真值且预算有界|多 isolate 30s/300s 最终一致窗口|可接受的陈旧性|

### Option C：全 D1 + 三层记忆化（已实施）

- D1 新增 `client_configs`、`sub_delivery_cache` 表（migrations/0001_init.sql:67-91）。
- initPromise memoize DDL（schema.ts:10-20）；模板缓存模块级 Map+30s TTL（registry.ts:125-155）；交付 configsCache 300s（subscriptions.ts:15-33）；交付缓存写节流 5min/path（subscriptions.ts:47-64）。

## 4. 决策结果

**选择方案**：**Option C**（commit 7b1ef0e，2026-09-18：「将客户端配置与订阅缓存从 KV 迁移至 D1」）
**选择理由**：单一数据域消除键位漂移类 bug；预算问题以缓存层次解决而非换存储；降级路径收敛到 D1 一处（配合 ADR-cloud-003 三级降级）。

### 4.1 实施要点

- 交付缓存迁 D1 顺带获得跨 isolate 共享（KV 时代即有，但 token 哈希/active 校验语义在 D1 版本补齐，subscriptions.ts:36-45）。
- wrangler.toml 移除 KV 绑定，仅保留 D1。

## 备注

- 决策证据注释：schema.ts:4-9（预算→memoize 依据）、registry.ts:118-124（实例缓存→模块缓存）、subscriptions.ts:19-23（CLOUD-P3 300s 依据）。
- 多 isolate 陈旧窗口见 risk.md RC-01/RC-02。
