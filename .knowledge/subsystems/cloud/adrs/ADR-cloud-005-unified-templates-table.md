---
project: SingChorus
type: adr
id: ADR-cloud-005
description: 协议模板与三类整体模板统一收敛为单张 templates 表、以 category 字段区分四类，替代「分表 + 双 API 域」的早期形态，换取渲染端单一加载路径与统一 compat 声明。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-cloud-005: 统一 templates 表四类 category"
date: 2026-09-18
code_refs:
  - packages/cloud/src/db/schema.ts
  - packages/cloud/src/engine/types.ts
  - packages/cloud/src/engine/registry.ts
  - packages/cloud/src/routes/templates.ts
  - packages/cloud/src/routes/protocols.ts
---

# ADR-cloud-005: 统一 templates 表四类 category

## 状态

accepted

## 1. 背景

**业务背景**：系统需要四类模板：协议（server/client 双 JSON）与 server/client/docker 三类整体模板；早期为分离的存储与 API 域。
**技术背景**：四类模板共享同一组元数据（id/name/version/params/description）且都需 singbox_compat 声明（schema.ts:54-56 注释引 docs/design/singbox-version-management.md §3.1）；渲染引擎每次全量加载。
**核心问题**：四类模板分表各管，还是单表 category 区分？

**约束条件**：

- 渲染端希望一次 `SELECT * FROM templates` 载入全部（缓存友好）
- compat 校验/版本目录需要跨类统一查询（templates.ts:50,78-80）
- 订阅/实例 FK 只指向模板 id

## 2. 决策驱动因素

1. **单次加载**（高）：缓存设计（ADR-cloud-001）要求一查询载全部模板。
2. **跨类一致性**（高）：singbox_compat 的校验/过滤逻辑不应按类复制四份。
3. **FK 简化**（中）：protocol_instances/subscriptions 统一引用 templates(id)。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|四张表（protocols + overalls）或沿用早期分域|每表列窄、约束精确|四次加载、四套 CRUD/校验、FK 指向不一|compat 逻辑四处漂移|
|Option B|单表 + category 枚举 + 可空列|一查询全载；统一 CRUD/compat；FK 单点|行内多可空列（server_template/template_content 等互斥）；category 完整性靠应用层|脏 category 行渲染期才暴露|
|Option C|JSON 文档单存储（whole doc）|无列问题|丧失 SQL 级过滤/索引/迁移能力|与 D1 关系型优势相悖|

### Option B：单表 category（已实施）

- 表结构：category TEXT + 四类互斥可空列组（schema.ts:84-102）。
- 类型层：`TEMPLATE_CATEGORIES = ['protocol','overall-server','overall-client','overall-docker']`（types.ts:65）；统一 Template schema 经 parseTemplateRow 校验行（types.ts:184-199）。
- 视图层：asProtocol/asOverall 窄化为渲染需要的形状，缺失必需字段抛 PLG_UNKNOWN_TYPE（registry.ts:69-102）。
- API 层：protocols.ts 与 templates.ts 仍是两个域（query 固定 category 过滤，protocols.ts:27、templates.ts:50），但底层同表。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：渲染端 `SELECT *` 单查询 + 模块级缓存（registry.ts:163）直接受益；compat 声明与版本目录聚合天然跨类；category 完整性风险由 asProtocol/asOverall 的快速失败与 admin/seed 的 zod 配置校验（admin.ts:38-65）收敛。

### 4.1 实施要点

- API 接受短名 server/client/docker 并映射 overall-*（templates.ts:10-17）。
- 渲染侧按 category 二次校验（registry.ts:273-275,320）——「行存在的 category 正确性」不依赖 DB 约束。

## 备注

- 互斥可空列是本方案已知代价；若模板类型继续膨胀应重估（新增类型 = 新 category + 窄化视图，无需 DDL 变更，这是该方案的扩展性收益）。
