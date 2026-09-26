---
project: SingChorus
type: development-principle
id: principle-core-005
description: 秒-分钟级昂贵调用（docker run 校验、容器操作）必须叠加缓存、单飞与串行队列防御，杜绝并发放大。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 工程
---

# 昂贵调用的三层防御

## 原则详细描述

`SingboxValidator.validate` 对同一内容（stableStringify 后 sha256）：命中 5min TTL 缓存直接返回；并发同 key 共享同一 in-flight Promise（single-flight）；所有校验经串行队列，同刻至多一个 `docker run`（validator.ts:23-26,100-137）。缓存容量 100、refresh-on-set ≈ LRU（:115-124）。TTL 取 5min 是因为镜像可能是 `:latest`，结果不宜久缓存（:25 注释）。

## 为什么要这样

一次校验是 30-60s 级容器任务；无防御时事件循环外的并发请求会放大成 N 个并行容器，拖垮节点（core-P1 注释，validator.ts:23-24）。缓存消灭重复内容，single-flight 合并并发，队列封顶并行度=1。

## 适用范围

- validator 校验；任何「单次成本秒级以上」的外部调用（容器操作、镜像拉取、云端渲染的批量场景）。

## 规则

- 缓存 key 必须内容寻址（键序无关 stableStringify，validator.ts:16-21）。
- 失败也进缓存（结果含 errors），但须有 TTL 兜底。
- 新增昂贵调用先回答三层各要不要：缓存（重复度）、single-flight（并发度）、队列（并行上限）。

## 反模式 / 禁止项

- 对每请求直接起容器/子进程。
- 用进程级互斥替代内容去重（同内容不同 key 仍会重复执行）。
- 缓存无 TTL 且镜像可变。

## 修改检查清单

- [ ] 昂贵调用具备内容寻址缓存与并发去重
- [ ] 并行度有显式上限
- [ ] TTL 与外部可变性（如 :latest 镜像）匹配
