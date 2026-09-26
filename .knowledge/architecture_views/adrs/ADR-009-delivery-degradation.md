---
project: "SingChorus"
type: adr
id: ADR-global-009
description: "订阅交付面采用三级降级：isolate 级 configsCache(300s) → D1 → sub_delivery_cache 陈旧兜底(24h, token 哈希+active 校验, 写限频) → 显式 503 DB_UNAVAILABLE；管理面不降级。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "订阅交付面三级降级（CLOUD-A2）"
date: 2026-09-18
code_refs:
  - packages/cloud/src/routes/subscriptions.ts:15-54
  - packages/cloud/src/routes/subscriptions.ts:85-150
  - packages/cloud/src/db/schema.ts:153-161
  - packages/cloud/src/index.ts:45-56
---

# ADR-009: 订阅交付面三级降级

## 状态

accepted（随 KV→D1 迁移落地，commit 7b1ef0e；错误语义 CLOUD-A2 注释于 `src/index.ts:49`）

## 1. 背景

**业务背景**：订阅配置是客户端代理的命脉——交付中断等于全部节点断连；而 cloud 依赖的 D1 存在计划性故障与配额风险。
**技术背景**：KV→D1 迁移后（ADR-001），KV 自带的读高可用消失，需要自建兜底；Workers 免费版 D1 调用计入 50 subrequest 预算（`schema.ts:9-12`）。
**核心问题**：D1 不可用时订阅交付是直接失败，还是用陈旧数据兜底？兜底的安全边界在哪？

**约束条件**：

- 交付路径是外部高频读（客户端轮询），不可全量穿透到 D1
- 兜底数据不能绕过鉴权（token 有效性必须仍受控）
- 管理面（写路径）必须保持强一致，不得读陈旧数据

## 2. 决策驱动因素

1. **交付连续性**（高）：客户端断连是最恶劣故障形态。
2. **降级安全**（高）：stale 数据必须经与主路径同强度的 token/active 校验。
3. **预算保护**（中）：isolate 缓存挡住高频读，降低 D1 调用计数。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|D1 直读，宕机即 503|实现最简、永不陈旧|D1 抖动=全网断连|交付可用性绑定单点|
|Option B|内存缓存一层|读快|重启/多 isolate 即失效，无跨故障域兜底|D1 长时间宕机无保护|
|Option C|三级降级链（采纳）|故障域层层隔离；安全边界明确|缓存一致性管理复杂|多 isolate 陈旧窗口|

### Option C：三级降级链（采纳）

L1 isolate `configsCache` 300s 挡高频读（`subscriptions.ts:15-33`）→ L2 D1 强一致 → L3 `sub_delivery_cache` 24h 陈旧兜底：仅存 token 哈希、active 校验、写限频 5min/path（`subscriptions.ts:36-101,42-47,169-176,317-327`；`schema.ts:153-161` 注释「served stale when D1 reads fail」）→ 仍失败显式 503 `DB_UNAVAILABLE`（`index.ts:45-56`），core 侧据此结构化退避（ADR-003 / principles_003）。缓存写一律 best-effort 不阻塞主流程（principles_006）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：因素 1 要求最外层兜底独立于 D1 故障域；因素 2 由「哈希+active+限频」落实；因素 3 由 L1 承担。管理面明确不降级，保证写路径强一致。

### 4.1 实施要点

- stale 命中也必须过 token 哈希与 active 校验（`subscriptions.ts:189-192`）
- 禁用订阅/更换 token 立即让 stale 缓存失效
- 503 必须结构化（DB_UNAVAILABLE），供 core 与前端区分「云端故障」与「配置为空」

## 备注

- 残余风险：多 isolate 下 L1/写限频各自独立，陈旧窗口不可控 → [../risk.md](../risk.md) RISK-STAB-003 [待确认: 生产 isolate 形态]。
