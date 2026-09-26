---
project: "SingChorus"
type: adr
id: ADR-core-005
description: sing-box 校验采用内容哈希缓存（5min/100 条）+ single-flight + 串行队列三层防御，把并发校验收敛为「同内容共享一次 docker run、全局并行度 1」。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "昂贵校验调用的三层防御（core-P1）"
date: 2026-09-24
code_refs:
  - packages/core/src/services/validator.ts:23-26,100-137
  - packages/core/src/services/validator.ts:139-167

---

# ADR-core-005: 昂贵校验调用的三层防御

## 状态

accepted

## 1. 背景

**业务背景**：配置保存/渲染前用真实 sing-box（docker run check）验证配置正确性，避免坏配置上线。
**技术背景**：单次校验是 30-60s 级容器任务（默认超时 30s，validator.ts:76）；校验由 HTTP 请求驱动，事件循环外可任意并发。
**核心问题**：并发校验请求如何处理——放任并行、全局排队，还是去重后排队？

**约束条件**：

- 宿主机资源有限，多个并行容器会拖垮节点
- 镜像可能是 `:latest`，结果会过期
- 不可因防御引入错误结果（失败也要如实返回）

## 2. 决策驱动因素

1. **资源保护**（高）：并行容器数必须有上限。
2. **重复消除**（中）：同内容不重复跑。
3. **结果新鲜度**（中）：缓存必须过期。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|无防御，每请求一个容器|实现最简|N 并发=N 容器放大|资源耗尽|
|Option B|全局互斥排队|并行度=1|同内容重复排队跑|延迟浪费|
|Option C|缓存+single-flight+串行队列（采纳）|重复消除+并行度 1|三层状态管理复杂|缓存键设计不当漏去重|

### Option C 详述

`validate(config)`：key=sha256(stableStringify(config))（键序无关，:16-21）；命中 5min TTL 缓存即返（:108-110）；in-flight 同 key 共享 Promise（:112-113）；任务入串行队列执行 docker run check（:115-137,139-166）。缓存容量 100、refresh-on-set≈LRU（:115-124）；失败结果同样入缓存但受 TTL 兜底。TTL=5min 取「镜像可能是 :latest，结果不宜缓存过久」（:25 注释）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：资源保护（因素 1）由队列并行度=1 保证，且优于 Option B 的重复执行；重复消除（因素 2）由内容寻址缓存+single-flight 完成；新鲜度（因素 3）由 TTL 兜底。docker 不可用时跳过校验放行并附提示（:140-142），防御不以可用性为代价。

### 4.1 实施要点

- 队列实现 `queue.then(fn, fn)` 吞链上拒绝防断链（:133-137），与 DockerManager opQueue 同型。
- 校验临时文件放 tmpdir/<uuid>，finally 清理（:145-166）。

## 备注

- 缓存键复用了 hash.ts 同型 stableStringify（validator.ts:16-21 内联实现），两处语义须一致。
