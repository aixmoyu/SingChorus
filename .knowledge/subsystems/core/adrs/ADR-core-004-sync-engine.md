---
project: "SingChorus"
type: adr
id: ADR-core-004
description: 后台同步采用「变更即时触发 fire-and-forget + ≥30s tick 巡检 + 五级退避重试 + 运行中合并」的引擎形态，而非每变更阻塞或纯轮询。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "后台同步引擎形态：trigger + tick + 退避 + 单飞合并"
date: 2026-09-24
code_refs:
  - packages/core/src/services/sync-service.ts:12-19,46-133
  - packages/core/src/core.ts:170-303
  - packages/panel/server/core-provider.ts:41,120-135

---

# ADR-core-004: 后台同步引擎形态（core-D3/core-R5）

## 状态

accepted

## 1. 背景

**业务背景**：配置变更需要尽快出现在云端（订阅/他节点可见），但云端可能不可达；同时空闲时也要周期拉取他节点配置。
**技术背景**：每轮全量同步消耗云端按节点数的列表查询配额；panel 是常驻进程，ctl 无常驻同步需求（变更后手动 sync）。
**核心问题**：同步的触发、重试与配额消耗采用什么形态？

**约束条件**：

- 云端配额有限：每轮 = 1 次列表查询/被拉节点（sync-service.ts:15-16 注释）
- 前端体验：变更后不能等分钟级 tick
- 单实例进程，无分布式协调

## 2. 决策驱动因素

1. **变更时效**（高）：本地变更尽快上云。
2. **配额克制**（高）：空闲不烧配额。
3. **实现简单**（中）：进程内存态即可。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|每次变更同步阻塞请求|语义最直白|前端被云端慢拖死；失败丢变更|可用性耦合|
|Option B|纯定时轮询|实现最简|变更延迟至秒-分钟级；空闲也烧配额|配额浪费|
|Option C|trigger(合并) + tick(巡检) + 五级退避（采纳）|变更即时、空闲克制、失败不丢|状态机复杂（running/pending/disposed）|触发契约靠宿主自觉|

### Option C 详述

- `trigger()`：变更后调用；运行中仅置 pending 合并，本轮结束补跑一轮；直接起跑不置 pending 防冗余补跑（core-R5，sync-service.ts:50-60,111-118）。宿主以 fire-and-forget `void getSyncService().trigger()` 使用（core-provider.ts:131-135）。
- `tick()`：宿主 ≥30s 间隔调用（契约写明 core-D3，:12-17；panel SYNC_TICK_MS=30_000，core-provider.ts:41）；有未同步条目即重试，否则到 pullIntervalMs=600s 才拉取（:62-79）。
- 退避：整轮失败按 [5s,15s,60s,300s,900s] 调度重试，定时器 unref；成功即作废未到期定时器（:19,100-133）。
- 完整性：`failures` 明细随 `syncAllToCloud` 返回并暴露于 status，让面板解释 pending 徽标（:27-44；core.ts:170-178）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：即时性（因素 1）由 trigger 保证、配额克制（因素 2）由 tick+600s 拉取间隔与退避作废保证、简单性（因素 3）满足单实例假设；Option A/B 均牺牲其一。

### 4.1 实施要点

- disposed 后实例不得经定时器或 pending 复活；panel 重建 core 时 dispose 旧实例并新建（sync-service.ts:30-32,135-139；core-provider.ts:98-101）。
- 每轮引擎驱动的是同一 `core.syncAllToCloud()` 五步算法，手动/自动同一路径。

## 备注

- 宿主契约（tick≥30s、变更须 trigger）当前以注释+约定维系，见 risk.md RISK-CORE-D2。
