---
project: SingChorus
type: adr
id: ADR-cloud-002
description: 订阅交付建立三级降级——isolate 内存缓存(300s) → D1 sub_delivery_cache stale(24h, token 哈希+active 校验) → 显式 503 DB_UNAVAILABLE，使 D1 宕机不再拖垮交付面。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-cloud-002: 订阅交付三级降级"
date: 2026-09-24
code_refs:
  - packages/cloud/src/routes/subscriptions.ts
  - packages/cloud/src/db/schema.ts
  - packages/cloud/src/index.ts
---

# ADR-cloud-002: 订阅交付三级降级

## 状态

accepted（决策 ID CLOUD-A2 内嵌于代码注释；细化全局 ADR-009）

## 1. 背景

**业务背景**：订阅交付（GET /s/:path）是终端 sing-box 客户端的拉取入口，为高频轮询；交付链路硬依赖 D1 的三类读：订阅行、实例/配置、模板。
**技术背景**：D1 免费版存在故障窗口；交付面宕机 = 全部终端客户端失联。管理面按 CLOUD-A2 语义显式 503（index.ts:49-54）。
**核心问题**：D1 宕机期间，交付面如何在「不外泄已停用/换 token 配置」的前提下继续服务？

**约束条件**：

- stale 服务必须尊重安全状态：token 轮换即拒绝、订阅停用即拒绝
- 缓存写不得把成功交付变成失败
- stale 新鲜度必须有上界

## 2. 决策驱动因素

1. **终端可用性**（高）：轮询消费者对短暂陈旧的容忍远高于对失败的容忍。
2. **安全不变量**（高）：停用/换 token 后旧配置不得经 stale 外泄。
3. **预算**（中）：缓存写必须节流。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|无降级，D1 失败即 503|实现零成本|D1 故障=交付面全灭|终端断网|
|Option B|仅 isolate 内存兜底|零额外存储|isolate 重启即失忆；多 isolate 不共享|降级覆盖率低|
|Option C|isolate 缓存(300s) + D1 stale 缓存(24h) + 503 兜底|两层覆盖 + 显式终态|需维护缓存失效联动|失效联动遗漏则 stale 外泄|

### Option C：三级降级（已实施）

- L1：configsCache isolate 300s，D1 失败时 stale 服务（subscriptions.ts:116-150）。
- L2：sub_delivery_cache 表，交付成功后节流写（≤1/5min/path），惰性 24h 清理；D1 查询失败三处 catch 均 serveStaleDelivery（subscriptions.ts:59-101,169-176,235-240,307-315）。
- L3：无可用缓存 → 503 DB_UNAVAILABLE。
- 安全联动：stale 行只存 token SHA-256 哈希；停用 403 路径、订阅更新（版本/模板/参数/token 变更）、删除、节点 rebind 均显式 DELETE 缓存（subscriptions.ts:188-195,508-515,530-534；nodes.ts:125）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：对照驱动因素——L1 保预算与内存级热路径，L2 跨 isolate 兜底且安全校验完整，L3 保持错误语义诚实（core 5xx 退避可消费）。

### 4.1 实施要点

- stale 命中四条件：条目存在、config 非空、active=1、token 哈希匹配（subscriptions.ts:94-95）。
- 响应带 `X-Subscription-Cache: stale` 头供观测（subscriptions.ts:96）。
- 缓存写 best-effort：失败 warn+swallow（subscriptions.ts:80-82）。

## 备注

- 管理面不降级是同一决策 ID 的另一面：index.ts:49-54 显式 503 而非裸 500。
- 残余风险（删缓存操作本身失败于宕机窗口）见 risk.md RD-04。
