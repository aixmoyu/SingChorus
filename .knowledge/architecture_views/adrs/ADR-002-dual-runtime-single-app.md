---
project: "SingChorus"
type: adr
id: ADR-global-002
description: "cloud 以单一 Hono 应用同时运行 Cloudflare Workers+D1 与 Node.js+SQLite 双形态，平台差异全部收敛到 node/ 适配器接缝并由测试钉住。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "cloud 采用单一应用双运行时（Workers+D1 / Node+SQLite）"
date: 2026-09-17
code_refs:
  - packages/cloud/src/index.ts:100-108
  - packages/cloud/src/node/entry.ts:11-19
  - packages/cloud/src/node/entry.ts:96-106
  - packages/cloud/src/node/d1-sqlite.ts:5-11
---

# ADR-002: cloud 采用单一应用双运行时

## 状态

accepted

## 1. 背景

**业务背景**：用户分为两类——不想自托管的开箱即用用户（Cloudflare 免费层）与有 VPS 的自托管用户（Docker）。
**技术背景**：业务逻辑（模板渲染、订阅交付、管理 API）两形态完全相同，仅持久化与限流绑定不同。
**核心问题**：为两种部署形态维护两套服务端代码，还是单一代码库 + 平台接缝？

**约束条件**：

- D1Database 是 Workers 专有接口，Node 侧无原生实现
- Workers 无文件系统，SQLite 需运行在 Node 容器
- 团队规模小，无法承担双倍维护

## 2. 决策驱动因素

1. **单一真值业务逻辑**（高）：渲染引擎与交付语义必须两形态完全一致，否则订阅内容分叉。
2. **自托管分发需求**（高）：Docker 形态是主要交付物之一（GHCR 镜像）。
3. **测试可行性**（中）：Node 形态可在 CI 原生运行 API 测试。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|双代码库/双 app|各自最优|逻辑漂移、双倍维护|交付行为不一致|
|Option B|仅 Workers，放弃自托管|零适配成本|丢失 VPS 用户群|—|
|Option C|单一 app + 适配器接缝|逻辑单源；差异可枚举可测试|需实现 SqliteD1 等适配层|适配面语义漂移|

### Option C：单一 app + 接缝适配（采纳）

业务路由零平台分支；Node 侧提供 `SqliteD1`（实现 D1Database 接口）、`MemoryRateLimiter`、env 日志注入（`node/entry.ts:11-19,96-106`；`node/d1-sqlite.ts:5-11`），两形态共享同一 app 装配（`index.ts:100-108`）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：驱动因素 1 直接否决 Option A；Option B 商业上不可行；C 的适配面风险用「Node API 测试钉住」对冲（`tests/node/api.spec.ts`）。

### 4.1 实施要点

- 平台差异只允许存在于 `src/node/` 与 Workers 装配处（principles_004）
- 适配器测试纳入 CI 必跑集
- 日志级别等 env 双名（LOG_LEVEL ↔ CHORUS_CLOUD_LOG_LEVEL）在两装配处各自注入

## 备注

- 残余风险：Node 形态工具链（typecheck/build）未接线，CI 未对 cloud 源跑 tsc → [../risk.md](../risk.md)。
