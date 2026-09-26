---
project: SingChorus
type: development-principle
id: principle-cloud-003
description: 管理面故障要「响亮失败」——显式 503 DB_UNAVAILABLE 而非裸 500；交付面故障要「陈旧降级」——stale 缓存兜底、缓存写绝不破坏成功交付。两类平面失败策略不同且都显式声明。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 交付面降级、管理面不降级

## 原则详细描述

同一 D1 依赖在两种平面上采取相反的失败策略（决策 CLOUD-A2）：

- 管理面（admin CRUD/渲染）：D1 冷启动故障直接返回 `503 {error:{code:'DB_UNAVAILABLE'}}`（index.ts:49-54），镜像 KV_UNAVAILABLE 契约——core 已按 5xx 退避重试（cloud-client.ts:206-214），裸 500 会被误判为 bug。
- 交付面（GET /s/:path）：订阅行/实例/模板三类 D1 读失败均先走 `serveStaleDelivery`（subscriptions.ts:169-176,235-240,307-315），无可用缓存才 503。stale 命中条件：条目存在 + active=1 + SHA-256 token 哈希匹配（subscriptions.ts:85-101）。

## 为什么要这样

- 终端订阅消费端（sing-box 客户端轮询）要的是可用性：D1 短暂故障期间「稍旧的配置」远好于「拉取失败」，客户端断网兜底成本极高。
- 管理员要的是确定性：降级的管理面会掩盖数据不一致，宁可显式失败。
- stale 路径只存 token 哈希（subscriptions.ts:42-45）——token 轮换后 stale 自然拒绝，停用的订阅在 403 路径还会主动删缓存（subscriptions.ts:188-195），防止降级路径外泄已停用配置。

## 适用范围

- routes/subscriptions.ts 交付链路；未来任何面向终端用户的只读端点。

## 规则

- 交付链路的每一段 D1 读（订阅行 / 实例 / 模板加载）必须独立 catch 并接 stale 兜底——不能只包一个总 try/catch。
- 缓存写入 best-effort：失败 log+swallow，绝不阻塞成功交付（subscriptions.ts:56-58 注释）。
- stale 响应必须带 `X-Subscription-Cache: stale` 头（subscriptions.ts:96），可观测。
- 管理面禁止引入数据降级；失败即显式错误码。

## 反模式 / 禁止项

- 把 stale 逻辑抽成「全局中间件」套到管理面上。
- 为让 stale 更新鲜而同步等待缓存写完成。
- 管理面 catch 后返回空数据/假成功。

## 修改检查清单

- [ ] 新增交付子步骤的 D1 失败是否接入了 serveStaleDelivery？
- [ ] stale 命中校验（active + token 哈希）是否仍然完整？
- [ ] 管理面是否被误加降级？
