---
project: "SingChorus"
type: adr
id: ADR-global-001
description: "将客户端配置与订阅交付缓存从 Cloudflare KV 迁移至 D1，获得事务性、查询能力与交付兜底缓存表（sub_delivery_cache）。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "客户端配置与订阅缓存从 KV 迁移至 D1"
date: 2026-09-18
code_refs:
  - packages/cloud/src/db/schema.ts:9-12
  - packages/cloud/src/db/schema.ts:137-161
  - packages/cloud/migrations/0001_init.sql
---

# ADR-001: 客户端配置与订阅缓存从 KV 迁移至 D1

## 状态

accepted（commit 7b1ef0e「将客户端配置与订阅缓存从 KV 迁移至 D1」）

## 1. 背景

**业务背景**：多节点（clients）配置管理需要按 (fingerprint,name) 幂等更新、按 owner 列举、删除对账，KV 的 key-value 语义无法表达这些关系查询。
**技术背景**：项目初始使用 Workers KV 存放客户端配置与订阅缓存；随后引入 D1 承载核心关系表。
**核心问题**：客户端配置与交付缓存继续放 KV（简单但无查询/事务），还是统一迁入 D1（关系语义但消耗 subrequest 预算）？

**约束条件**：

- Workers 免费计划单请求 50 subrequest 上限（`packages/cloud/src/db/schema.ts:9-12` 注释明示此约束驱动 memoize 设计）
- 交付面要求 D1 宕机时仍有 stale 兜底（KV 时代由 KV 自身承担）

## 2. 决策驱动因素

1. **关系查询与幂等 upsert**（高）：删除对账、按 fingerprint 去重需要 SQL 约束与索引。
2. **事务一致性**（高）：配置更新与审计写入需原子。
3. **subrequest 预算**（中）：D1 调用计数，需 memoize 每 isolate 一次缓解（schema.ts:9-12）。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|保留 KV|零迁移成本；天然高可用|无事务/查询；对账逻辑在应用层拼凑|对账竞态导致配置漂移|
|Option B|KV+D1 双写混合|读路径快|双源真值、一致性难证明|数据分叉|
|Option C|全量迁 D1|单一真值、约束/索引/事务|subrequest 预算压力；宕机时交付需自建兜底|D1 故障直接 503|

### Option A：保留 KV

配置仍按 key 存放，应用层实现去重与对账。放弃。

### Option C：全量迁 D1（采纳）

配置入 `client_configs`，交付缓存入 `sub_delivery_cache`（24h TTL、token 仅哈希，`schema.ts:137-161`）；D1 宕机由三级降级链路兜底（ADR-009）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：驱动因素 1、2 只有 SQL 可满足；预算压力由 memoize + 缓存层级控制（principles_006）；可用性由 sub_delivery_cache 显式兜底，比 KV 黑盒更可控。

### 4.1 实施要点

- 迁移提交 7b1ef0e 删除 KV Namespace 绑定，新增两张表
- 交付缓存写限频 5min/path、best-effort 不阻塞主流程
- 测试与 migrations 指纹钉住 schema 一致性（`tests/schema-fingerprint.spec.ts`）

## 备注

- 后续 42063a9（2026-09-24）修复「旧库缺列升级报错」，暴露 migrations 与内联 schema 双源真值风险 → [../risk.md](../risk.md) RISK-DATA-002。
