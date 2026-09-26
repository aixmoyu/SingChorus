---
project: SingChorus
type: development-principle
id: principle-cloud-002
description: D1 调用计入 Workers 50 subrequest 预算——所有热路径读必须 memoize/TTL 化，所有写路径必须主动失效缓存；这是从真实 500 事故中提炼的硬规则。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 昂贵调用 Memoize + 写路径主动失效

## 原则详细描述

D1 属于昂贵调用：免费版每请求 50 subrequest 预算。历史事故是 DDL 幂等语句每请求重跑，挤爆预算后表现为重型路由随机 500（db/schema.ts:4-9 注释）。对策是全模块统一的三层记忆化 + 写后失效：

| 缓存 | 层级 | TTL | 写路径失效 |
|-|-|-|-|
| initPromise（DDL+种子） | isolate | 永久，失败清空重试 | resetDatabaseInitCache（测试） |
| 模板定义 + 惰性 JSON 解析 | isolate 模块级（跨实例共享） | 30s | invalidateTemplateCache（registry.ts:140-144） |
| 交付用 client_configs | isolate 模块级 | 300s | 与 panel 5min 同步节奏对齐，不主动失效 |
| sub_delivery_cache | D1 表（跨 isolate） | 24h stale 上限 | 订阅变更/停用/删除时 DELETE；写节流 5min/path（subscriptions.ts:47-64） |

## 为什么要这样

- 每请求 `new PluginRegistry` 是廉价的，`SELECT * FROM templates` 才是贵的——所以缓存做在模块级而非实例级（registry.ts:118-124 注释）。
- 只加 TTL 不加写失效会把管理员改模板的生效时间拖满 30s；写路径主动失效（protocols.ts:73,111,142、templates.ts:147,193,222、protocol-instances.ts:178）让 CUD 即时可见，TTL 只兜底多 isolate 场景。
- 缓存写入必须节流且尽力而为：交付缓存 ≤1 写/5min/path/isolate、失败吞错（subscriptions.ts:56-83），否则轮询消费端会把缓存写放大成新的预算问题。

## 适用范围

- 所有新增 D1 热路径读；所有会改变渲染结果的写路径。

## 规则

- 热路径读必须有缓存策略（memo/TTL 二选一）并在注释写明预算依据。
- 改变缓存内容的写路径必须调用对应 invalidate 函数。
- 缓存写失败不得影响主流程成功响应。
- 为测试保留 reset 钩子（vitest-pool-workers 模块状态跨测试存续，registry.ts:129-135）。

## 反模式 / 禁止项

- 在请求处理函数内无条件重跑幂等 DDL/全表查询。
- 只加缓存不写失效（管理员改模板 30s 不生效类 bug）。
- 缓存 key 遗漏语义维度（v1 隐性 bug：不同 version 共享同一交付缓存行，subscriptions.ts:508-510 注释）。

## 修改检查清单

- [ ] 新增 D1 读是否落入了某层缓存？预算依据注释了吗？
- [ ] 相关写路径是否触发失效？
- [ ] 缓存 key 是否覆盖全部影响渲染结果的维度？
- [ ] 测试 reset 钩子是否需要同步新增？
