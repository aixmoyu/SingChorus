---
project: SingChorus
type: adr
id: ADR-cloud-006
description: schema 维持「migrations 迁移文件 + 运行时 eager DDL」双源真值，以结构指纹测试钉死等价性，以幂等 ALTER 补列打通存量库升级——而非砍掉任何一源。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-cloud-006: 双源 schema 真值与指纹钉死"
date: 2026-09-24
code_refs:
  - packages/cloud/src/db/schema.ts
  - packages/cloud/migrations/0001_init.sql
  - packages/cloud/tests/schema-fingerprint.spec.ts
  - packages/cloud/tests/schema-upgrade.spec.ts
---

# ADR-cloud-006: 双源 schema 真值与指纹钉死

## 状态

accepted（决策 ID CLOUD-C3；42063a9 为触发修复）

## 1. 背景

**业务背景**：生产库用 `wrangler d1 migrations apply` 升级（package.json:8-9）；测试与本地可能跳过迁移直接建库。
**技术背景**：eager DDL 让「任何环境开箱即用」（schema.ts:37 注释）；但 42063a9 暴露真实事故——旧库缺 singbox_version 列，插入订阅报 no such column 500。
**核心问题**：两条建库路径并行，如何既保留各自价值又杜绝结构漂移？

**约束条件**：

- SQLite ADD COLUMN 限制：NOT NULL 必须带 DEFAULT
- eager DDL 的语句会原样进 sqlite_master（禁 `--` 行内注释）
- fingerprint 对比必须容忍 ALTER 追加导致的列序差异

## 2. 决策驱动因素

1. **开箱即用**（高）：测试/本地/灾备重建不应强制先跑迁移。
2. **生产可升级**（高）：存量库必须有受控迁移通道。
3. **漂移早曝**（高）：结构分叉必须在 CI 暴露而非生产。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|仅 migrations，运行时不建表|单一真值|测试/本地必须先 apply；node 入口首启体验差|环境搭建摩擦|
|Option B|仅 eager DDL，废弃 migrations|零迁移运维|存量库升级无通道；列变更即事故（42063a9 即证）|生产升级失控|
|Option C|双源 + 指纹测试 + 幂等 ALTER 补列|两场景兼得；漂移 CI 拦截|每次列变更三处同步的纪律成本|纪律失守（缓解：checklist）|

### Option C：双源钉死（已实施）

- 迁移源：migrations/0001_init.sql（9 表 + 17 索引，136 行）。
- 运行时源：CREATE_TABLES/CREATE_INDEXES/ALTER_TABLES 三段幂等执行（schema.ts:34-52,57-63）。
- 钉子：schema-fingerprint.spec.ts 对两源做列集+约束+索引结构快照，列序归一化（:13-14,32-56）；schema-upgrade.spec.ts 钉 ALTER 升级路径。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：驱动因素全满足；漂移类事故（42063a9）从事后修复转为 CI 前置拦截；幂等 ALTER 让「旧库缺列」有确定性修复通道。

### 4.1 实施要点

- 新列三处同步：CREATE_TABLES、0001_init.sql、ALTER_TABLES（存量库）。
- NOT NULL 新列必须带 DEFAULT（schema.ts:60-62 注释引 SQLite 限制）。
- DDL 字符串禁 `--` 注释（会破坏指纹一致性，schema.ts:120-121）。

## 备注

- 残余风险：纪律依赖人工 checklist（module_design.md 修改检查清单首项）；无 lint 强制。
- 相关原则：principles_cloud_005；风险条目 risk.md RD-01。
