---
project: "SingChorus"
type: development-principle
id: principle-global-006
principle_scope: 项目级
description: "昂贵外部调用（渲染/交付/校验）以「内容哈希缓存 + single-flight + 串行队列」防突发放大；降级路径安全不放松（stale 缓存仅存 token 哈希、best-effort 写不阻塞主流程）。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 性能-调用防御
---

# 昂贵外部调用三层防御与降级安全

## 原则详细描述

两处独立实现验证了同一模式的跨模块共性：

- core 的 sing-box 配置校验（60s 级容器任务）：内容哈希缓存（5min）+ single-flight + 串行队列，防一次突发放大成多个容器任务（`packages/core/src/services/validator.ts:23-26,100-137`）。
- cloud 的订阅交付：isolate 级 configsCache(300s) → D1 → `sub_delivery_cache` stale 兜底（24h，仅存 token 哈希 + active 校验 + 写限频 5min/path）（`packages/cloud/src/routes/subscriptions.ts:15-54,42-47,169-176,317-327`）；缓存写一律 best-effort，失败不破坏主流程（`subscriptions.ts:56-83`）。

## 为什么要这样

- 校验/渲染是秒级到分钟级的重量操作，无防御时 N 个并发请求 = N 倍成本（容器任务、D1 配额，后者受 Workers 免费版 50 subrequest 约束，`packages/cloud/src/db/schema.ts:9-12`）。
- 降级是为了可用性，但不能以降级换取安全退化：stale 数据只有经 token 哈希与 active 校验才可交付（`subscriptions.ts:189-192`）。
- 缓存写失败若抛错，会把「优化路径故障」升级为「主路径故障」。

## 适用范围

- 项目级：core 校验/部署链路、cloud 交付面；任何新引入的昂贵调用（>秒级或消耗配额）照此办理。

## 规则

- 昂贵调用入口必须具备：内容/参数哈希缓存、并发去重（single-flight 或队列）、有界重试。
- 降级数据必须经与主路径同强度的鉴权校验后才可返回。
- 缓存写失败只记日志，不得向上抛出。

## 反模式 / 禁止项

- 在降级路径绕过 token 校验「图方便」。
- 缓存写失败导致请求失败。
- 用固定 key 缓存含鉴权上下文的响应（串数据风险）。

## 修改检查清单

- [ ] 新昂贵调用是否有缓存 + 去重 + 预算三件套？
- [ ] 降级读路径是否校验 token/active 状态？
- [ ] 缓存写失败是否被吞掉且留痕？
